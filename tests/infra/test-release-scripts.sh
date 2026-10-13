#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_root="$(mktemp -d)"
trap 'rm -rf "${fixture_root}"' EXIT

entrypoint_link="${fixture_root}/vessel-caller-deploy"
ln -s "${repo_root}/deploy/scripts/deploy-release.sh" "${entrypoint_link}"
resolved_script_dir="$("${entrypoint_link}" --print-resolved-script-dir)"
if [[ "${resolved_script_dir}" != "${repo_root}/deploy/scripts" ]]; then
  echo "The installed symlink entrypoint did not resolve its helper directory." >&2
  exit 1
fi

python3 - "${repo_root}/deploy/scripts/snapshot-release.py" "${fixture_root}" <<'PY'
import importlib.util
import os
import sys
from pathlib import Path
from unittest import mock

module_path = Path(sys.argv[1])
fixture_root = Path(sys.argv[2]) / "snapshot-tests"
spec = importlib.util.spec_from_file_location("snapshot_release", module_path)
assert spec and spec.loader
snapshot_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(snapshot_release)


def fixture(label: str, archive_name: str = "vessel-caller-v1.2.3.tar.gz"):
    root = fixture_root / label
    source = root / "source"
    destination = root / "destination"
    source.mkdir(parents=True)
    destination.mkdir(mode=0o700)
    archive = source / archive_name
    archive.write_bytes(b"signed archive bytes")
    Path(f"{archive}.sha256").write_bytes(b"checksum bytes")
    Path(f"{archive}.sig").write_bytes(b"signature bytes")
    for path in (archive, Path(f"{archive}.sha256"), Path(f"{archive}.sig")):
        path.chmod(0o600)
    return source, destination, archive


def snapshot(source: Path, destination: Path, archive: Path):
    return snapshot_release.snapshot_release_inputs(
        archive,
        destination,
        source_directory=source,
        expected_source_uid=os.getuid(),
        expected_destination_uid=os.getuid(),
    )


source, destination, archive = fixture("stable")
snapshotted = snapshot(source, destination, archive)
archive.write_bytes(b"concurrent replacement")
Path(f"{archive}.sha256").write_bytes(b"replacement checksum")
Path(f"{archive}.sig").write_bytes(b"replacement signature")
assert snapshotted.read_bytes() == b"signed archive bytes"
assert Path(f"{snapshotted}.sha256").read_bytes() == b"checksum bytes"
assert Path(f"{snapshotted}.sig").read_bytes() == b"signature bytes"

for label, kind in (("symlink", "symlink"), ("fifo", "fifo"), ("hardlink", "hardlink")):
    source, destination, archive = fixture(label)
    candidate = Path(f"{archive}.sig")
    candidate.unlink()
    if kind == "symlink":
        candidate.symlink_to(Path(f"{archive}.sha256"))
    elif kind == "fifo":
        os.mkfifo(candidate, 0o600)
    else:
        os.link(Path(f"{archive}.sha256"), candidate)
    try:
        snapshot(source, destination, archive)
    except snapshot_release.SnapshotError:
        pass
    else:
        raise AssertionError(f"{kind} release input was accepted")

source, destination, archive = fixture("basename", "unexpected.tar.gz")
try:
    snapshot(source, destination, archive)
except snapshot_release.SnapshotError:
    pass
else:
    raise AssertionError("unexpected release basename was accepted")

source, destination, archive = fixture("in-place")
archive.write_bytes(b"x" * (2 * 1024 * 1024))
real_read = os.read
mutated = False


def mutate_during_read(fd: int, length: int) -> bytes:
    global mutated
    chunk = real_read(fd, length)
    if not mutated:
        mutated = True
        with archive.open("ab") as stream:
            stream.write(b"changed")
    return chunk


with mock.patch.object(snapshot_release.os, "read", side_effect=mutate_during_read):
    try:
        snapshot(source, destination, archive)
    except snapshot_release.SnapshotError:
        pass
    else:
        raise AssertionError("in-place mutation during snapshot was accepted")

print("Release input snapshot adversarial checks passed.")
PY

release_tag=v1.2.3
release_name="vessel-caller-${release_tag}"
payload="${fixture_root}/${release_name}"
archive="${fixture_root}/${release_name}.tar.gz"
mkdir -p "${payload}/backend/requirements" "${payload}/frontend/dist"
printf 'fixture\n' > "${payload}/backend/manage.py"
printf 'fixture\n' > "${payload}/backend/requirements/production.txt"
printf '<!doctype html><title>fixture</title>\n' > "${payload}/frontend/dist/index.html"
printf '{"schemaVersion":1,"application":"vessel-caller","release":"%s","organizationApprovalLifecycle":true,"temporaryPasswordLifecycle":true,"stagingOnlySchemaCutover":true,"immutable":true}\n' "${release_tag}" > "${payload}/RELEASE.json"
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

# CI and the host share this check after signature verification. The current
# lifecycle artifact is deliberately staging-only.
# shellcheck source=deploy/scripts/release-target-policy.sh
source "${repo_root}/deploy/scripts/release-target-policy.sh"
enforce_release_target_policy staging "${archive}"
if enforce_release_target_policy production "${archive}" >/dev/null 2>&1; then
  echo "A staging-only schema cutover artifact was accepted for production." >&2
  exit 1
fi

# The host persists an irreversible floor before the first lifecycle cutover.
# Mock Linux ownership probes so this behavioral check also runs on macOS.
read_staging_lifecycle_state() {
  printf 'absent\n'
}
read_staging_temporary_password_lifecycle_state() {
  printf 'absent\n'
}
policy_bin="${fixture_root}/policy-bin"
mkdir -p "${policy_bin}"
cat > "${policy_bin}/stat" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
target="${!#}"
format="${2}"
if [[ "${FAKE_UNTRUSTED_STAT_TARGET:-}" == "${target}" ]]; then
  printf 'root:root:666\n'
  exit 0
fi
if [[ "${format}" == '%U' ]]; then printf 'root\n'; exit 0; fi
if [[ "${format}" == '%a' ]]; then
  if [[ -d "${target}" ]]; then printf '755\n'; else printf '644\n'; fi
  exit 0
fi
case "${target}" in
  */runtime/staging.env) printf 'root:vessel-caller-staging:640\n'; exit 0 ;;
  */libpq-env.sh) printf 'root:root:755\n'; exit 0 ;;
  */lifecycle-work) printf 'vessel-caller-staging:vessel-caller-staging:750\n'; exit 0 ;;
esac
if [[ -d "${target}" ]]; then
  printf 'root:root:755\n'
else
  printf 'root:root:644\n'
fi
EOF
cat > "${policy_bin}/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod 0755 "${policy_bin}/stat" "${policy_bin}/chown"

legacy_tag=v1.2.2
legacy_name="vessel-caller-${legacy_tag}"
legacy_root="${fixture_root}/legacy/${legacy_name}"
legacy_archive="${fixture_root}/${legacy_name}.tar.gz"
mkdir -p "${legacy_root}"
printf '{"schemaVersion":1,"application":"vessel-caller","release":"%s","immutable":true}\n' \
  "${legacy_tag}" > "${legacy_root}/RELEASE.json"
tar -C "${fixture_root}/legacy" -czf "${legacy_archive}" "${legacy_name}"

successful_marker_root="${fixture_root}/successful-floor"
successful_marker="${successful_marker_root}/cutover"
mkdir -p "${successful_marker_root}"
PATH="${policy_bin}:${PATH}" enforce_staging_compatibility_floor "${archive}" "${successful_marker}"
if PATH="${policy_bin}:${PATH}" \
  enforce_staging_compatibility_floor "${legacy_archive}" "${successful_marker}" \
  >/dev/null 2>&1; then
  echo "A successful approval-lifecycle cutover allowed a legacy staging release." >&2
  exit 1
fi

failed_marker_root="${fixture_root}/failed-floor"
failed_marker="${failed_marker_root}/cutover"
mkdir -p "${failed_marker_root}"
PATH="${policy_bin}:${PATH}" enforce_staging_compatibility_floor "${archive}" "${failed_marker}"
# Model a failed post-marker cutover: the marker must survive and permit only a
# compatible retry while writers remain fail-closed.
PATH="${policy_bin}:${PATH}" enforce_staging_compatibility_floor "${archive}" "${failed_marker}"
if PATH="${policy_bin}:${PATH}" \
  enforce_staging_compatibility_floor "${legacy_archive}" "${failed_marker}" \
  >/dev/null 2>&1; then
  echo "A failed approval-lifecycle cutover allowed a legacy staging release." >&2
  exit 1
fi

# A replacement host reconstructs its local marker from authoritative database
# migration state and still refuses a legacy writer.
rebuilt_marker_root="${fixture_root}/rebuilt-floor"
rebuilt_marker="${rebuilt_marker_root}/cutover"
mkdir -p "${rebuilt_marker_root}"
read_staging_lifecycle_state() {
  printf 'present\n'
}
if PATH="${policy_bin}:${PATH}" \
  enforce_staging_compatibility_floor "${legacy_archive}" "${rebuilt_marker}" \
  >/dev/null 2>&1; then
  echo "A rebuilt host accepted a legacy release after the lifecycle migration." >&2
  exit 1
fi
PATH="${policy_bin}:${PATH}" \
  enforce_staging_compatibility_floor "${archive}" "${rebuilt_marker}"
[[ "$(<"${rebuilt_marker}")" == "organizationApprovalLifecycle=true" ]]

# The previous organization-compatible backend is valid before the temporary
# credential cutover, but must never return once either new floor is present.
prior_tag=v1.2.2-staging.previous
prior_name="vessel-caller-${prior_tag}"
prior_root="${fixture_root}/prior/${prior_name}"
prior_archive="${fixture_root}/${prior_name}.tar.gz"
mkdir -p "${prior_root}"
printf '{"schemaVersion":1,"application":"vessel-caller","release":"%s","organizationApprovalLifecycle":true,"stagingOnlySchemaCutover":true}\n' \
  "${prior_tag}" > "${prior_root}/RELEASE.json"
tar -C "${fixture_root}/prior" -czf "${prior_archive}" "${prior_name}"
temporary_root="${fixture_root}/temporary-floor"
temporary_marker="${temporary_root}/cutover"
mkdir -p "${temporary_root}"
PATH="${policy_bin}:${PATH}" enforce_staging_temporary_password_compatibility_floor "${prior_archive}" "${temporary_marker}"
[[ ! -e "${temporary_marker}" ]]
PATH="${policy_bin}:${PATH}" enforce_staging_temporary_password_compatibility_floor "${archive}" "${temporary_marker}"
[[ "$(<"${temporary_marker}")" == "temporaryPasswordLifecycle=true" ]]
# A failed cutover retains the marker and only permits a compatible retry.
PATH="${policy_bin}:${PATH}" enforce_staging_temporary_password_compatibility_floor "${archive}" "${temporary_marker}"
if PATH="${policy_bin}:${PATH}" enforce_staging_temporary_password_compatibility_floor "${prior_archive}" "${temporary_marker}" >/dev/null 2>&1; then
  echo "Temporary-password cutover accepted the previous backend." >&2; exit 1
fi
read_staging_temporary_password_lifecycle_state() { printf 'present\n'; }
rebuilt_temporary_marker="${temporary_root}/rebuilt-cutover"
if PATH="${policy_bin}:${PATH}" enforce_staging_temporary_password_compatibility_floor "${prior_archive}" "${rebuilt_temporary_marker}" >/dev/null 2>&1; then
  echo "A rebuilt host accepted the previous backend after accounts0007." >&2; exit 1
fi
PATH="${policy_bin}:${PATH}" enforce_staging_temporary_password_compatibility_floor "${archive}" "${rebuilt_temporary_marker}"
[[ "$(<"${rebuilt_temporary_marker}")" == "temporaryPasswordLifecycle=true" ]]
if FAKE_UNTRUSTED_STAT_TARGET="${temporary_marker}" PATH="${policy_bin}:${PATH}" \
  enforce_staging_temporary_password_compatibility_floor "${archive}" "${temporary_marker}" >/dev/null 2>&1; then
  echo "An untrusted temporary-password marker was accepted." >&2; exit 1
fi
ln -s "${temporary_marker}" "${temporary_root}/symlink-cutover"
if PATH="${policy_bin}:${PATH}" enforce_staging_temporary_password_compatibility_floor "${archive}" "${temporary_root}/symlink-cutover" >/dev/null 2>&1; then
  echo "A symlink temporary-password marker was accepted." >&2; exit 1
fi
read_staging_temporary_password_lifecycle_state() { printf 'unknown\n'; }
if PATH="${policy_bin}:${PATH}" enforce_staging_temporary_password_compatibility_floor "${archive}" "${temporary_root}/unknown-cutover" >/dev/null 2>&1; then
  echo "Unknown temporary-password migration state failed open." >&2; exit 1
fi
read_staging_temporary_password_lifecycle_state() { return 1; }
if PATH="${policy_bin}:${PATH}" enforce_staging_temporary_password_compatibility_floor "${archive}" "${temporary_root}/unavailable-cutover" >/dev/null 2>&1; then
  echo "Unavailable temporary-password migration state failed open." >&2; exit 1
fi

# Exercise the real process-start guard with a fixture-only state helper. This
# proves that a manually restored old symlink cannot bypass the durable floor.
guard_root="${fixture_root}/process-guard"
mkdir -p "${guard_root}/releases/${prior_tag}/staging" "${guard_root}/releases/${release_tag}/staging" "${guard_root}/markers"
guard_root="$(cd "${guard_root}" && pwd -P)"
cp "${prior_root}/RELEASE.json" "${guard_root}/releases/${prior_tag}/staging/RELEASE.json"
cp "${payload}/RELEASE.json" "${guard_root}/releases/${release_tag}/staging/RELEASE.json"
cat > "${guard_root}/state.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-organization}" in
  organization) printf '%s\n' "${FAKE_ORGANIZATION_LIFECYCLE:-present}" ;;
  temporary-password) printf '%s\n' "${FAKE_TEMPORARY_PASSWORD_LIFECYCLE:-absent}" ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 "${guard_root}/state.sh"
python3 - "${repo_root}/deploy/scripts/staging-compatibility-guard.sh" "${guard_root}" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[2])
source = Path(sys.argv[1]).read_text()
source = source.replace('/usr/local/lib/vessel-caller/staging-lifecycle-state.sh', str(root / 'state.sh'))
(root / 'guard.sh').write_text(source)
PY
guard_organization_marker="${guard_root}/markers/organization"
guard_temporary_marker="${guard_root}/markers/temporary"
ln -s "${guard_root}/releases/${prior_tag}/staging" "${guard_root}/current"
run_start_guard() {
  PATH="${policy_bin}:${PATH}" bash "${guard_root}/guard.sh" "${guard_organization_marker}" \
    "${guard_root}/current" "${guard_root}/releases" "${guard_temporary_marker}"
}
run_start_guard
if FAKE_TEMPORARY_PASSWORD_LIFECYCLE=present run_start_guard >/dev/null 2>&1; then
  echo "Previous backend start bypassed the accounts0007 ledger floor." >&2; exit 1
fi
printf 'temporaryPasswordLifecycle=true\n' > "${guard_temporary_marker}"
if run_start_guard >/dev/null 2>&1; then
  echo "Previous backend start bypassed the durable temporary-password marker." >&2; exit 1
fi
rm "${guard_root}/current"
ln -s "${guard_root}/releases/${release_tag}/staging" "${guard_root}/current"
run_start_guard
rm "${guard_temporary_marker}"
FAKE_TEMPORARY_PASSWORD_LIFECYCLE=present run_start_guard
if FAKE_TEMPORARY_PASSWORD_LIFECYCLE=unknown run_start_guard >/dev/null 2>&1; then
  echo "Process guard accepted an unknown temporary-password migration state." >&2; exit 1
fi
if FAKE_ORGANIZATION_LIFECYCLE=unknown run_start_guard >/dev/null 2>&1; then
  echo "Process guard weakened the original organization lifecycle floor." >&2; exit 1
fi

# Exercise both fixed migration queries in the actual ledger helper. Replaced
# fixture paths and a psql stub ensure this test never opens a real database.
mkdir -p "${guard_root}/runtime" "${guard_root}/lifecycle-work"
: > "${guard_root}/runtime/staging.env"
cat > "${guard_root}/libpq-env.sh" <<'EOF'
configure_libpq_from_env() { :; }
EOF
cat > "${policy_bin}/psql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${!#}" in
  *"to_regclass('django_migrations')"*) printf '%s\n' "${FAKE_LEDGER_TABLE_STATE:-present}" ;;
  *"app = 'organizations' AND name = '0004_organization_approval_lifecycle'"*) printf '%s\n' "${FAKE_ORGANIZATION_LIFECYCLE:-present}" ;;
  *"app = 'accounts' AND name = '0007_user_admin_provisioned_at_user_admin_provisioned_by_and_more'"*) printf '%s\n' "${FAKE_TEMPORARY_PASSWORD_LIFECYCLE:-absent}" ;;
  *) echo 'Unexpected SQL query' >&2; exit 1 ;;
esac
EOF
chmod 0755 "${policy_bin}/psql"
python3 - "${repo_root}/deploy/scripts/staging-lifecycle-state.sh" "${guard_root}" <<'PY'
from pathlib import Path
import sys
root = Path(sys.argv[2])
source = Path(sys.argv[1]).read_text()
for old, new in {
    '/etc/vessel-caller': str(root / 'runtime'),
    '/usr/local/lib/vessel-caller/libpq-env.sh': str(root / 'libpq-env.sh'),
    '/var/lib/vessel-caller/staging': str(root / 'lifecycle-work'),
}.items():
    source = source.replace(old, new)
(root / 'ledger-state.sh').write_text(source)
PY
run_ledger_state() { PATH="${policy_bin}:${PATH}" bash "${guard_root}/ledger-state.sh" "$@"; }
[[ "$(run_ledger_state)" == present ]]
[[ "$(FAKE_ORGANIZATION_LIFECYCLE=absent run_ledger_state)" == absent ]]
[[ "$(run_ledger_state temporary-password)" == absent ]]
[[ "$(FAKE_TEMPORARY_PASSWORD_LIFECYCLE=present run_ledger_state temporary-password)" == present ]]
[[ "$(FAKE_LEDGER_TABLE_STATE=absent run_ledger_state temporary-password)" == absent ]]
if FAKE_TEMPORARY_PASSWORD_LIFECYCLE=unknown run_ledger_state temporary-password >/dev/null 2>&1; then
  echo "Ledger helper accepted invalid temporary-password migration state." >&2; exit 1
fi
if run_ledger_state arbitrary-query >/dev/null 2>&1 || run_ledger_state temporary-password extra >/dev/null 2>&1; then
  echo "Ledger helper accepted an unrestricted or extra query selector." >&2; exit 1
fi

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
