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

- **仓库地址指向本仓库**（`package.json`、`README.md`）
  `repository` / `homepage` / `bugs` 与安装说明里的项目地址原先都指向已消失的
  `corrinehu` 仓库。`author` 保留原署名，README 里历史版本的 issue / releases
  链接保持原样，它们记录的是上游历史。

### 构建

- **`lib/` 未重建**
  本次只改清单、文档与测试，未触及 `src/`。用 pnpm 装到的 tsdown 重建会改变
  `version-resolve` 的产物 hash，那是工具链差异而非源码差异，因此保留已发布的
  `lib/` 原样。

---

## [0.7.9]

上游最后一个发布版本（2026-10-19）。

- `61f5e16` Merge pull request #189 from matt-xb/fix/probe-429-backoff
- `ff3714f` fix(probe): hold the sweep to its budget by wall clock, not by sleep time
