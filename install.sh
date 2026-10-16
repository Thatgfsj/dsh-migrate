#!/usr/bin/env sh
# 把 dsh-migrate 装进一个 DSH profile。
#
# 用法：
#   sh install.sh [profile]      # 默认 profile 是 web
#
# 这就是把插件目录交给 dsh 的官方安装路径（内部走 pnpm + profile 的 bundle 列表），
# 不需要手写 profile 的 package.json 或 cordis.patch.yml。
set -e
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
profile="${1:-web}"

if ! command -v dsh >/dev/null 2>&1; then
  echo "找不到 dsh 命令：请先 npm i -g @deepseek-ai/dsh@<zip 里 manifest 记录的版本>" >&2
  exit 1
fi

echo "== 把 $dir 安装到 profile $profile"
dsh plugin --profile "$profile" add "$dir"
echo
echo "装好了。重启 DSH 后："
echo "  - 会话里可以用「打包大肥鱼」「释放大肥鱼」"
echo "  - Web UI 输入框下方出现两个按钮"
