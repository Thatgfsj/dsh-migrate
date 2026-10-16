#!/usr/bin/env bash
# Smoke-test the plugin against a real dsh installation.
#
# Creates a throwaway profile, installs this package into it with the documented
# `dsh plugin add` path, and asserts the bundle layer and its row show up in the
# composed config. Requires `dsh` on PATH and pnpm (dsh uses it internally).
#
# Usage: bash scripts/smoke-plugin.sh [profile-name]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${1:-fatfish-smoke-$$}"
dsh_home="${DSH_HOME:-$HOME/.dsh}"

cleanup() {
  rm -rf "${dsh_home:?}/profiles/${profile:?}"
}
trap cleanup EXIT

echo "== installing $repo_root into profile $profile"
dsh plugin --profile "$profile" add "$repo_root"

echo "== composed layer for dsh-migrate"
dsh --profile "$profile" --dump-config | grep -n -A3 '^# == dsh-migrate$'

echo "== row"
dsh --profile "$profile" --dump-config | grep -n -A2 '^- id: dsh-migrate'

if dsh --profile "$profile" --dump-config | grep -qi 'patch: entry .* not found'; then
  echo "FAIL: composed config reports a missing patch target" >&2
  exit 1
fi

echo "== boot smoke (host half must mount without throwing)"
dsh --profile "$profile" --help >/dev/null

echo "smoke ok (profile $profile removed)"
