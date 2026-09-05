#!/usr/bin/env bash
set -euo pipefail

# The database migration ledger is the authoritative compatibility floor. The
# local marker is only a durable cache and may be absent after a host rebuild.
config_root=/etc/vessel-caller
runtime_env="${config_root}/staging.env"
libpq_helper=/usr/local/lib/vessel-caller/libpq-env.sh

if [[ ! -d "${config_root}" || -L "${config_root}" ]] \
  || [[ "$(stat -c '%U:%G:%a' "${config_root}")" != root:root:755 ]] \
  || [[ ! -f "${runtime_env}" || -L "${runtime_env}" ]] \
  || [[ "$(stat -c '%U:%G:%a' "${runtime_env}")" != root:vessel-caller-staging:640 ]] \
  || [[ ! -f "${libpq_helper}" || -L "${libpq_helper}" ]] \
  || [[ "$(stat -c '%U:%G:%a' "${libpq_helper}")" != root:root:755 ]]; then
  echo "The staging lifecycle-state inputs are not trusted." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${runtime_env}"
set +a
# shellcheck source=deploy/scripts/libpq-env.sh
source "${libpq_helper}"

state_root_base=/var/lib/vessel-caller/staging
if [[ ! -d "${state_root_base}" || -L "${state_root_base}" ]] \
  || [[ "$(stat -c '%U:%G:%a' "${state_root_base}")" != vessel-caller-staging:vessel-caller-staging:750 ]]; then
  echo "The staging lifecycle-state work directory is not trusted." >&2
  exit 1
fi
state_root="$(mktemp -d "${state_root_base}/.lifecycle-state.XXXXXX")"
cleanup_state_root() {
  if [[ "${state_root}" != /var/lib/vessel-caller/staging/.lifecycle-state.* ]] \
    || [[ ! -d "${state_root}" ]] \
    || [[ -L "${state_root}" ]]; then
    echo "Refusing to remove an unexpected lifecycle-state path." >&2
    return 1
  fi
  rm -rf -- "${state_root}"
}
trap cleanup_state_root EXIT

configure_libpq_from_env VC_DATABASE_URL "${state_root}"
ledger_state="$(
  PGCONNECT_TIMEOUT=5 psql \
    --no-psqlrc \
    --quiet \
    --tuples-only \
    --no-align \
    --set ON_ERROR_STOP=1 \
    --command "SELECT CASE WHEN to_regclass('django_migrations') IS NULL THEN 'absent' ELSE 'present' END;"
)"
if [[ "${ledger_state}" == absent ]]; then
  printf 'absent\n'
  exit 0
fi
if [[ "${ledger_state}" != present ]]; then
  echo "The staging migration-ledger query returned an invalid result." >&2
  exit 1
fi
state="$(
  PGCONNECT_TIMEOUT=5 psql \
    --no-psqlrc \
    --quiet \
    --tuples-only \
    --no-align \
    --set ON_ERROR_STOP=1 \
    --command "SELECT CASE WHEN EXISTS (SELECT 1 FROM django_migrations WHERE app = 'organizations' AND name = '0004_organization_approval_lifecycle') THEN 'present' ELSE 'absent' END;"
)"
case "${state}" in
  present|absent) printf '%s\n' "${state}" ;;
  *)
    echo "The staging lifecycle-state query returned an invalid result." >&2
    exit 1
    ;;
esac
