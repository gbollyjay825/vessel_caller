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

fake_bin="${fixture_root}/fake-bin"
mkdir -p "${fake_bin}"
cat > "${fake_bin}/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

headers_file=""
url="${!#}"
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --dump-header)
      headers_file="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

case "${url}" in
  */api/health)
    printf '%s\n' "${FAKE_HEALTH_RESPONSE}"
    ;;
  */api/readiness)
    printf '%s\n' "${FAKE_READINESS_RESPONSE}"
    ;;
  *)
    if [[ -n "${headers_file}" ]]; then
      cat > "${headers_file}" <<'HEADERS'
HTTP/2 200
strict-transport-security: max-age=63072000
x-content-type-options: nosniff
x-frame-options: DENY

HEADERS
    fi
    ;;
esac
EOF
chmod 0755 "${fake_bin}/curl"

release_sha=0123456789abcdef0123456789abcdef01234567
export FAKE_HEALTH_RESPONSE
export FAKE_READINESS_RESPONSE
FAKE_HEALTH_RESPONSE="$(
  jq -cn \
    --arg tag "${release_tag}" \
    --arg sha "${release_sha}" \
    '{status:"ok", release:{tag:$tag, sha:$sha}}'
)"
FAKE_READINESS_RESPONSE="$(
  jq -cn \
    --arg tag "${release_tag}" \
    --arg sha "${release_sha}" \
    '{status:"ready", release:{tag:$tag, sha:$sha}}'
)"

PATH="${fake_bin}:${PATH}" \
  "${repo_root}/deploy/scripts/smoke-test.sh" \
  --qualify-release \
  https://staging.example.test \
  "${release_tag}"

if PATH="${fake_bin}:${PATH}" \
  "${repo_root}/deploy/scripts/smoke-test.sh" \
  --qualify-release \
  https://staging.example.test \
  v1.2.4 >/dev/null 2>&1; then
  echo "Mismatched Django release unexpectedly passed qualification smoke tests." >&2
  exit 1
fi

FAKE_HEALTH_RESPONSE='{"status":"ok"}'
FAKE_READINESS_RESPONSE='{"status":"ready"}'
PATH="${fake_bin}:${PATH}" \
  "${repo_root}/deploy/scripts/smoke-test.sh" \
  --availability-only \
  https://legacy.example.test

if PATH="${fake_bin}:${PATH}" \
  "${repo_root}/deploy/scripts/smoke-test.sh" \
  --qualify-release \
  https://legacy.example.test \
  "${release_tag}" >/dev/null 2>&1; then
  echo "Availability-only legacy payload unexpectedly qualified a release." >&2
  exit 1
fi

retry_attempt_file="${fixture_root}/promotion-attempts"
retry_smoke_test="${fixture_root}/retry-smoke-test.sh"
cat > "${retry_smoke_test}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 3 \
  || "$1" != "--qualify-release" \
  || "$2" != "https://production.example.test" \
  || "$3" != "v1.2.3" ]]; then
  exit 2
fi

attempt="$(<"${RETRY_ATTEMPT_FILE}")"
attempt="$((attempt + 1))"
printf '%s\n' "${attempt}" > "${RETRY_ATTEMPT_FILE}"
[[ "${RETRY_SUCCEED_ON}" -gt 0 && "${attempt}" -ge "${RETRY_SUCCEED_ON}" ]]
EOF
chmod 0755 "${retry_smoke_test}"

printf '0\n' > "${retry_attempt_file}"
RETRY_ATTEMPT_FILE="${retry_attempt_file}" \
RETRY_SUCCEED_ON=2 \
  "${repo_root}/deploy/scripts/qualify-release-with-retry.sh" \
  "${retry_smoke_test}" \
  https://production.example.test \
  "${release_tag}" \
  4 \
  0
if [[ "$(<"${retry_attempt_file}")" != "2" ]]; then
  echo "Promotion qualification did not recover after the retiring-worker response." >&2
  exit 1
fi

printf '0\n' > "${retry_attempt_file}"
if RETRY_ATTEMPT_FILE="${retry_attempt_file}" \
  RETRY_SUCCEED_ON=0 \
  "${repo_root}/deploy/scripts/qualify-release-with-retry.sh" \
  "${retry_smoke_test}" \
  https://production.example.test \
  "${release_tag}" \
  3 \
  0 >/dev/null 2>&1; then
  echo "Permanently mismatched release unexpectedly passed promotion qualification." >&2
  exit 1
fi
if [[ "$(<"${retry_attempt_file}")" != "3" ]]; then
  echo "Promotion qualification did not stop at its bounded attempt limit." >&2
  exit 1
fi
if RETRY_ATTEMPT_FILE="${retry_attempt_file}" \
  RETRY_SUCCEED_ON=1 \
  "${repo_root}/deploy/scripts/qualify-release-with-retry.sh" \
  "${retry_smoke_test}" \
  https://production.example.test \
  "${release_tag}" \
  31 \
  0 >/dev/null 2>&1; then
  echo "Promotion qualification accepted an attempt count above its safety bound." >&2
  exit 1
fi

promotion_script="${repo_root}/deploy/scripts/promote-release.sh"
for promotion_guard in \
  'VESSEL_CALLER_PROMOTION_QUALIFICATION_ATTEMPTS:-6' \
  'VESSEL_CALLER_PROMOTION_QUALIFICATION_RETRY_SECONDS:-1' \
  'qualify-release-with-retry.sh'; do
  if ! grep -Fq -- "${promotion_guard}" "${promotion_script}"; then
    echo "Production promotion is missing bounded graceful-reload guard: ${promotion_guard}" >&2
    exit 1
  fi
done

printf 'tamper\n' >> "${archive}"
if REQUIRE_RELEASE_SIGNATURE=true \
  RELEASE_SIGNATURE_PUBLIC_KEY="${public_key}" \
  "${repo_root}/deploy/scripts/verify-release.sh" "${archive}" >/dev/null 2>&1; then
  echo "Tampered release unexpectedly verified." >&2
  exit 1
fi

qualification_workflow="${repo_root}/.github/workflows/qualification.yml"
deploy_workflow="${repo_root}/.github/workflows/deploy.yml"
preflight_block="${fixture_root}/qualification-preflight.yml"
awk '
  /^  preflight:/ { capture = 1 }
  /^  load:/ { capture = 0 }
  capture { print }
' "${qualification_workflow}" > "${preflight_block}"

# These are literal GitHub Actions/Bash source fragments, not shell expansions.
# shellcheck disable=SC2016
for required_guard in \
  'if [[ "${CURRENT_TAG}" == "${PREVIOUS_TAG}" ]]' \
  'if [[ "${current_commit}" == "${previous_commit}" ]]' \
  'gh attestation verify "${archive}"' \
  '-verify "${release_public_key}"' \
  '"vessel-caller-${tag}/RELEASE.json"'; do
  if ! grep -Fq -- "${required_guard}" "${preflight_block}"; then
    echo "Qualification preflight is missing required guard: ${required_guard}" >&2
    exit 1
  fi
done

for operator_control in \
  applicationResendJourneys \
  flexschoolsRegressionReviewed \
  operatorChecklistSigned \
  pitrPointInTimeRestore \
  privateSpacesApplicationAuthorization \
  productUatSigned \
  resendForcedFailureVisibility \
  resendRetryIdempotency \
  rpoMinutes \
  sentryBackendFrontendMetadataRedaction \
  sentryOnCallAcknowledged \
  stagingE2eAccountsProtected; do
  if ! grep -Fq -- "${operator_control}" "${qualification_workflow}"; then
    echo "Qualification is missing operator-evidence control: ${operator_control}" >&2
    exit 1
  fi
done

if grep -Eq 'stagingE2eAccounts(PreProvisioned|RevocationVerified)' \
  "${qualification_workflow}"; then
  echo "Qualification contains a temporally invalid staging E2E lifecycle assertion." >&2
  exit 1
fi

# These are literal GitHub Actions expressions, not shell expansions.
# shellcheck disable=SC2016
for deploy_guard in \
  'E2E_PASSWORD: ${{ secrets.STAGING_E2E_PASSWORD }}' \
  'OPERATOR_EVIDENCE_SIGNING_PUBLIC_KEY: ${{ vars.OPERATOR_EVIDENCE_SIGNING_PUBLIC_KEY }}' \
  'RELEASE_SIGNING_PUBLIC_KEY: ${{ vars.RELEASE_SIGNING_PUBLIC_KEY }}'; do
  if ! grep -Fq -- "${deploy_guard}" "${deploy_workflow}"; then
    echo "Deploy workflow is missing protected verification input: ${deploy_guard}" >&2
    exit 1
  fi
done

echo "Release verification, evidence fail-closed guards, and release-identity smoke tests passed."
