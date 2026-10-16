# dsh-migrate · 大肥鱼搬运工

[![ci](https://github.com/Thatgfsj/dsh-migrate/actions/workflows/ci.yml/badge.svg)](https://github.com/Thatgfsj/dsh-migrate/actions/workflows/ci.yml)
![DSH](https://img.shields.io/badge/DSH-0.2.0--rc.2-blue)
![platform](https://img.shields.io/badge/platform-linux%20%7C%20windows%20%7C%20macos-lightgrey)
![license](https://img.shields.io/badge/license-MIT-green)

把一台电脑上的 **DeepSeek Harness（DSH）** 整体搬到另一台电脑：插件、插件配置、技能、上下文，全部装进**一个 zip**。

> 名字来自用户：**打包大肥鱼**（导出）/ **释放大肥鱼**（导入）。

## 使用流程

```text
设备 1（旧机）
  1. 装好 DSH，安装本插件：dsh plugin --profile <profile> add <本仓库目录或 tarball>
  2. 打开 Web UI，点【打包大肥鱼】
  3. 弹窗里选择保存位置 → 得到 dsh-fatfish-<主机名>-<时间>.zip
  4. 把这个 zip 拷到新电脑（U 盘 / 网盘 / 微信）

设备 2（新机）
  5. 装 Node（22.19+ 或 24+）
  6. npm i -g @deepseek-ai/dsh@<zip 里 manifest 记录的版本>
  7. 安装本插件
  8. 点【释放大肥鱼】→ 选那个 zip → 等待片刻
  9. 重启 DSH，环境就是搬过来的那一套
```

zip 是**自包含**的：即使新机还没装 DSH 插件，也能用包内 `restore.mjs`（纯 Node 标准库）先释放，再自举安装插件。

## 打包范围

| 类型 | 内容 |
|---|---|
| ✅ 全量 | `$DSH_HOME/plugins/*` 整棵树（含资源文件、插件自带的 `node_modules`）、`$DSH_HOME/profiles/*`（配置 + 已安装依赖）、`$DSH_HOME/skills/*`、上下文文件（`AGENTS.md`、各插件留下的配置） |
| ✅ 记录 | DSH / Node / pnpm 版本、平台与架构、逐文件 sha256 |
| ❌ 硬排除 | **任何 API key**（`.credentials.yaml` 等）、会话数据（`sessions`、`attachments`、会话类 `storages`）、日志、本地历史备份 |
| ⚙️ 可选 | 工作区里的插件源码仓库（默认关） |

体积、清单、平台绑定项都是**打包时实测**写进 `manifest.json`，不写死任何机器的路径或文件。

## 状态

开发中，按议题拆分推进：[里程碑与议题清单](https://github.com/Thatgfsj/dsh-migrate/issues)。所有改动走 **议题 → 分支 → PR → CI 三平台全绿 → squash 合并**，每次合并前必须跑 CI（见 [CONTRIBUTING.md](CONTRIBUTING.md)）。

## 开发

```sh
node --test "test/**/*.test.mjs"   # 单元测试（无外部依赖）
npm pack --dry-run         # 检查发布内容
```

## License

MIT
