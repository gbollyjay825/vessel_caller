#!/usr/bin/env bash
set -euo pipefail

source_uri="${1:-}"
target_environment="${2:-}"
confirmation="${3:-}"

if [[ -z "${source_uri}" || "${confirmation}" != "--confirm-restore" ]]; then
  echo "Usage: $0 <s3://bucket/object.dump.age> <drill|staging|production> --confirm-restore" >&2
  exit 2
fi
case "${target_environment}" in
  drill|staging|production) ;;
  *)
    echo "Restore target must be explicitly declared as drill, staging, or production." >&2
    exit 2
    ;;
esac
: "${RESTORE_TARGET_ENVIRONMENT:?RESTORE_TARGET_ENVIRONMENT is required}"
: "${RESTORE_TARGET_DATABASE_URL:?RESTORE_TARGET_DATABASE_URL is required}"
: "${TARGET_DATABASE_URL_SHA256:?TARGET_DATABASE_URL_SHA256 is required}"
: "${PRODUCTION_DATABASE_URL_SHA256:?PRODUCTION_DATABASE_URL_SHA256 is required}"
if [[ "${RESTORE_TARGET_ENVIRONMENT}" != "${target_environment}" ]]; then
  echo "Declared target does not match the operator-approved restore environment." >&2
  exit 1
fi
actual_target_hash="$(printf '%s' "${RESTORE_TARGET_DATABASE_URL}" | sha256sum | awk '{print $1}')"
if [[ "${actual_target_hash}" != "${TARGET_DATABASE_URL_SHA256}" ]]; then
  echo "Target database URL does not match the independently approved target hash." >&2
  exit 1
fi
if [[ "${actual_target_hash}" == "${PRODUCTION_DATABASE_URL_SHA256}" ]] \
  && [[ "${target_environment}" != "production" ]]; then
  echo "The target is the registered production database but was not declared production." >&2
  exit 1
fi
if [[ "${target_environment}" == "production" ]] \
  && [[ "${actual_target_hash}" != "${PRODUCTION_DATABASE_URL_SHA256}" ]]; then
  echo "The declared production restore target is not the registered production database." >&2
  exit 1
fi
if [[ "${target_environment}" == "production" ]]; then
  : "${RESTORE_CHANGE_ID:?RESTORE_CHANGE_ID is required for production}"
  : "${ALLOW_PRODUCTION_RESTORE_CHANGE_ID:?ALLOW_PRODUCTION_RESTORE_CHANGE_ID is required for production}"
  if [[ "${RESTORE_CHANGE_ID}" != "${ALLOW_PRODUCTION_RESTORE_CHANGE_ID}" ]]; then
    echo "Production restore change approval does not match this operation." >&2
    exit 1
  fi
fi
: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE is required}"
: "${BACKUP_SPACES_ENDPOINT:?BACKUP_SPACES_ENDPOINT is required}"
if [[ ! -f "${BACKUP_AGE_IDENTITY_FILE}" || ! -r "${BACKUP_AGE_IDENTITY_FILE}" ]]; then
  echo "Age identity file is missing or unreadable." >&2
  exit 1
fi
identity_mode="$(stat -c %a "${BACKUP_AGE_IDENTITY_FILE}")"
if (( (8#${identity_mode} & 8#077) != 0 )); then
  echo "Age identity file must not be accessible by group or other users." >&2
  exit 1
fi

restore_root="$(mktemp -d)"
trap 'rm -rf "${restore_root}"' EXIT
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/libpq-env.sh
source "${script_dir}/libpq-env.sh"
configure_libpq_from_env RESTORE_TARGET_DATABASE_URL "${restore_root}"
remote_name="${source_uri##*/}"
if [[ "${remote_name}" != *.dump.age ]]; then
  echo "Backup object must end in .dump.age." >&2
  exit 1
fi
encrypted="${restore_root}/${remote_name}"
checksum="${encrypted}.sha256"
plain="${restore_root}/${remote_name%.age}"
expected_manifest="${encrypted}.manifest.json"
manifest_checksum="${expected_manifest}.sha256"
actual_manifest="${restore_root}/actual.manifest.json"

aws --endpoint-url "${BACKUP_SPACES_ENDPOINT}" s3 cp "${source_uri}" "${encrypted}" --only-show-errors
aws --endpoint-url "${BACKUP_SPACES_ENDPOINT}" s3 cp "${source_uri}.sha256" "${checksum}" --only-show-errors
aws --endpoint-url "${BACKUP_SPACES_ENDPOINT}" s3 cp "${source_uri}.manifest.json" "${expected_manifest}" --only-show-errors
aws --endpoint-url "${BACKUP_SPACES_ENDPOINT}" s3 cp "${source_uri}.manifest.json.sha256" "${manifest_checksum}" --only-show-errors
(
  cd "${restore_root}"
  sha256sum --check "$(basename "${checksum}")"
)
(
  cd "${restore_root}"
  sha256sum --check "$(basename "${manifest_checksum}")"
)
age --decrypt --identity "${BACKUP_AGE_IDENTITY_FILE}" --output "${plain}" "${encrypted}"
pg_restore --list "${plain}" >/dev/null
pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exit-on-error \
  "${plain}"
"${script_dir}/database-manifest.sh" > "${actual_manifest}"
if ! diff -u \
  <(jq --sort-keys . "${expected_manifest}") \
  <(jq --sort-keys . "${actual_manifest}"); then
  echo "Restored database does not match the source reconciliation manifest." >&2
  exit 1
fi
echo "Restore and database reconciliation completed; run release-specific application checks."
