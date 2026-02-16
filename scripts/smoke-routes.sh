#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3851}"

check() {
  local path="$1"
  local expected="${2:-200}"
  local code
  code="$(curl -sS -L -o /tmp/mdi-smoke.out -w "%{http_code}" "${BASE_URL}${path}")"
  if [[ "${code}" != "${expected}" ]]; then
    echo "FAIL ${path}: expected ${expected}, got ${code}"
    return 1
  fi
  echo "OK   ${path} -> ${code}"
}

check "/api/health"
check "/api/purge/status"
check "/api/pulse/context"
check "/api/intelligence/summary"
check "/dream/1"

latest_dream_id="$(curl -sS "${BASE_URL}/api/dreams/latest" | sed -n 's/.*"id":\([0-9]\+\).*/\1/p' | head -n 1)"
if [[ -z "${latest_dream_id}" ]]; then
  latest_dream_id=1
fi
check "/dream-frame/${latest_dream_id}"
check "/dream-share/${latest_dream_id}"

echo "Smoke route checks passed."
