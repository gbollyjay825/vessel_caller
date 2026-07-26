#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
output="${2:-.vercel/output}"
if [[ -z "${archive}" || ! -f "${archive}" || ! -f "${archive}.sha256" ]]; then
  echo "Usage: $0 <verified-release.tar.gz> [output-directory]" >&2
  exit 2
fi
case "${output}" in
  .vercel/output|*/.vercel/output) ;;
  *)
    echo "Output must end with .vercel/output." >&2
    exit 2
    ;;
esac
if [[ -L "${output}" || -L "$(dirname "${output}")" ]]; then
  echo "Refusing to write Vercel output through a symlink." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${script_dir}/verify-release.sh" "${archive}"

extract_root="$(mktemp -d)"
trap 'rm -rf "${extract_root}"' EXIT
tar --no-same-owner --no-same-permissions -xzf "${archive}" -C "${extract_root}"
payload="$(find "${extract_root}" -mindepth 1 -maxdepth 1 -type d -name 'vessel-caller-v*' -print -quit)"
if [[ -z "${payload}" || ! -f "${payload}/frontend/dist/index.html" ]]; then
  echo "Release does not contain a frontend build." >&2
  exit 1
fi

if [[ -d "${output}" ]]; then
  find "${output}" -mindepth 1 -delete
fi
install -d -m 0755 "${output}/static" "${output}/functions/api.func"
rsync -a --delete "${payload}/frontend/dist/" "${output}/static/"
install -m 0644 "${script_dir}/../vercel-output-config.json" "${output}/config.json"
install \
  -m 0644 \
  "${script_dir}/../vercel-staging-api-proxy.mjs" \
  "${output}/functions/api.func/index.mjs"
printf '%s\n' \
  '{"runtime":"nodejs22.x","handler":"index.mjs","launcherType":"Nodejs","shouldAddHelpers":false}' \
  > "${output}/functions/api.func/.vc-config.json"

echo "Prepared immutable Vercel Build Output API package at ${output}."
