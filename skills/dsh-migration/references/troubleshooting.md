# 排障表

| 现象 | 原因 | 处理 |
|---|---|---|
| `refusing to pack: N credential-like value(s) found` | 某个文本文件里有 key 形状的**值**（`sk-`/`ghp_`/`AKIA`/`xox`/带主体的 PEM） | 报告已给出路径/行号/打码值；删掉或改用环境变量后重打包。**不要**为了绕过而把它塞进归档 |
| manifest 里 `sensitiveScan.suspicious` 非空 | 有 `api_key = <值>` 这种低置信度命中（常见于第三方源码/文档） | 属报告项，不影响打包；确认是文档示例即可忽略，想更严就开 `strictSecrets: true` |
| 归档 `excluded` 里有 `.env`/`*.pem` | 凭据文件被按路径硬排除 | 这是设计：新机上重新填 key。若确实需要带，请自行确认无密钥后再处理 |
| `archive failed verification: sha256 不一致` | zip 传输损坏 | 重新拷贝；`unzip -t` 检查归档 |
| `VERIFY_FAILED: 归档存在 manifest 未声明的文件` | 归档被第三方工具改写过 | 用原始 zip 释放 |
| 释放后插件行没生效 | 插件依赖需要重建；或平台绑定项被跳过 | 按报告里的自举命令执行 `dsh plugin --profile <p> add <home>/plugins/dsh-migrate`；或重装平台对应的插件包 |
| `residuals` 不为 0 | 有文件里的旧路径没被重写（二进制/超限/非文本） | 检查报告列出的文件；必要时手工改或用同平台重打包 |
| 目标机 DSH 版本与归档不同 | `manifest.source.dsh` 与本地不一致 | 装同版本，或接受 warning 自行承担差异 |
| 归档里少了语音模型 | 模型缓存默认不带 | 重打包时用 `includeModels: true` |
| 弹不出"选择保存位置" | headless / 无 zenity/kdialog / 无 DISPLAY | 工具会自动回退到默认目录并在报告里说明；也可显式传 `savePath` |
| 想撤销释放 | 默认会整体备份 | 删掉新 home，把 `<home>.bak-<时间>` 改回 `<home>` |
| 插件页点开关后页签/工具全没了 | 那个开关是**启用/停用**，停用会往 profile 的 `cordis.patch.yml` 写入 `- id: dsh-migrate / disabled: true` | 把这两行删掉（或让 agent 删），重启 DSH |
| 「添加插件」里填了 GitHub 地址 | 本插件没发 npm，git 安装会拉远端源码、要求审批技能，并**顶掉本地安装** | 卸载后改用本地目录或本地 tgz：`dsh plugin --profile <p> add <路径>` |
| 安装时提示 `Agent skills awaiting approval` | 远端来源的插件携带技能时需要用户批准（平台安全策略） | 要么批准，要么改用本地目录/tgz 安装——本地安装不需要审批 |
| 体积比预期大很多 | 插件里的媒体资源（例如启动动画视频）本来就大 | 看 manifest `totals.bytesByCategory`，按需取舍；不要改打包器的判据 |
| `dsh --profile <p> --help` 挂住不退出 | `dsh plugin add` 默认建的是 base 模板 profile；0.2.1 起 base app 的 `--help` 会进 TUI，而不是打印用法 | 冒烟改用 web profile：`dsh --profile <p> --from-default-profile web --help`；或外套 `timeout 60`（macOS 没有 `timeout`，可用 `gtimeout` 或直接跑） |
