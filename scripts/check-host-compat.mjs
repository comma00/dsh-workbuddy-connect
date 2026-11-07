#!/usr/bin/env node
/**
 * Check this package's DSH host surface against an installed DSH.
 *
 * The service peers in `package.json` are exact pins on one verified core, on
 * purpose: a caret silently admits rc lines nobody ran (see #69/#74/#92 and the
 * docblock in `tests/version.spec.ts`). The cost of that policy is that every
 * DSH bump turns into a manual audit — which core is running, which entries
 * move, and whether the modules this package imports still export what it uses.
 *
 * This script performs the audit so the policy stays affordable:
 *
 *   pnpm run check:host                 # audit against the auto-detected host
 *   pnpm run check:host --host <dir>    # audit against a specific DSH package
 *   pnpm run check:host --write         # move the pins after a clean audit
 *
 * Exit codes: 0 clean, 1 mismatch, 2 the host could not be inspected.
 *
 * The audit is static (it imports the host libraries but never mounts a
 * Cordis context), so it cannot replace a real run on the new core.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_JSON = join(PACKAGE_DIR, 'package.json')
const VERSION_SPEC = join(PACKAGE_DIR, 'tests', 'version.spec.ts')

/**
 * The named exports this package imports from each host module at runtime.
 *
 * Kept here rather than derived from the sources because the audit must state
 * the contract it checks; a source-side rename should make this fail, not
 * silently follow along. `lib/index.js` is the shipped truth — the entries
 * below mirror it.
 */
const RUNTIME_SURFACE = {
  '@deepseek-ai/dsh-llm': ['resolveImageAttachmentAccess', 'resolveRetryPolicy'],
  '@deepseek-ai/dsh-home-paths': ['resolveDshHome'],
  '@deepseek-ai/dsh-llm-pi-ai': ['PiAiAdapter'],
  // `cordis` is here because dsh-settings reaches into the fiber through it:
  // 0.2.2-rc.1's `describe()` reads `fiber.effectiveConfig`, which cordis 4.0.5
  // does not define, so a 4.0.x host silently reports `undefined` values.
  '@deepseek-ai/cordis': ['Context'],
}

/** Parse the two flags the audit understands. */
function parseArgs(argv) {
  const options = { host: undefined, write: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--write') options.write = true
    else if (arg === '--host') options.host = argv[++index]
    else if (arg.startsWith('--host=')) options.host = arg.slice('--host='.length)
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/**
 * Locate the DSH installation to audit against.
 *
 * A `link:`-installed plugin sits outside any tree that contains DSH, so the
 * upward module walk finds nothing. The launcher's own node binary is the
 * reliable anchor: `dsh` is installed beside it.
 */
function detectHost(explicit) {
  if (explicit !== undefined) return resolve(explicit)
  if (process.env.DSH_INSTALL_DIR !== undefined) return resolve(process.env.DSH_INSTALL_DIR)
  const beside = join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh')
  if (existsSync(join(beside, 'package.json'))) return beside
  throw new Error(
    'cannot locate a DSH installation; pass --host <path to the @deepseek-ai/dsh package> '
    + 'or set DSH_INSTALL_DIR',
  )
}

/** Read a package manifest, or undefined when it is not installed. */
function manifestAt(directory) {
  const filename = join(directory, 'package.json')
  if (!existsSync(filename)) return undefined
  return JSON.parse(readFileSync(filename, 'utf8'))
}

/** The host's own copy of one `@deepseek-ai/*` package. */
function hostCopyOf(hostDir, name) {
  const short = name.startsWith('@deepseek-ai/') ? name.slice('@deepseek-ai/'.length) : name
  return join(hostDir, 'node_modules', '@deepseek-ai', short)
}

/**
 * Compare the pinned peers with the cores the host actually ships.
 *
 * Every `@deepseek-ai/*` peer is audited, not only `dsh-*`: `cordis` is a core
 * in the same sense (dsh-settings 0.2.2-rc.1 requires `~4.1.0`, and its
 * `describe()` reads `fiber.effectiveConfig` — a property cordis 4.0.5 does
 * not have at all), and an earlier `dsh-`-only filter let exactly that drift
 * through while reporting a clean audit.
 *
 * Exact pins must equal the host's version. A declared range must actually
 * admit it, so `cordis: ^4.1.0` is verified against 4.1.0 rather than being
 * skipped. `react` is excluded: an ordinary library, careted on purpose.
 */
const EXCLUDED_FROM_PIN_AUDIT = new Set(['react'])

function isExactPin(declared) {
  return !/[\^~><=*x]|\s-\s|\|\||\s/.test(declared)
}

function auditPins(manifest, hostDir, satisfies) {
  const rows = []
  for (const [name, pinned] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (EXCLUDED_FROM_PIN_AUDIT.has(name)) continue
    const installed = manifestAt(hostCopyOf(hostDir, name))?.version
    const exact = isExactPin(pinned)
    let ok
    if (installed === undefined) ok = false
    else if (exact) ok = installed === pinned
    else if (satisfies === undefined) ok = undefined
    else ok = satisfies(installed, pinned)
    // `ok: undefined` means the range could not be evaluated here (no semver
    // resolvable from the host). Reporting that as a mismatch would be a false
    // alarm that sends someone to "fix" a version that is in fact fine.
    rows.push({ name, pinned, installed, exact, ok })
  }
  return rows
}

/**
 * Import each runtime module from the host and confirm the named exports exist.
 *
 * An import that throws is reported as unverified rather than failed: a host
 * library can legitimately refuse to load outside its runtime, and calling that
 * an incompatibility would be a false alarm. A module that loads but lacks a
 * name this package calls is a genuine break.
 */
async function auditSurface(hostDir) {
  const rows = []
  for (const [name, names] of Object.entries(RUNTIME_SURFACE)) {
    const directory = hostCopyOf(hostDir, name)
    const manifest = manifestAt(directory)
    if (manifest === undefined) {
      rows.push({ name, names, state: 'missing' })
      continue
    }
    const entry = manifest.exports?.['.']
    const relative = typeof entry === 'string'
      ? entry
      : entry?.default ?? entry?.import ?? manifest.main ?? 'lib/index.js'
    try {
      const loaded = await import(pathToFileURL(join(directory, relative)).href)
      const absent = names.filter(candidate => !(candidate in loaded))
      rows.push({ name, names, state: absent.length === 0 ? 'ok' : 'absent', absent })
    } catch (error) {
      rows.push({ name, names, state: 'unverified', reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return rows
}

/**
 * Move the exact pins, and the assertion that encodes them, to one version.
 *
 * Both files are read and transformed before either is written, so a spec file
 * the pattern no longer recognises cannot leave the manifest half-migrated.
 * The match is tested with `test` rather than by comparing the rewritten string:
 * re-running against an already-migrated tree must be a no-op, not a failure.
 */
function writeVersion(version, pins) {
  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  for (const { name } of pins) manifest.peerDependencies[name] = version
  const nextManifest = `${JSON.stringify(manifest, null, 2)}\n`

  const pattern = /(expect\(pkg\.peerDependencies\[name\], `\$\{name\} missing from peerDependencies`\)\.toBe\(')[^']+('\))/
  const source = readFileSync(VERSION_SPEC, 'utf8')
  if (!pattern.test(source)) throw new Error('could not locate the peer expectation in tests/version.spec.ts')
  const nextSpec = source.replace(pattern, `$1${version}$2`)

  writeFileSync(PACKAGE_JSON, nextManifest)
  writeFileSync(VERSION_SPEC, nextSpec)
}

/**
 * Resolve the host's own semver, or undefined when it has none.
 *
 * Resolving semver from the host rather than from here is deliberate: the host
 * evaluates ranges with `{ includePrerelease: true }`, and a local copy without
 * that flag answers a different question — `>=0.2.0-rc.1 <0.3.0` does NOT admit
 * `0.2.2-rc.1` under default semantics, but does under the host's.
 */
function hostSatisfies(hostDir) {
  let semver
  try {
    semver = createRequire(join(hostDir, 'package.json'))('semver')
  } catch {
    return undefined
  }
  return (version, range) => semver.satisfies(version, range, { includePrerelease: true })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log('usage: check-host-compat.mjs [--host <dsh package dir>] [--write]')
    return 0
  }

  const hostDir = detectHost(options.host)
  const hostVersion = manifestAt(hostDir)?.version
  if (hostVersion === undefined) throw new Error(`${hostDir} has no readable package.json`)

  const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
  const pins = auditPins(manifest, hostDir, hostSatisfies(hostDir))
  const surface = await auditSurface(hostDir)

  console.log(`host   ${hostDir}`)
  console.log(`core   dsh ${hostVersion}`)
  console.log(`plugin ${manifest.name}@${manifest.version}`)
  console.log('')

  console.log('pins')
  for (const { name, pinned, installed, exact, ok } of pins) {
    const label = ok === true ? 'ok  ' : ok === false ? 'MISMATCH' : 'unverified'
    console.log(`  ${label}  ${name.padEnd(34)} ${String(installed ?? '(absent)').padEnd(12)} declared ${pinned}${exact ? '' : ' (range)'}`)
  }

  console.log('')
  console.log('runtime surface')
  for (const row of surface) {
    if (row.state === 'ok') console.log(`  ok      ${row.name.padEnd(34)} ${row.names.join(', ')}`)
    else if (row.state === 'absent') console.log(`  ABSENT  ${row.name.padEnd(34)} missing ${row.absent.join(', ')}`)
    else if (row.state === 'missing') console.log(`  MISSING ${row.name.padEnd(34)} not installed in the host`)
    else console.log(`  unverified  ${row.name.padEnd(30)} ${row.reason}`)
  }

  const mismatched = pins.filter(row => row.ok === false)
  const pinUnverified = pins.filter(row => row.ok === undefined)
  const broken = surface.filter(row => row.state === 'absent' || row.state === 'missing')
  const unverified = surface.filter(row => row.state === 'unverified')

  console.log('')
  if (broken.length > 0) {
    console.error('this package calls host exports the core no longer provides; it cannot run on this core.')
    return 1
  }
  if (pinUnverified.length > 0) {
    // A range that could not be evaluated is not a pass: silence here is how a
    // real gap hides, so it is reported and the run stays non-clean.
    console.error(`${pinUnverified.length} pin(s) could not be verified here: `
      + pinUnverified.map(row => `${row.name} (declared ${row.pinned})`).join(', '))
    console.error('  no semver was resolvable from the host; confirm against a real DSH installation.')
    return 2
  }
  if (mismatched.length === 0) {
    if (unverified.length > 0) console.log('pins match. Some modules could not be loaded here — confirm with a real run.')
    else console.log('pins match and every imported export is present.')
    return 0
  }
  if (options.write === true) {
    // Only exact pins may be moved: rewriting a deliberate range (e.g.
    // `cordis: ^4.1.0`) to one version would silently narrow it.
    const movable = mismatched.filter(row => row.exact)
    const ranged = mismatched.filter(row => !row.exact)
    if (movable.length > 0) writeVersion(hostVersion, movable)
    if (ranged.length > 0) {
      console.error(`${ranged.length} ranged pin(s) do not admit the core and were left alone: `
        + ranged.map(row => `${row.name} (declared ${row.pinned}, host ${row.installed})`).join(', '))
      console.error('  widen or move these by hand; a range is a deliberate decision.')
    }
    if (movable.length > 0) console.log(`moved ${movable.length} pin(s) and the test expectation to ${hostVersion}; re-run the suite.`)
    return ranged.length > 0 ? 1 : 0
  }
  console.error(`${mismatched.length} pin(s) do not match the running core.`)
  console.error(`  review the surface above, then re-run with --write to move the pins to ${hostVersion}.`)
  return 1
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error(`check:host ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}
