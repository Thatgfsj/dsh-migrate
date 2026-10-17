#!/usr/bin/env bash
# Compatibility check against the DSH `next` channel.
#
# One command that runs exactly the steps the `compat-next` CI job runs; the
# workflow calls this script, it never re-implements them.
#
#   1. npm install --prefix <prefix> --global @deepseek-ai/dsh@next
#   2. PATH=<prefix>/bin:$PATH node --test test/integration-dsh.test.mjs
#   3. build a web profile from the shipped template, install this plugin, and
#      assert the dsh-migrate layer/row in `dsh --dump-config`
#   4. boot that profile on a random free port, wait up to 90s for
#      GET /api/dsh-migrate/state -> 200 {"ok":true}, then stop it
#
# A failed boot prints the captured server log.
#
# Env overrides:
#   DSH_NEXT_SPEC        npm spec to install   (default: @deepseek-ai/dsh@next)
#   DSH_NEXT_PREFIX      install prefix        (default: fresh temp dir)
#   DSH_COMPAT_HOME      throwaway DSH_HOME    (default: fresh temp dir)
#   COMPAT_PORT          fixed port            (default: OS-assigned)
#   COMPAT_WAIT_SECONDS  readiness budget      (default: 90)
#   KEEP_TMP=1           keep the temp dir for debugging
#
# Usage: bash scripts/compat-check.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
spec="${DSH_NEXT_SPEC:-@deepseek-ai/dsh@next}"
wait_seconds="${COMPAT_WAIT_SECONDS:-90}"

tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/dsh-compat-XXXXXX")"
prefix="${DSH_NEXT_PREFIX:-$tmp_root/prefix}"
home="${DSH_COMPAT_HOME:-$tmp_root/home}"
profile="compat-next"
log="$tmp_root/dsh-server.log"
server_pid=""

cleanup() {
  local status=$?
  trap - EXIT
  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ "${KEEP_TMP:-0}" = "1" ]; then
    echo "-- kept temp dir: $tmp_root"
  else
    rm -rf "${tmp_root:?}"
  fi
  exit "$status"
}
trap cleanup EXIT

step() { printf '\n== %s\n' "$*"; }

fail_with_log() {
  echo "FAIL: $1" >&2
  if [ -s "$log" ]; then
    echo "---- dsh startup log (last 80 lines) ----" >&2
    tail -n 80 "$log" >&2
    echo "---- end of startup log ----" >&2
  fi
  exit 1
}

step "install $spec into $prefix"
dsh_bin="$prefix/bin/dsh"
if [ ! -x "$dsh_bin" ]; then
  npm install --prefix "$prefix" --global --no-fund --no-audit "$spec"
fi
next_version="$(PATH="$prefix/bin:$PATH" "$dsh_bin" --version | tail -n 1)"
echo "dsh next = $next_version"

step "integration test with the next runtime on PATH"
tap="$tmp_root/integration.tap"
if ! PATH="$prefix/bin:$PATH" node --test --test-reporter=tap "$repo_root/test/integration-dsh.test.mjs" > "$tap" 2>&1; then
  cat "$tap" >&2
  echo "FAIL: the real-runtime integration test failed on $next_version" >&2
  exit 1
fi
cat "$tap"
if ! grep -q '^# pass 1' "$tap" || grep -qE '^# skipped [1-9]' "$tap"; then
  echo "FAIL: the integration test did not run against the installed next runtime (skipped?)" >&2
  exit 1
fi

step "compose a web profile and install this plugin"
export DSH_HOME="$home"
mkdir -p "$home"
if ! "$dsh_bin" --profile "$profile" --from-default-profile web --dump-config > "$tmp_root/profile-web.yml" 2> "$tmp_root/profile-web.err"; then
  cat "$tmp_root/profile-web.err" >&2
  echo "FAIL: could not create the web profile from the shipped template" >&2
  exit 1
fi
"$dsh_bin" plugin --profile "$profile" add "$repo_root"

dump="$tmp_root/dump-config.yml"
"$dsh_bin" --profile "$profile" --dump-config > "$dump" 2> "$tmp_root/dump-config.err"
if ! grep -q '^# == dsh-migrate$' "$dump"; then
  cat "$tmp_root/dump-config.err" >&2
  echo "FAIL: composed config has no '# == dsh-migrate' layer" >&2
  exit 1
fi
if ! grep -q '^- id: dsh-migrate' "$dump"; then
  cat "$tmp_root/dump-config.err" >&2
  echo "FAIL: composed config has no '- id: dsh-migrate' row" >&2
  exit 1
fi
if grep -qi 'patch: entry .* not found' "$dump"; then
  echo "FAIL: composed config reports a missing patch target" >&2
  exit 1
fi
echo "-- layer ok: $(grep -m1 '^- id: dsh-migrate' "$dump")"

step "boot the web profile and probe /api/dsh-migrate/state"
if [ -n "${COMPAT_PORT:-}" ]; then
  port="$COMPAT_PORT"
else
  port="$(node -e 'const net = require("node:net"); const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => { process.stdout.write(String(probe.address().port)); probe.close() })')"
fi
url="http://127.0.0.1:$port/api/dsh-migrate/state"
body="$tmp_root/state.json"

"$dsh_bin" --profile "$profile" --host 127.0.0.1 --port "$port" --no-open > "$log" 2>&1 &
server_pid=$!
echo "-- pid $server_pid, port $port, waiting up to ${wait_seconds}s for $url"

ready=0
last_code="none"
deadline=$((SECONDS + wait_seconds))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    set +e
    wait "$server_pid"
    exit_code=$?
    set -e
    fail_with_log "dsh exited with code $exit_code before $url answered"
  fi
  last_code="$(curl -sS --max-time 2 -o "$body" -w '%{http_code}' "$url" 2>/dev/null || true)"
  if [ "$last_code" = "200" ]; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" = "1" ] || fail_with_log "timed out after ${wait_seconds}s waiting for $url (last status: $last_code)"

node -e '
const { readFileSync } = require("node:fs")
const state = JSON.parse(readFileSync(process.argv[1], "utf8"))
if (state.ok !== true) {
  console.error("FAIL: /api/dsh-migrate/state answered without ok:true:", JSON.stringify(state))
  process.exit(1)
}
console.log(`-- state ok:true home=${state.home} version=${state.version}`)
' "$body"

step "stop the server"
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""

step "compat ok: $spec ($next_version) — profile $profile, layer + endpoint verified"
