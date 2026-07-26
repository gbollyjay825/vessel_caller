#!/usr/bin/env bash
set -euo pipefail

url="${1:-}"
attempts="${2:-30}"

if [[ -z "${url}" || ! "${attempts}" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 <url> [attempts]" >&2
  exit 2
fi

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if curl --fail --silent --show-error --max-time 5 "${url}" >/dev/null; then
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for ${url} after ${attempts} attempts." >&2
exit 1
