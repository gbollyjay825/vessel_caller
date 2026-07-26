#!/usr/bin/env bash
set -euo pipefail

source_database="${1:-}"
destination_dir="${2:-.backups}"

if [[ -z "${source_database}" || ! -f "${source_database}" ]]; then
  echo "Usage: $0 <legacy.sqlite3> [destination-directory]" >&2
  exit 2
fi
for command in sqlite3 sha256sum; do
  if ! command -v "${command}" >/dev/null; then
    echo "Required command is unavailable: ${command}" >&2
    exit 1
  fi
done

install -d -m 0700 "${destination_dir}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="${destination_dir}/vessel-caller-legacy-${timestamp}.sqlite3"

# SQLite's online backup API includes committed WAL content without copying a
# live database/WAL pair independently.
sqlite3 "${source_database}" ".timeout 30000" ".backup '${backup}'"
integrity="$(sqlite3 "${backup}" 'PRAGMA integrity_check;')"
if [[ "${integrity}" != "ok" ]]; then
  rm -f "${backup}"
  echo "Backup integrity check failed: ${integrity}" >&2
  exit 1
fi
(
  cd "${destination_dir}"
  sha256sum "$(basename "${backup}")" > "$(basename "${backup}").sha256"
)

if [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  age --recipient "${BACKUP_AGE_RECIPIENT}" --output "${backup}.age" "${backup}"
  (
    cd "${destination_dir}"
    sha256sum "$(basename "${backup}").age" > "$(basename "${backup}").age.sha256"
  )
  rm -f "${backup}" "${backup}.sha256"
  backup="${backup}.age"
fi

echo "${backup}"
