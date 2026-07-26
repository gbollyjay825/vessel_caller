#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_root="$(mktemp -d)"
trap 'rm -rf "${fixture_root}"' EXIT

release_tag=v1.2.3
release_name="vessel-caller-${release_tag}"
payload="${fixture_root}/${release_name}"
archive="${fixture_root}/${release_name}.tar.gz"
mkdir -p "${payload}/backend/requirements" "${payload}/frontend/dist"
printf 'fixture\n' > "${payload}/backend/manage.py"
printf 'fixture\n' > "${payload}/backend/requirements/production.txt"
printf '<!doctype html><title>fixture</title>\n' > "${payload}/frontend/dist/index.html"
printf '{"schemaVersion":1,"release":"%s","immutable":true}\n' "${release_tag}" > "${payload}/RELEASE.json"
checksum_file="${fixture_root}/SHA256SUMS.tmp"
(
  cd "${payload}"
  find . -type f ! -name SHA256SUMS -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
) > "${checksum_file}"
mv "${checksum_file}" "${payload}/SHA256SUMS"
tar -C "${fixture_root}" -czf "${archive}" "${release_name}"
(
  cd "${fixture_root}"
  sha256sum "$(basename "${archive}")" > "$(basename "${archive}").sha256"
)

private_key="${fixture_root}/release-private.pem"
public_key="${fixture_root}/release-public.pem"
openssl genpkey \
  -algorithm RSA \
  -pkeyopt rsa_keygen_bits:2048 \
  -out "${private_key}" \
  >/dev/null 2>&1
openssl pkey -in "${private_key}" -pubout -out "${public_key}" >/dev/null 2>&1
openssl dgst -sha256 -sign "${private_key}" -out "${archive}.sig" "${archive}"

REQUIRE_RELEASE_SIGNATURE=true \
RELEASE_SIGNATURE_PUBLIC_KEY="${public_key}" \
  "${repo_root}/deploy/scripts/verify-release.sh" "${archive}"

output="${fixture_root}/.vercel/output"
REQUIRE_RELEASE_SIGNATURE=true \
RELEASE_SIGNATURE_PUBLIC_KEY="${public_key}" \
  "${repo_root}/deploy/scripts/build-vercel-preview.sh" "${archive}" "${output}"

test -f "${output}/static/index.html"
test -f "${output}/config.json"
test -f "${output}/functions/api.func/index.mjs"
test -f "${output}/functions/api.func/.vc-config.json"
grep -q '"runtime":"nodejs22.x"' "${output}/functions/api.func/.vc-config.json"
grep -Fq "\"dest\": \"/api?path=\$1\"" "${output}/config.json"

printf 'tamper\n' >> "${archive}"
if REQUIRE_RELEASE_SIGNATURE=true \
  RELEASE_SIGNATURE_PUBLIC_KEY="${public_key}" \
  "${repo_root}/deploy/scripts/verify-release.sh" "${archive}" >/dev/null 2>&1; then
  echo "Tampered release unexpectedly verified." >&2
  exit 1
fi

echo "Release verification and protected Vercel staging packaging tests passed."
