#!/usr/bin/env bash
# Smoke-test the plugin against a real dsh installation.
#
# Creates a throwaway profile **from the shipped web template**, installs this
# package into it with the documented `dsh plugin add` path, and asserts the
# bundle layer and its row show up in the composed config. Requires `dsh` on PATH
# and pnpm (dsh uses it internally).
#
# Why a web profile and not the default one: `dsh plugin add` initializes a plain
# profile (bundles: `@deepseek-ai/dsh-base`), and the base app's `--help` boots
# the TUI and never returns (reproduced on 0.2.0-rc.2 and 0.2.1-rc.2). The web app's `--help` prints usage
# and exits 0 on both 0.2.0-rc.2 and 0.2.1-rc.2, so the boot smoke runs against a
# web profile under `timeout` where available. `--from-default-profile` alone
# *boots* the profile it creates, so `--help` is what makes it initialize + exit.
#
# Usage: bash scripts/smoke-plugin.sh [profile-name]
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${1:-fatfish-smoke-$$}"
dsh_home="${DSH_HOME:-$HOME/.dsh}"
smoke_timeout="${SMOKE_TIMEOUT:-60}"

cleanup() {
  rm -rf "${dsh_home:?}/profiles/${profile:?}"
}
trap cleanup EXIT

# Run a command with a wall-clock cap. GNU `timeout` / `gtimeout` when present,
# otherwise a bash-native watchdog (stock macOS has neither binary): the cap has
# to hold everywhere, so a hang can never wedge the smoke run. stdout/stderr of
# the wrapped command pass through unchanged.
run_bounded() {
  if command -v timeout >/dev/null 2>&1; then
    local trapped_status=0
    timeout "$smoke_timeout" "$@" || trapped_status=$?
    return "$trapped_status"
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    local trapped_status=0
    gtimeout "$smoke_timeout" "$@" || trapped_status=$?
    return "$trapped_status"
  fi
  "$@" &
  local pid=$!
  ( sleep "$smoke_timeout"; if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null; echo "run_bounded: killed pid $pid after ${smoke_timeout}s: $*" >&2; fi ) &
  local watchdog=$!
  local status=0
  wait "$pid" || status=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  return "$status"
}

echo "== creating profile $profile from the shipped web template"
# Without --help this would initialize the profile and then boot the web server.
run_bounded dsh --profile "$profile" --from-default-profile web --help >/dev/null

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

echo "== boot smoke (web app --help; the host half must mount without throwing)"
if ! run_bounded dsh --profile "$profile" --help >/dev/null; then
  echo "FAIL: boot smoke did not exit 0 (a base-template profile hangs here: base app --help enters the TUI)" >&2
  exit 1
fi

echo "smoke ok (profile $profile removed)"
