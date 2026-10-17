# 工作流参考

## 打包（设备 1）

```text
fatfish_pack
  savePath?     直接指定 zip 路径；不给则弹系统对话框
  includeModels? 连语音模型缓存一起打包（默认否）
  dryRun?       只报告将写到哪里
```

内部流水线（`lib/core/pack.mjs`，进度事件按这段映射 0–100%）：

1. **scan** — `inventory.mjs` 发现式扫描，得到分类条目、排除清单、可选清单、平台绑定项
2. **secrets** — 凭据**文件**（`.credentials*`/`.env`/`*.pem`/`id_rsa*`…）在扫描前就按路径排除；剩下的文本文件扫 `sk-`/`ghp_`/`AKIA`/`xox`/带完整 base64 主体的 PEM 块 → **命中即中止**（错误里的密钥已打码）；泛化的 `api_key = <看起来像字面量>` 只记 warning 并写进 manifest（`strictSecrets: true` 才会中止）
3. **hash** — 有界并发算 sha256（默认 8 路）
4. **archive** — 写 `manifest.json` → 目录项 → payload → 内嵌工具；取消/失败会删掉半成品
5. **verify** — 复算 CRC/尺寸、条目数一致性、`assertArchiveIsClean`（策略二次确认）

产物：单文件 zip，可被 Windows 资源管理器 / macOS Finder / `unzip` 直接打开。

## 释放（设备 2）

```text
fatfish_release
  zipPath?     要释放的 zip；不给则弹文件选择对话框
  targetHome?  目标 DSH home，默认 $DSH_HOME 或 ~/.dsh
  merge?       写进已存在的 home（默认否，默认整体备份）
  dryRun?      默认 true —— 只演练
```

内部流水线（`lib/core/release.mjs`）：

1. **verify** — 同上；不通过抛 `VERIFY_FAILED`
2. **stage** — 解包到暂存目录（**平台不兼容项在解包阶段就被排除**）
3. **plan** — 路径重写在暂存副本上完成（旧 home → 新 home，覆盖 POSIX / 反斜杠 / JSON 转义三种写法）
4. **backup** — 目标 home 存在则整体 `rename` 成 `<home>.bak-<时间>`
5. **write** — 复制 payload、恢复权限位与时间；把内嵌插件副本放到 `<home>/plugins/dsh-migrate`
6. **check** — 全树复扫旧前缀（残留必须为 0），按需自举 `dsh plugin --profile <p> add <插件路径>`；最后用目标 home 跑一次 `dsh --profile <p> --dump-config` 自检（结果在报告的 `postInstall`）：`skipping profile bundle "X"` / `patch: entry ... not found` 都会变成 warning —— 释放本身不会因此失败，找不到 dsh 就是 `checked:false` + 一条提示

失败时：删除新 home、把备份改回原名。

## 独立恢复工具（插件不可用时）

```sh
unzip dsh-fatfish-*.zip -d target && cd target
node dsh-migrate-tools/restore.mjs            # dry-run
node dsh-migrate-tools/restore.mjs --yes      # 真写
```

Windows 用 `dsh-migrate-tools\restore.cmd --yes`。它只用 Node 标准库，校验 sha256、整体备份、路径重写、残留复扫、失败回滚，并把内嵌插件副本放到 `<home>/plugins/dsh-migrate`。

## 报告里该看什么

- `skipped`：平台绑定项被跳过（换平台必须重建，别当成失败）
- `backupPath`：旧环境去哪了；要退回就把新 home 删掉、备份改回原名
- `residuals`：残留的旧路径（>0 说明有文件没重写成功，通常需要重建插件依赖）
- `bootstrap`：自举安装结果；失败不影响释放，按给出的命令手动执行即可
- `postInstall`：释放后自检。`checked:true` 且无 warning = 目标 profile 的 bundle 全部解析正常；有 `skippedBundles` / `missingPatches` 时按报告的 `dsh plugin --profile <p> install` 处理

## 升级 DSH / 换到新机之后

先确认目标 profile 没有被静默跳过的层：

```sh
dsh --profile <p> --dump-config | grep -i 'skipping profile bundle'
```

0.2.1 起，解析不到的 bundle 会打印 `skipping profile bundle "X"` 然后继续启动——表现就是「插件页/技能莫名消失」。处理：`dsh plugin --profile <p> install` 重建依赖，再重启 DSH。释放流程末尾的 `postInstall` 自检会自动跑这一步并写进报告。
