# 人工验收清单

自动化能覆盖到的部分都在 CI 里跑（三平台矩阵 + release 工作流的三平台解压验收）。下面这些**必须有真机、最好有浏览器**才能下结论，逐条勾选。

## 通用（三平台都做）

- [ ] 解压交付 zip（Windows 用资源管理器 / macOS 用 Finder / Linux 用 `unzip`），执行 `install.sh`/`install.cmd` 能装进测试 profile
- [ ] `dsh --profile <p> --dump-config` 里出现 `# == dsh-migrate` 与 `- id: dsh-migrate`，且**没有** `patch: entry ... not found`
- [ ] 重启 DSH 后，会话技能目录里出现 `dsh-migration`
- [ ] 对 agent 说「打包大肥鱼」→ 弹出**原生保存对话框** → 进度从 0 走到 100 → 报告里有 zip 路径与体积
- [ ] 把 zip 拷到另一个 home → 说「释放大肥鱼」→ 进度走完 → 报告里有目标 home、备份路径
- [ ] 释放后 `dsh --profile <p> --dump-config` 通过；插件行生效
- [ ] 故意释放到一个非空 home → 生成 `<home>.bak-<时间>`，备份里有旧文件
- [ ] 在 zip 里塞一个假 `sk-` 字符串后重打包 → **必须中止**，且报告里是打码值

## 浏览器（Web UI 半边）

- [ ] 设置 → 插件 里出现「大肥鱼搬运」页签，页签内有【打包大肥鱼】【释放大肥鱼】两个按钮（输入框下方**不应**再有常驻入口）
- [ ] 控制台**没有** `slot entry crashed`
- [ ] 点【打包大肥鱼】→ 弹原生保存对话框 → 按钮变为进度文案 → 完成后显示 zip 路径
- [ ] 点【释放大肥鱼】→ 弹原生文件选择 → 进度走完 → 显示目标 home 与「已备份旧环境」
- [ ] 明暗主题各看一次，按钮与文案都清晰可读
- [ ] 与输入框附近其它宿主控件并排看，没有明显样式冲突

## Windows 专项（#18）

- [ ] 路径超过 260 字符时打包/释放不报错
- [ ] 归档里中文文件名正常显示
- [ ] `install.cmd` 与 `dsh-migrate-tools\\restore.cmd --yes` 都能跑通
- [ ] 资源管理器双击解压后目录结构正确
- [ ] 跨平台：把 Linux 上打的包在 Windows 上释放 → 报告里 `skipped` 列出 linux-only 二进制，其它内容正常

## macOS 专项（#19）

- [ ] Finder 双击解压后没有多余的 `__MACOSX` 干扰（有的用 `ditto -x -k` 再看一次）
- [ ] `tools/restore.sh` 仍有执行位（`ls -l` 看 `x`）
- [ ] 若系统提示「来自身份不明的开发者」，按需要处理 quarantine 后再执行
- [ ] `osascript` 选目录对话框能弹出并返回正确路径

## Linux 专项（#20）

- [ ] GNOME（zenity）与 KDE（kdialog）环境各弹一次对话框
- [ ] 在没有 `zenity`/`kdialog` 或没有 `DISPLAY` 的环境里，打包工具**回退到默认目录**并在报告里说明，不崩
- [ ] `sh tools/restore.sh --yes` 在纯 CLI 环境跑通

## 记录方式

每条勾选后把命令、输出、截图（如需要）贴回对应议题（#18 / #19 / #20）或本文件的 PR 评论里。**没有跑过的项目不要勾。**
