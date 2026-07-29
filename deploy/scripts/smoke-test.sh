#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<EOF
Usage:
  $0 --availability-only https://hostname
  $0 --qualify-release https://hostname vMAJOR.MINOR.PATCH
EOF
}

mode="${1:-}"
base_url=""
expected_release=""

case "${mode}" in
  --availability-only)
    if [[ "$#" -ne 2 ]]; then
      usage
      exit 2
    fi
    base_url="$2"
    ;;
  --qualify-release)
    if [[ "$#" -ne 3 ]]; then
      usage
      exit 2
    fi
    base_url="$2"
    expected_release="$3"
    if [[ ! "${expected_release}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
      echo "Expected release must use semantic vMAJOR.MINOR.PATCH syntax." >&2
      exit 2
    fi
    ;;
  https://*)
    if [[ "$#" -ne 1 ]]; then
      usage
      exit 2
    fi
    base_url="${mode}"
    mode="--availability-only"
    echo "WARNING: implicit availability-only mode is deprecated and does not qualify a release." >&2
    ;;
  *)
    usage
    exit 2
    ;;
esac

if [[ "${base_url}" != https://* ]]; then
  usage
  exit 2
fi

tmp_headers="$(mktemp)"
trap 'rm -f "${tmp_headers}"' EXIT

curl_headers=(--header "User-Agent: VesselCallerSmoke/1.0")

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

health_response="$(curl --fail --silent --show-error --max-time 20 \
  "${curl_headers[@]}" "${base_url}/api/health")"
readiness_response="$(curl --fail --silent --show-error --max-time 20 \
  "${curl_headers[@]}" "${base_url}/api/readiness")"

if [[ "${mode}" == "--qualify-release" ]]; then
  if ! jq --exit-status \
    --arg release "${expected_release}" \
    '.status == "ok"
      and .release.tag == $release
      and (.release.sha | type == "string" and test("^[0-9a-f]{40}$"))' \
    <<<"${health_response}" >/dev/null; then
    echo "/api/health did not identify the expected Django release ${expected_release}." >&2
    exit 1
  fi
  if ! jq --exit-status \
    --arg release "${expected_release}" \
    '.status == "ready" and .release.tag == $release' \
    <<<"${readiness_response}" >/dev/null; then
    echo "/api/readiness did not identify the ready Django release ${expected_release}." >&2
    exit 1
  fi
  echo "Release qualification smoke test passed for ${base_url} at ${expected_release}."
  exit 0
fi

for response in "${health_response}" "${readiness_response}"; do
  if ! jq --exit-status \
    '.status | type == "string" and length > 0' \
    <<<"${response}" >/dev/null; then
    echo "Availability endpoint returned an unexpected payload." >&2
    exit 1
  fi
done

echo "Availability-only smoke check passed for ${base_url}; this does not qualify a release."
