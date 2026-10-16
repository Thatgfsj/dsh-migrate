#!/usr/bin/env sh
# 释放大肥鱼（独立版，不依赖 DSH 插件）
#
# 用法：把 zip 解压后，在解压目录里执行
#   sh dsh-migrate-tools/restore.sh --yes
# 默认是 dry-run，加 --yes 才会写入；详细选项见 restore.mjs 顶部注释。
set -e
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$dir/restore.mjs" "$@"
