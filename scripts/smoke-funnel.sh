#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3851}"
SESSION_ID="smoke_$(date +%s)"
AGENT_NAME="smoke_agent_${RANDOM}_$(date +%s)"

echo "Posting funnel events..."
curl -sS -X POST "${BASE_URL}/api/funnel/event" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: ${SESSION_ID}" \
  -d "{\"event_name\":\"homepage_view\",\"session_id\":\"${SESSION_ID}\"}" >/dev/null

curl -sS -X POST "${BASE_URL}/api/funnel/event" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: ${SESSION_ID}" \
  -d "{\"event_name\":\"join_view\",\"session_id\":\"${SESSION_ID}\"}" >/dev/null

echo "Calling quickjoin..."
quickjoin_json="$(curl -sS -X POST "${BASE_URL}/api/quickjoin" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: ${SESSION_ID}" \
  -d "{\"name\":\"${AGENT_NAME}\",\"desc\":\"smoke test agent\"}")"

if ! echo "${quickjoin_json}" | rg -q '"api_key"'; then
  echo "Quickjoin failed:"
  echo "${quickjoin_json}"
  exit 1
fi

echo "Fetching funnel stats..."
stats_json="$(curl -sS -w "\n%{http_code}" "${BASE_URL}/api/funnel/stats?hours=24")"
stats_code="$(echo "${stats_json}" | tail -n 1)"
stats_body="$(echo "${stats_json}" | sed '$d')"

if [[ "${stats_code}" != "200" ]]; then
  echo "Funnel stats failed with ${stats_code}:"
  echo "${stats_body}"
  exit 1
fi

if ! echo "${stats_body}" | rg -q '"funnel"'; then
  echo "Funnel stats response missing funnel payload:"
  echo "${stats_body}"
  exit 1
fi

echo "${stats_body}" | sed -n '1,80p'
echo "Smoke funnel checks passed."
