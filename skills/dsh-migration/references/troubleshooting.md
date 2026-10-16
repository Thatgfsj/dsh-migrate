# 排障表

| 现象 | 原因 | 处理 |
|---|---|---|
| `refusing to pack: N credential-like value(s) found` | 某个文件里有像密钥的字符串 | 报告已给出路径/行号/打码值；删掉或改用环境变量后重打包。**不要**为了绕过而把它塞进归档 |
| `archive failed verification: sha256 不一致` | zip 传输损坏 | 重新拷贝；`unzip -t` 检查归档 |
| `VERIFY_FAILED: 归档存在 manifest 未声明的文件` | 归档被第三方工具改写过 | 用原始 zip 释放 |
| 释放后插件行没生效 | 插件依赖需要重建；或平台绑定项被跳过 | 按报告里的自举命令执行 `dsh plugin --profile <p> add <home>/plugins/dsh-migrate`；或重装平台对应的插件包 |
| `residuals` 不为 0 | 有文件里的旧路径没被重写（二进制/超限/非文本） | 检查报告列出的文件；必要时手工改或用同平台重打包 |
| 目标机 DSH 版本与归档不同 | `manifest.source.dsh` 与本地不一致 | 装同版本，或接受 warning 自行承担差异 |
| 归档里少了语音模型 | 模型缓存默认不带 | 重打包时用 `includeModels: true` |
| 弹不出"选择保存位置" | headless / 无 zenity/kdialog / 无 DISPLAY | 工具会自动回退到默认目录并在报告里说明；也可显式传 `savePath` |
| 想撤销释放 | 默认会整体备份 | 删掉新 home，把 `<home>.bak-<时间>` 改回 `<home>` |
| 体积比预期大很多 | 插件里的媒体资源（例如启动动画视频）本来就大 | 看 manifest `totals.bytesByCategory`，按需取舍；不要改打包器的判据 |
