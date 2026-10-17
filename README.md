# dsh-migrate · 大肥鱼搬运工

[![ci](https://github.com/Thatgfsj/dsh-migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/Thatgfsj/dsh-migrate/actions/workflows/ci.yml)
[![release](https://github.com/Thatgfsj/dsh-migrate/actions/workflows/release.yml/badge.svg)](https://github.com/Thatgfsj/dsh-migrate/actions/workflows/release.yml)
![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-blue)
![platform](https://img.shields.io/badge/platform-linux%20%7C%20windows%20%7C%20macos-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

把一台电脑上的 **DeepSeek Harness（DSH）** 整体搬到另一台电脑：**所有插件、插件配置、技能、上下文**装进**一个 zip**。

两个功能，就是两个按钮（也可以直接对 agent 说）：

| 功能 | 做什么 |
|---|---|
| **打包大肥鱼** | 扫描本机 DSH home → 弹原生对话框选保存位置 → 出一个自描述的 zip |
| **释放大肥鱼** | 校验 sha256 → 备份现有 home → 还原并重写绝对路径 → 跳过跨平台二进制 → 把插件自举装进 profile |

## 使用流程

```text
设备 1（旧机）
  1. 装 DSH，然后安装本插件（见下）
  2. 打开 DSH Web UI，点【打包大肥鱼】；或对 agent 说「打包大肥鱼」
  3. 在弹出的系统对话框里选保存位置 → 得到 dsh-fatfish-<主机名>-<时间>.zip
  4. 把这个 zip 拷到新电脑（U 盘 / 网盘 / 微信都行）

设备 2（新机）
  5. 装 Node（22.19+ 或 24+）
  6. npm i -g @deepseek-ai/dsh@<zip 里 manifest.json 的 source.dsh 版本>
  7. 安装本插件
  8. 点【释放大肥鱼】→ 选那个 zip → 等进度走完
  9. 重启 DSH：环境就是搬过来的那一套
```

zip 是**自包含**的：里面带 `dsh-migrate-tools/`（独立恢复脚本 + 本插件副本）。即使新机还没装插件，解压后执行
`node dsh-migrate-tools/restore.mjs --yes` 也能完成搬运。

## 安装

**方式一：交付 zip**

从 [Releases](https://github.com/Thatgfsj/dsh-migrate/releases) 下载 `dsh-migrate-<版本>.zip`，解压后：

```sh
sh install.sh web            # Linux / macOS；profile 名默认 web
install.cmd web              # Windows
```

**方式二：本地目录（开发用）**

```sh
dsh plugin --profile web add /path/to/dsh-migrate
```

**方式三：本地 tarball**（Release 里的 `dsh-migrate-<版本>.tgz`）

```sh
dsh plugin --profile web add ./dsh-migrate-0.1.1.tgz
```

装完重启 DSH。两个按钮在 **设置 → 插件 → 「大肥鱼搬运」页签** 里（搬运是偶发操作，不占输入框下方）；模型侧会多出 `fatfish_pack` / `fatfish_release` 两个工具，以及随插件分发的 `dsh-migration` 技能。

### 安装 / 更新 / 卸载：请走这三条路

| 目的 | 怎么做 |
|---|---|
| 安装 | `dsh plugin --profile <p> add <本地目录>`，或在 **设置 → 插件 → 添加插件** 里填**本地目录 / 本地 tgz 路径** |
| 更新 | 再执行一次同样的 `add <本地目录>`（`link:` 安装会自动指向新代码；tarball 安装请换成新 tgz） |
| 卸载 | `dsh plugin --profile <p> remove dsh-migrate` |

⚠️ **不要**在「添加插件」里填本仓库的 GitHub 地址。本插件没有发布到 npm，git 源安装会让 pnpm 拉远端源码、要求审批它携带的技能（`Agent skills awaiting approval`），并且**会顶掉你原来的本地安装**，之后行为就不再由本机代码决定了。

⚠️ 插件页那一行的**开关是"启用/停用"，不是安装开关**。手滑停用后插件不会加载，页签/工具/技能都会消失；恢复办法是删掉 profile 的 `cordis.patch.yml` 里这两行：

```yaml
- id: dsh-migrate
  disabled: true
```

（也可以直接说「把 dsh-migrate 的 disabled 覆盖删掉」，装了本插件时 agent 的技能里有这一步。）

## 打包范围

**凡是在插件目录里的东西，一律打包**——不做"这个文件太大就不带"这类本机特判。清单是发现式的，体积、条目数、平台绑定项都在打包时实测写进 `manifest.json`。

| 层 | 内容 | 处理 |
|---|---|---|
| 上下文 | `$DSH_HOME` 顶层文件（`AGENTS.md`、home 级 `cordis.patch.yml`、各插件留下的 `*.json`…） | 全带 |
| 技能 | `$DSH_HOME/skills/**`（以及存在时的 `~/.agents/skills`、项目级 `.dsh/skills`） | 全带 |
| profile | `profiles/*` 的配置 + `node_modules/` + `pnpm-lock.yaml` | 全带；`cordis.yml`（启动会被重写）与 `.plugin-manager/logs` 除外 |
| 插件 | `$DSH_HOME/plugins/**` 整棵树（含资源文件、插件自带 `node_modules`、软链目标） | 全带，软链解引用成实体 |
| 插件产物 | `$DSH_HOME/artifacts/**` 等 | 全带，平台标识写进 manifest |
| 工作区源码 | 插件源码仓库 | 默认**不带**（将来做成开关） |
| **凭据** | `.credentials*`、任何 API key | **永不打包**（任意深度），且归档写出后再扫一遍内容 |
| **会话数据** | `sessions` / `attachments` / 会话类 `storages` / `logs` | 不带 |
| 模型缓存 | `speech-to-text/**`（可重新下载） | 默认不带（`includeModels` 开关） |

> 安全承诺：打包过程中一旦扫到 key 形状的字符串（`sk-`、`ghp_`、`AKIA`、PEM 私钥、赋值式密钥…），**立即中止**，报告里只出现打码值。

## 哪层必须重装

| 层 | 能否直接搬 | 说明 |
|---|---|---|
| DSH 运行时（全局 `@deepseek-ai/dsh`，约 500 MB） | ❌ | 含 `sharp`/`koffi`/`sherpa-onnx-*`/`rg` 等**平台绑定二进制**；manifest 记录精确版本，新机 `npm i -g` |
| Node / pnpm | ❌ | manifest 记录版本，版本漂移会在释放报告里给 warning |
| 配置 / 技能 / profile 清单 / 插件源码 | ✅ | 直接还原；绝对 `file:` 依赖会被重写到新 home |
| profile 的 `node_modules` | ✅ | hoisted 实体文件，直接还原 |
| 平台绑定产物（`*-linux-x64.tgz`、ELF/PE/Mach-O、`*.node/*.so/*.dll/*.exe`） | ⚠️ | 同平台可用；跨平台**跳过并报告**，需要在新机重建 |
| 会话数据 / 凭据 | ❌ | 按设计不带 |

## 平台

Linux / Windows / macOS 三平台都在 CI 里跑（矩阵 `ubuntu-latest`、`windows-latest`、`macos-latest` × node 24，另加 node 22）。跨平台细节：Windows 长路径与反斜杠、macOS 的 `__MACOSX`/`ditto`、Linux 无 zenity/kdialog 时的兜底，都在代码与用例里覆盖。

**人工验收清单**（需要真机 + 浏览器）见 [docs/acceptance.md](docs/acceptance.md)。

## 排障

| 现象 | 处理 |
|---|---|
| 打包中止且提示发现密钥 | 按报告里的路径/行号清理后重打；不要为了绕过去改判据 |
| `sha256 不一致` | zip 传输损坏，重新拷贝；`unzip -t` 验证 |
| 释放后插件不生效 | 报告里会给出 `dsh plugin --profile <p> add <home>/plugins/dsh-migrate`；自举失败不影响释放本身 |
| 报告里 `skipped` 非空 | 跨平台二进制被跳过，属预期；在新机重装对应插件即可 |
| 想退回旧环境 | 释放时默认整体备份为 `<home>.bak-<时间>`：删掉新 home，把备份改回原名 |
| `dsh --profile <p> --help` 挂住不返回 | 该 profile 是 base 模板（`dsh plugin add` 默认建的），0.2.1 起 base app 的 `--help` 会进 TUI | 冒烟改用 web profile：`dsh --profile <p> --from-default-profile web --help`；或外面套 `timeout 60`（macOS 没有 `timeout`，直接跑或用 `gtimeout`） |

更细的排障表随技能分发：`skills/dsh-migration/references/troubleshooting.md`（装上插件后 agent 也能直接读到）。

## 开发

```sh
node --test "test/**/*.test.mjs"     # 单元 + 集成（无外部依赖）
bash scripts/smoke-plugin.sh         # 真机 profile 冒烟（需要 dsh；建 web profile，--help 退出 0，带 timeout）
node scripts/build-package.mjs       # 出交付 zip → dist/
```

架构：`lib/index.js` 是**唯一** import `@deepseek-ai/*` 的文件（只做接线）；所有逻辑在 `lib/core/*.mjs`（零依赖、可单测）；`lib/client.js` 是浏览器半边（纯 JS，无构建）；`tools/` 是随归档分发的独立恢复工具。

```text
lib/core/  artifact-name 命名    inventory 发现式清单   sensitive 密钥自检   zip 引擎
           manifest 归档契约     verify 释放前校验      rewrite 路径重写     policy 打包/校验共用策略
           pack 打包编排         release 释放编排       pick-path 原生对话框  http-bridge Web 端点
           plugin-tools 工具描述  skill 随包技能
lib/client.js  设置 → 插件 里的「大肥鱼搬运」页签（两个按钮）
tools/restore.mjs  不依赖 DSH 的自救脚本
skills/dsh-migration/  随插件分发的技能
```

## 协作约定

所有改动走 **议题 → 分支 → PR → CI 三平台全绿 → squash 合并**；`main` 有分支保护，必需检查 `ci / linux`、`ci / windows`、`ci / macos`。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

MIT
