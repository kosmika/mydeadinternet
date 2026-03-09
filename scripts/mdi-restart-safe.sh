#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${MDI_APP_DIR:-/var/www/mydeadinternet}"
PROCESS_NAME="${MDI_PROCESS_NAME:-mydeadinternet}"
EXPECTED_CMD="${MDI_EXPECTED_CMD:-/var/www/mydeadinternet/server.js}"
PORT="${MDI_PORT:-3851}"

PRECHECK_SCRIPT="${APP_DIR}/scripts/mdi-port-preflight.sh"

if [[ ! -x "${PRECHECK_SCRIPT}" ]]; then
  echo "[MDI-RESTART] missing executable preflight script: ${PRECHECK_SCRIPT}" >&2
  exit 1
fi

echo "[MDI-RESTART] preflight: enforce port ownership on :${PORT}"
MDI_PORT="${PORT}" MDI_EXPECTED_CMD="${EXPECTED_CMD}" "${PRECHECK_SCRIPT}"

if command -v pm2 >/dev/null 2>&1; then
  echo "[MDI-RESTART] restarting PM2 process: ${PROCESS_NAME}"
  if ! pm2 restart "${PROCESS_NAME}"; then
    echo "[MDI-RESTART] PM2 process ${PROCESS_NAME} not found; starting it"
    pm2 start "${APP_DIR}/server.js" --name "${PROCESS_NAME}" --cwd "${APP_DIR}"
  fi
else
  echo "[MDI-RESTART] pm2 not found; starting node directly"
  nohup /usr/bin/node "${APP_DIR}/server.js" >/tmp/mdi-server.out 2>/tmp/mdi-server.err &
fi

sleep 2

echo "[MDI-RESTART] postflight: verify port ownership on :${PORT}"
MDI_PORT="${PORT}" MDI_EXPECTED_CMD="${EXPECTED_CMD}" "${PRECHECK_SCRIPT}"

if ! lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN | awk 'NR>1 {print $2}' | head -n 1 >/dev/null; then
  echo "[MDI-RESTART] failed: no listener on :${PORT}" >&2
  exit 1
fi

echo "[MDI-RESTART] success: MDI should now be authoritative on :${PORT}"
lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN || true
