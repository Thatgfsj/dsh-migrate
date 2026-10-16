@echo off
rem 释放大肥鱼（独立版，不依赖 DSH 插件）
rem 用法：把 zip 解压后，在解压目录里执行
rem   dsh-migrate-tools\restore.cmd --yes
rem 默认是 dry-run，加 --yes 才会写入；详细选项见 restore.mjs 顶部注释。
setlocal
set "DIR=%~dp0"
node "%DIR%restore.mjs" %*
