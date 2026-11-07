# 变更记录

上游 `github.com/corrinehu/dsh-workbuddy-connect` 已不可访问（返回 404），
npm 上最后一个版本是 `0.7.9`（2026-10-19）。本仓库从该版本接手维护。

记录相对上游 `0.7.9` 的改动。

---

## [Unreleased]

当前工作树相对 `0.7.9` 的改动，尚未提升版本号。

### 修复

- **适配 DSH 0.2.2-rc.1**（`package.json`、`tests/version.spec.ts`）
  七个服务 peer 钉的是 `0.2.1-rc.2`，DSH 升到 `0.2.2-rc.1` 后整份插件被跳过：

  ```
  Plugin dsh-workbuddy-connect@0.7.9 is incompatible with dsh 0.2.2-rc.1
    requirements {"@deepseek-ai/dsh-llm":"0.2.1-rc.2", ...}
  ```

  **钉子本身没有改成范围** —— 那会推翻 #69/#74/#92 定下的策略：caret 会静默放行
  同元组里没人跑过的 rc，支持范围应当由一次真实核对后的清单决定，而不是由 semver
  自动延伸。这里做的是把清单移到**已核对过的那一版**，即 `0.2.2-rc.1`。

  移动前核对的内容：本包真正 import 的宿主模块在该内核上导出齐全。

  | 模块 | 用到 |
  |---|---|
  | `@deepseek-ai/dsh-llm` | `resolveImageAttachmentAccess`、`resolveRetryPolicy` |
  | `@deepseek-ai/dsh-home-paths` | `resolveDshHome` |
  | `@deepseek-ai/dsh-llm-pi-ai` | `PiAiAdapter` |

  核对范围限于模块导出与本地测试；**没有**做桌面端验收，这一点与上游 docblock
  的提醒一致。

  未采用 `engines.dsh` 声明：DSH 会先判它、命中后不再看 peer，那样这份精确钉子
  就再也不会起作用，与上述策略冲突。peer 钉子仍是唯一的闸门 —— DSH 每次升级都会
  明确报错并要求重新核对，而不是悄悄跑在没验证过的内核上。

- **`cordis` 也要跟着内核走**（`package.json`）
  上面那轮只搬了 `@deepseek-ai/dsh-*`，漏掉了 `cordis` 本身 —— 而它同样是被
  内核约束的：`dsh-settings@0.2.2-rc.1` 要求 `cordis ~4.1.0`，并且它的
  `describe()` 改为从 `fiber.effectiveConfig` 取值。该属性在 `cordis 4.0.5` 上
  **根本不存在**，于是 4.0.x 宿主上 `describe()` 静默返回 `undefined`。

  本包声明的 `^4.0.5` 会解析到 `4.0.5`，比宿主实际加载的 `4.1.0` 旧一档。
  两边都改为 `^4.1.0`。

  这不是纸面问题：节省上下文窗口的开关在写入后会回读 `describe()` 校验，
  在 4.0.5 下读回 `undefined` 会被正确地判为「写入未生效」，开关就永远失败。
  本地测试抓到了这一点（`tests/settings-integration.spec.ts` 的 3 个延迟绑定用例）。

  测试夹具也一并修正：它原先只改写 `fiber.config`，而 `describe()` 现在读的是
  `fiber.effectiveConfig`，需要建模真实编辑器写入后发布的那一步。

- **`check:host` 不再只看 `dsh-*`**（`scripts/check-host-compat.mjs`）
  核对脚本原先按 `@deepseek-ai/dsh-` 前缀过滤 peer，`cordis` 因此从未被比对过，
  上面那个断裂在「核对通过」的假象下藏了很久。

  现在核对**所有** `@deepseek-ai/*` peer：精确钉子必须与宿主版本相等；声明为
  范围的（如 `cordis: ^4.1.0`）则用宿主自己的 semver 实际判定是否覆盖宿主版本。
  范围无法判定时记为 `unverified` 并以退出码 `2` 结束 —— 沉默通过正是问题藏身之处。
  `--write` 只搬精确钉子，绝不把有意写成的范围收窄成单一版本。

  新增两条回归测试锁住这个覆盖面（`tests/version.spec.ts`）。

- **仓库地址指向本仓库**（`package.json`、`README.md`）
  `repository` / `homepage` / `bugs` 与安装说明里的项目地址原先都指向已消失的
  `corrinehu` 仓库。`author` 保留原署名，README 里历史版本的 issue / releases
  链接保持原样，它们记录的是上游历史。

### 工具

- **`pnpm run check:host`：把兼容性核对做成一条命令**（`scripts/check-host-compat.mjs`）
  精确钉版策略的代价是每次 DSH 升级都要人工核一遍：跑的是哪个内核、清单该搬到哪里、
  本包 import 的那些模块是否还导出原来的名字。脚本把这一步固化：

  ```powershell
  pnpm run check:host              # 对着自动探测到的宿主核对
  pnpm run check:host --host <dir> # 指定 DSH 包目录
  pnpm run check:host --write      # 核对通过语义下，把清单搬到当前内核
  ```

  退出码：`0` 一致，`1` 版本错位或导出缺失，`2` 宿主无法检查。

  它报告两件事：所有 `@deepseek-ai/*` peer 的声明与宿主实际版本是否相符；本包真正
  调用的模块（`dsh-llm`、`dsh-home-paths`、`dsh-llm-pi-ai`、`cordis`）的具名导出
  是否仍然存在。

  两个设计取舍写在脚本注释里：宿主模块 import 失败记为 `unverified` 而不是失败
  （宿主库在运行时之外可能拒绝加载，误报会掩盖真问题）；具名导出缺失才算真断裂。

  已接进 `pnpm run check` 的前置检查。

  这是静态核对——它 import 宿主库，但不挂载 Cordis 上下文，因此**不能替代**在
  新内核上真正跑一次。

### 构建

- **`lib/` 需要重建**
  `src/adapter.ts` 有实质改动：`dsh-llm-pi-ai@0.2.2-rc.1` 把 `maxRequestImages` 与
  `imageOffloadCountQuantum` 加为 `ResolvedPiAiProviderProfile` 的必填字段，而本包是
  手工装配该 profile（该包的 `resolveProfiles()` 不在公开导出面上），必须显式补上，
  否则新内核上图片请求的计数上限无从取值。

  值得注意的是：用 pnpm 装到的 tsdown 重建会顺带改变 `version-resolve` 的产物 hash，
  那是工具链差异而非源码差异。本次因为 `src/` 确实改了，重建是**必要**的，hash 变化
  一并接受。

---

## [0.7.9]

上游最后一个发布版本（2026-10-19）。

- `61f5e16` Merge pull request #189 from matt-xb/fix/probe-429-backoff
- `ff3714f` fix(probe): hold the sweep to its budget by wall clock, not by sleep time
