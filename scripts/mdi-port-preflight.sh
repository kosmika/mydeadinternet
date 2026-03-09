#!/usr/bin/env bash
set -euo pipefail

PORT="${MDI_PORT:-3851}"
EXPECTED_CMD="${MDI_EXPECTED_CMD:-/var/www/mydeadinternet/server.js}"

listeners_raw=$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)
if [[ -z "${listeners_raw}" ]]; then
  echo "[MDI-PREFLIGHT] no listener on :${PORT}"
  exit 0
fi

mapfile -t listener_pids < <(printf '%s\n' "${listeners_raw}" | awk 'NR>1 {print $2}' | sort -u)
if [[ ${#listener_pids[@]} -eq 0 ]]; then
  echo "[MDI-PREFLIGHT] no listener pids parsed for :${PORT}"
  exit 0
fi

expected_pids=()
rogue_pids=()

for pid in "${listener_pids[@]}"; do
  if [[ ! -d "/proc/${pid}" ]]; then
    continue
  fi

  cmdline=$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)
  if [[ "${cmdline}" == *"${EXPECTED_CMD}"* ]]; then
    expected_pids+=("${pid}")
  else
    rogue_pids+=("${pid}")
  fi
done

if [[ ${#rogue_pids[@]} -gt 0 ]]; then
  echo "[MDI-PREFLIGHT] terminating rogue listeners on :${PORT}: ${rogue_pids[*]}"
  kill -TERM "${rogue_pids[@]}" || true
  sleep 2
fi

still_rogue=()
for pid in "${rogue_pids[@]}"; do
  if kill -0 "${pid}" 2>/dev/null; then
    still_rogue+=("${pid}")
  fi
done

if [[ ${#still_rogue[@]} -gt 0 ]]; then
  echo "[MDI-PREFLIGHT] force killing rogue listeners on :${PORT}: ${still_rogue[*]}"
  kill -KILL "${still_rogue[@]}" || true
  sleep 1
fi

if [[ ${#expected_pids[@]} -gt 1 ]]; then
  keep_pid="${expected_pids[0]}"
  extra_expected=()
  for pid in "${expected_pids[@]}"; do
    if [[ "${pid}" != "${keep_pid}" ]]; then
      extra_expected+=("${pid}")
    fi
  done
  if [[ ${#extra_expected[@]} -gt 0 ]]; then
    echo "[MDI-PREFLIGHT] terminating duplicate MDI listeners on :${PORT}: ${extra_expected[*]}"
    kill -TERM "${extra_expected[@]}" || true
    sleep 1
  fi
fi

echo "[MDI-PREFLIGHT] completed for :${PORT}; expected command path: ${EXPECTED_CMD}"
