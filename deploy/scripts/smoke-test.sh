#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-}"
if [[ -z "${base_url}" || "${base_url}" != https://* ]]; then
  echo "Usage: $0 https://hostname" >&2
  exit 2
fi

tmp_headers="$(mktemp)"
trap 'rm -f "${tmp_headers}"' EXIT

curl_headers=()
if [[ -n "${VERCEL_AUTOMATION_BYPASS_SECRET:-}" ]]; then
  curl_headers+=(--header "x-vercel-protection-bypass: ${VERCEL_AUTOMATION_BYPASS_SECRET}")
fi

curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --max-time 20 \
  --dump-header "${tmp_headers}" \
  "${curl_headers[@]}" \
  --output /dev/null \
  "${base_url}/"

for header in strict-transport-security x-content-type-options x-frame-options; do
  if ! grep -Eiq "^${header}:" "${tmp_headers}"; then
    echo "Missing required response header: ${header}" >&2
    exit 1
  fi
done

for endpoint in /api/health /api/readiness; do
  response="$(curl --fail --silent --show-error --max-time 20 \
    "${curl_headers[@]}" "${base_url}${endpoint}")"
  if [[ "${response}" != *'"status"'* ]]; then
    echo "${endpoint} returned an unexpected payload." >&2
    exit 1
  fi
done

echo "Smoke test passed for ${base_url}."
