# 哪层必须重装 / 哪些能直接搬

| 层 | 内容 | 策略 |
|---|---|---|
| L0 运行时 | `@deepseek-ai/dsh` 全局安装（约 500 MB，含 `sharp`/`koffi`/`sherpa-onnx-*`/`rg` 等**平台绑定二进制**） | **不进 zip**；manifest 记录 `source.dsh`，目标机 `npm i -g @deepseek-ai/dsh@<版本>` |
| L1 上下文 | `AGENTS.md`、home 级 patch、各插件留下的配置 json | 直接搬 |
| L2 技能 | `skills/**` | 直接搬 |
| L3 profile | 配置 + `node_modules`（hoisted 实体文件） + `pnpm-lock` | 直接搬；绝对 `file:` 依赖会被重写 |
| L4 插件 | `plugins/**` 整树 + 各 profile 下已安装的插件副本 | 直接搬 |
| L5 平台绑定 | 名字带平台标识的包、ELF/PE/Mach-O、`*.node/*.so/*.dll/*.exe` | 同平台可用；跨平台**跳过并提示重建** |
| L6 数据 | `sessions` / `attachments` / 会话类 `storages` / `logs` | 不带（用户要求） |
| L7 凭据 | `.credentials*` 与任何 API key | 永不打包 |

体积估算按**实占**算：pnpm 的 hoisted `node_modules` 表观可能只有几十 MB，但硬链解引用后可能是其数倍。

Node/pnpm 版本：manifest 会记录 `source.node` / `source.pnpm` / `source.dsh`，目标机主版本不同时释放报告会给 warning。
