#!/usr/bin/env bash
set -euo pipefail

: "${VC_DATABASE_URL:?VC_DATABASE_URL is required}"
: "${BACKUP_AGE_RECIPIENT:?BACKUP_AGE_RECIPIENT is required}"
: "${BACKUP_SPACES_BUCKET:?BACKUP_SPACES_BUCKET is required}"
: "${BACKUP_SPACES_ENDPOINT:?BACKUP_SPACES_ENDPOINT is required}"

backup_root="${BACKUP_LOCAL_DIR:-/var/lib/vessel-caller/backups}"
install -d -m 0700 "${backup_root}"
plain=""
encrypted=""
PGPASSFILE=""
snapshot_pid=""
snapshot_output=""
cleanup() {
  rm -f "${plain}" "${encrypted}.partial" "${PGPASSFILE}"
  rm -f "${snapshot_output}"
  if [[ -n "${snapshot_pid}" ]] && kill -0 "${snapshot_pid}" 2>/dev/null; then
    kill "${snapshot_pid}" 2>/dev/null || true
    wait "${snapshot_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deploy/scripts/libpq-env.sh
source "${script_dir}/libpq-env.sh"
configure_libpq_from_env VC_DATABASE_URL "${backup_root}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
basename="vessel-caller-${timestamp}.dump"
plain="${backup_root}/${basename}"
encrypted="${plain}.age"
checksum="${encrypted}.sha256"
manifest="${encrypted}.manifest.json"
manifest_checksum="${manifest}.sha256"
remote_prefix="${BACKUP_REMOTE_PREFIX:-database/daily}"

snapshot_output="${backup_root}/.snapshot-${timestamp}"
stdbuf --output=L psql \
  --no-psqlrc \
  --quiet \
  --tuples-only \
  --no-align \
  --set ON_ERROR_STOP=1 \
  --command \
  "BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT pg_export_snapshot(); SELECT pg_sleep(1800);" \
  > "${snapshot_output}" &
snapshot_pid="$!"
snapshot=""
for _ in $(seq 1 100); do
  snapshot="$(sed -n '/[^[:space:]]/ { p; q; }' "${snapshot_output}")"
  [[ -n "${snapshot}" ]] && break
  if ! kill -0 "${snapshot_pid}" 2>/dev/null; then
    echo "PostgreSQL snapshot holder exited before exporting a snapshot." >&2
    exit 1
  fi
  sleep 0.1
done
if [[ -z "${snapshot}" ]]; then
  echo "Timed out waiting for PostgreSQL to export a backup snapshot." >&2
  exit 1
fi

pg_dump \
  --snapshot="${snapshot}" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-privileges \
  --file="${plain}"
pg_restore --list "${plain}" >/dev/null
PGSNAPSHOT="${snapshot}" "${script_dir}/database-manifest.sh" > "${manifest}"
jq --exit-status \
  '.schemaVersion == 1 and
   ([.foreignKeyOrphans[]] | all(. == 0))' \
  "${manifest}" >/dev/null
kill "${snapshot_pid}" 2>/dev/null || true
wait "${snapshot_pid}" 2>/dev/null || true
snapshot_pid=""
age --recipient "${BACKUP_AGE_RECIPIENT}" --output "${encrypted}.partial" "${plain}"
mv "${encrypted}.partial" "${encrypted}"
(
  cd "${backup_root}"
  sha256sum "$(basename "${encrypted}")" > "$(basename "${checksum}")"
  sha256sum "$(basename "${manifest}")" > "$(basename "${manifest_checksum}")"
)

aws \
  --endpoint-url "${BACKUP_SPACES_ENDPOINT}" \
  s3 cp "${encrypted}" "s3://${BACKUP_SPACES_BUCKET}/${remote_prefix}/${basename}.age" \
  --only-show-errors
aws \
  --endpoint-url "${BACKUP_SPACES_ENDPOINT}" \
  s3 cp "${manifest}" "s3://${BACKUP_SPACES_BUCKET}/${remote_prefix}/${basename}.age.manifest.json" \
  --only-show-errors
aws \
  --endpoint-url "${BACKUP_SPACES_ENDPOINT}" \
  s3 cp "${manifest_checksum}" "s3://${BACKUP_SPACES_BUCKET}/${remote_prefix}/${basename}.age.manifest.json.sha256" \
  --only-show-errors
aws \
  --endpoint-url "${BACKUP_SPACES_ENDPOINT}" \
  s3 cp "${checksum}" "s3://${BACKUP_SPACES_BUCKET}/${remote_prefix}/${basename}.age.sha256" \
  --only-show-errors

touch "${backup_root}/last-success"
find "${backup_root}" -type f -mtime +2 ! -name last-success -delete
logger --tag vessel-caller-backup "Uploaded encrypted PostgreSQL backup ${basename}.age"
