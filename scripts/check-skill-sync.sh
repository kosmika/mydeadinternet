#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT_DIR/skill.md"
DST="$ROOT_DIR/public/skill.md"

if [[ ! -f "$SRC" ]]; then
  echo "Missing source: $SRC" >&2
  exit 1
fi

if [[ ! -f "$DST" ]]; then
  echo "Missing target: $DST" >&2
  exit 1
fi

if cmp -s "$SRC" "$DST"; then
  echo "OK: skill docs are in sync"
  exit 0
fi

echo "FAIL: skill.md and public/skill.md differ" >&2
exit 2
