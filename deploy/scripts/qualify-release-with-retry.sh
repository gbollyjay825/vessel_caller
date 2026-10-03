#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <smoke-test> <public-url> <expected-release> <attempts> <retry-seconds>" >&2
}

smoke_test="${1:-}"
public_url="${2:-}"
expected_release="${3:-}"
attempts="${4:-}"
retry_seconds="${5:-}"

if [[ "$#" -ne 5 \
  || ! -x "${smoke_test}" \
  || "${public_url}" != https://* \
  || ! "${expected_release}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ \
  || ! "${attempts}" =~ ^[1-9][0-9]*$ \
  || ! "${retry_seconds}" =~ ^(0|[1-9][0-9]*)$ ]]; then
  usage
  exit 2
fi

# Bound operator-supplied values so a bad environment cannot leave a promotion
# hanging indefinitely while production is between slots.
if ((attempts > 30 || retry_seconds > 10)); then
  echo "Release qualification allows at most 30 attempts and 10 seconds between attempts." >&2
  exit 2
fi

for ((attempt = 1; attempt <= attempts; attempt += 1)); do
  if "${smoke_test}" --qualify-release "${public_url}" "${expected_release}"; then
    exit 0
  fi

  if ((attempt < attempts)); then
    echo "Release qualification attempt ${attempt}/${attempts} failed; allowing retiring Nginx workers to drain before retrying." >&2
    sleep "${retry_seconds}"
  fi
done

echo "Release qualification failed after ${attempts} attempts." >&2
exit 1
