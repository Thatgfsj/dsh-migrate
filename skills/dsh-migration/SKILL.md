---
name: dsh-migration
description: 把一台电脑上的 DeepSeek Harness（DSH）整体搬到另一台电脑：打包大肥鱼（导出）与释放大肥鱼（导入）。覆盖"插件目录全量 + 插件配置 + 上下文"的打包范围、硬排除 API key 与会话数据、manifest/sha256 校验、绝对路径重写、平台绑定项、失败回滚，以及宿主工具 fatfish_pack / fatfish_release 与独立 restore.mjs 的用法。当用户说「打包大肥鱼」「释放大肥鱼」「把这台 DSH 搬到另一台电脑」「迁移 harness」「备份整个 DSH 环境」，或需要排查归档校验失败、释放后插件不生效、跨平台二进制不兼容时使用。
whenToUse: 用户想导出/导入整套 DSH 环境，或搬运到新电脑、或在释放后遇到校验/路径/插件加载问题时。
---

# 搬运 DSH（打包大肥鱼 / 释放大肥鱼）

## 心智模型

一次搬运 = **一个 zip**，且这个 zip 是自描述的：

- 源机器：`dsh plugin add` 本插件 → 点【打包大肥鱼】→ 选保存位置 → 得到 `dsh-fatfish-<主机>-<时间>.zip`
  - 也可以用宿主工具 `fatfish_pack`，或直接调 `pack()`
- 目标机器：装 Node → 装 DSH → 装本插件 → 点【释放大肥鱼】→ 选 zip → 等进度走完 → 重启 DSH
  - 还没有插件时：解压 zip，`node dsh-migrate-tools/restore.mjs --yes`

归档里有什么：`manifest.json`（逐文件 sha256、来源机器、平台绑定项）、按 DSH home 原样铺开的 payload、以及 `dsh-migrate-tools/`（独立恢复工具 + 本插件副本，用于自举）。

## 打包范围（判据）

| 类型 | 处理 |
|---|---|
| `plugins/**`（含插件内的资源、node_modules、视频） | **整树全带**，不做"文件太大就不带"这类判断 |
| `profiles/*` 的 `package.json` / `cordis.patch.yml` / `pnpm-workspace.yaml` / `pnpm-lock.yaml` / `node_modules/` | 全带；`cordis.yml`（启动时被重写）与 `.plugin-manager/logs` 除外 |
| `skills/**`、home 顶层上下文（`AGENTS.md`、插件留下的 `*.json` 等） | 全带 |
| 凭据（`.credentials*`，任意深度） | **永不打包**，且归档写出后再扫一遍内容 |
| 会话数据（`sessions`、`attachments`、会话类 `storages`、`logs`） | 不带；`storages/workspace.json` 例外（是配置） |
| 模型缓存（`speech-to-text`） | 默认不带，`includeModels` 开关 |

清单是**发现式**的：不写死 profile 名、路径、体积；所有数字都是打包时实测写入 manifest。

## 需要什么读哪个文件

| 需要 | 读 |
|---|---|
| 打包/释放的完整流程、参数、报告字段 | [references/workflow.md](references/workflow.md) |
| 校验失败、释放后插件不生效、跨平台、体积异常 | [references/troubleshooting.md](references/troubleshooting.md) |
| 哪些层必须重装、哪些能直接搬 | [references/layers.md](references/layers.md) |

## 铁律

1. **先校验后写盘**：释放前必须过 `verifyArchive()`（结构 + manifest schema + payload 双向一致 + sha256），任何一项不过就中止，一个字节都不写。
2. **绝不静默合并**：目标 home 已存在时先整体改名备份为 `<home>.bak-<时间>`；要叠加必须显式 `merge`。
3. **凭据零容忍**：打包前逐文件扫密钥、命中即中止；写出后再扫归档路径。报告里只出现打码值。
4. **删除/覆盖要留后路**：释放失败自动回滚到备份。
5. **平台绑定项要报告不要猜**：linux-only 的二进制在 Windows 上会被跳过，并写进报告与 manifest。
