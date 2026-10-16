# 释放大肥鱼 · 新电脑操作说明

这个目录（`dsh-migrate-tools/`）是"打包大肥鱼"塞进 zip 里的自救工具：**即使新电脑还没装 DSH 插件，也能完成搬运。**

## 推荐路径（装了插件）

1. 装 Node（22.19+ 或 24+）
2. `npm i -g @deepseek-ai/dsh@<manifest.json 里 source.dsh 记录的版本>`
3. 安装 dsh-migrate 插件
4. 在 Web UI 点【释放大肥鱼】，选那个 zip → 等待完成
5. 重启 DSH

## 兜底路径（还没装插件）

1. 把 zip **解压**到任意目录（Windows 右键"全部解压缩"，macOS 双击，Linux `unzip`）
2. 在解压目录里执行：

   ```sh
   node dsh-migrate-tools/restore.mjs            # dry-run：只打印计划
   node dsh-migrate-tools/restore.mjs --yes      # 真的写入
   ```

   Windows 用 `dsh-migrate-tools\restore.cmd --yes`，或者 `node dsh-migrate-tools\restore.mjs --yes`。
3. 重启 DSH；如果插件行没生效，执行 `dsh plugin --profile <profile> add <插件目录>`

## 它会做什么

- 逐文件校验 `manifest.json` 里的 sha256，任一不符**立即中止**，不写入任何东西
- 目标 `$DSH_HOME`（默认 `~/.dsh`）已存在时，**整体重命名备份**为 `<home>.bak-<时间>`，不会静默合并
  - 想保留现有内容并叠加？加 `--merge`
- 按 manifest 记录的平台绑定项跳过在本机不能用的二进制（`--keep-incompatible` 可强制带上）
- 把配置里的旧 home 绝对路径重写成新 home，然后**复扫残留**并报告
- 写入失败会自动回滚到备份

## 不会做什么

- 不会带上任何 API key：凭据文件在打包侧就被硬排除，并在归档写出后再扫一遍
- 不会带上会话数据（sessions / attachments / 会话存储 / 日志）

## 出问题怎么办

| 现象 | 处理 |
|---|---|
| `restore: 校验失败 … sha256 不一致` | zip 传输损坏，重新拷贝；或用 `unzip -t` 检查 |
| 释放后插件不生效 | 平台绑定项被跳过了（看报告），或需要重新 `dsh plugin add` 让 pnpm 重建依赖 |
| 想退回原来的环境 | 删掉新 home，把 `<home>.bak-<时间>` 改名回 `<home>` |
| DSH 版本不一致 | 按 `manifest.json` 的 `source.dsh` 装同版本，或自行承担差异（会有 warning） |
