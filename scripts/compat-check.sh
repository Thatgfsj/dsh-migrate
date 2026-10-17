#!/usr/bin/env bash
# Compatibility check against the DSH `next` channel.
#
# One command that runs exactly the steps the `compat-next` CI job runs; the
# workflow calls this script, it never re-implements them.
#
#   1. npm install --prefix <prefix> --global @deepseek-ai/dsh@next
#   2. provision pnpm into its own prefix (dsh shells out to it, and GitHub
#      runners do not ship one)
#   3. PATH=<prefix>/bin:$PATH node --test test/integration-dsh.test.mjs
#   4. build a web profile from the shipped template, install this plugin, and
#      assert the dsh-migrate layer/row in `dsh --dump-config`
#   5. boot that profile with --port 0 (the OS picks, so there is no
#      bind/close/rebind race), read the assigned port from the startup log, wait
#      up to 90s for GET /api/dsh-migrate/state -> 200 {"ok":true} whose version
#      matches package.json, then stop it
#
# A failed boot prints the captured server log.
#
# Env overrides:
#   DSH_NEXT_SPEC        npm spec to install   (default: @deepseek-ai/dsh@next)
#   DSH_NEXT_PREFIX      install prefix        (default: fresh temp dir)
#   DSH_COMPAT_PNPM_SPEC pnpm spec to install  (default: pnpm@12)
#   DSH_COMPAT_HOME      throwaway DSH_HOME    (default: fresh temp dir)
#   COMPAT_PORT          fixed port instead of --port 0
#   COMPAT_WAIT_SECONDS  readiness budget      (default: 90)
#   DSH_FORCE_INSTALL=1  reinstall dsh/pnpm even when their prefixes exist
#   KEEP_TMP=1           keep the temp dir for debugging
#
# Usage: bash scripts/compat-check.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
spec="${DSH_NEXT_SPEC:-@deepseek-ai/dsh@next}"
pnpm_spec="${DSH_COMPAT_PNPM_SPEC:-pnpm@12}"
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
if [ "${DSH_FORCE_INSTALL:-0}" = "1" ] || [ ! -x "$dsh_bin" ]; then
  npm install --prefix "$prefix" --global --no-fund --no-audit "$spec"
else
  echo "-- reusing the dsh already installed at $dsh_bin (DSH_FORCE_INSTALL=1 reinstalls)"
fi
next_version="$(PATH="$prefix/bin:$PATH" "$dsh_bin" --version | tail -n 1)"
echo "dsh next = $next_version"

pnpm_prefix="$tmp_root/pnpm"
if [ "${DSH_FORCE_INSTALL:-0}" = "1" ] || [ ! -x "$pnpm_prefix/bin/pnpm" ]; then
  step "provision $pnpm_spec into $pnpm_prefix (dsh installs plugins through pnpm)"
  npm install --prefix "$pnpm_prefix" --global --no-fund --no-audit "$pnpm_spec"
else
  echo "-- reusing the pnpm already installed at $pnpm_prefix/bin/pnpm (DSH_FORCE_INSTALL=1 reinstalls)"
fi
echo "-- pnpm $("$pnpm_prefix/bin/pnpm" --version) at $pnpm_prefix/bin/pnpm"
bin_path="$pnpm_prefix/bin:$prefix/bin"

step "integration test with the next runtime on PATH"
tap="$tmp_root/integration.tap"
if ! PATH="$prefix/bin:$PATH" node --test --test-reporter=tap "$repo_root/test/integration-dsh.test.mjs" > "$tap" 2>&1; then
  cat "$tap" >&2
  echo "FAIL: the real-runtime integration test failed on $next_version" >&2
  exit 1
fi
cat "$tap"
if ! grep -qE '^# pass [1-9][0-9]*$' "$tap" || ! grep -q '^# fail 0$' "$tap" || grep -qE '^# skipped [1-9]' "$tap"; then
  echo "FAIL: the integration test did not pass cleanly on the next runtime (want '# pass N', '# fail 0', '# skipped 0'):" >&2
  grep -E '^# (pass|fail|skipped) ' "$tap" >&2 || true
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
PATH="$bin_path:$PATH" "$dsh_bin" plugin --profile "$profile" add "$repo_root"

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
body="$tmp_root/state.json"
if [ -n "${COMPAT_PORT:-}" ]; then
  port="$COMPAT_PORT"
  port_arg="$port"
else
  # --port 0: the OS picks a free port, so there is no race between a probe socket
  # and dsh binding it. The real port is read back from the startup log below.
  port=""
  port_arg="0"
fi

"$dsh_bin" --profile "$profile" --host 127.0.0.1 --port "$port_arg" --no-open > "$log" 2>&1 &
server_pid=$!
echo "-- pid $server_pid, port ${port:-auto}, waiting up to ${wait_seconds}s for the listening URL"

ready=0
last_code="none"
deadline=$((SECONDS + wait_seconds))
while [ "$SECONDS" -lt "$deadline" ]; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    set +e
    wait "$server_pid"
    exit_code=$?
    set -e
    fail_with_log "dsh exited with code $exit_code before the endpoint answered"
  fi
  if [ -z "$port" ]; then
    # 0.2.x prints: dsh web: http://127.0.0.1:<port>/?token=...
    port="$(grep -oE 'https?://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+' "$log" | head -n 1 | grep -oE '[0-9]+$' || true)"
    if [ -n "$port" ]; then
      echo "-- listening on http://127.0.0.1:$port (read from the startup log)"
    fi
  fi
  if [ -n "$port" ]; then
    last_code="$(curl -sS --max-time 2 -o "$body" -w '%{http_code}' "http://127.0.0.1:$port/api/dsh-migrate/state" 2>/dev/null || true)"
    if [ "$last_code" = "200" ]; then
      ready=1
      break
    fi
  fi
  sleep 1
done
[ "$ready" = "1" ] || fail_with_log "timed out after ${wait_seconds}s waiting for /api/dsh-migrate/state (last status: $last_code)"

node -e '
const { readFileSync } = require("node:fs")
const state = JSON.parse(readFileSync(process.argv[1], "utf8"))
const expected = JSON.parse(readFileSync(process.argv[2], "utf8")).version
if (state.ok !== true) {
  console.error("FAIL: /api/dsh-migrate/state answered without ok:true:", JSON.stringify(state))
  process.exit(1)
}
if (state.version !== expected) {
  console.error(`FAIL: state.version=${state.version} but package.json says ${expected} (version drift)`)
  process.exit(1)
}
console.log(`-- state ok:true home=${state.home} version=${state.version} (== package.json)`)
' "$body" "$repo_root/package.json"

step "stop the server"
kill "$server_pid" 2>/dev/null || true
wait "$server_pid" 2>/dev/null || true
server_pid=""

step "compat ok: $spec ($next_version) — profile $profile, layer + endpoint verified"
