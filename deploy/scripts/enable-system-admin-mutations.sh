#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "System Admin mutation enablement must run as root." >&2
  exit 1
fi

target="${1:-}"
expected_tag="${2:-}"
expected_sha="${3:-}"
expected_resend_key_sha="${4:-}"
expected_email_from_sha="${5:-}"
if [[ ! "${expected_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] \
  || [[ ! "${expected_sha}" =~ ^[0-9a-f]{40}$ ]] \
  || [[ ! "${expected_resend_key_sha}" =~ ^[0-9a-f]{64}$ ]] \
  || [[ ! "${expected_email_from_sha}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Qualified release identity and protected provider fingerprints are required." >&2
  exit 2
fi

app_root=/opt/vessel-caller
config_root=/etc/vessel-caller
state_root=/var/lib/vessel-caller
case "${target}" in
  staging)
    runtime_user=vessel-caller-staging
    runtime_group=vessel-caller-staging
    runtime_environment=staging
    runtime_env="${config_root}/staging.env"
    release_root="${app_root}/slots/staging/current"
    flag_file="${config_root}/system-admin-mutations-staging.flag"
    slot_roots=("${app_root}/slots/staging")
    slot_mode=751
    probe_ports=(8010)
    probe_host=staging.vesselcalls.com
    web_units=(vessel-caller-staging-web.service)
    worker_unit=vessel-caller-staging-worker.service
    ;;
  production)
    runtime_user=vessel-caller-production
    runtime_group=vessel-caller-production
    runtime_environment=production
    runtime_env="${config_root}/production-blue.env"
    release_root="${app_root}/slots/production-blue/current"
    flag_file="${config_root}/system-admin-mutations-production.flag"
    slot_roots=(
      "${app_root}/slots/production-blue"
      "${app_root}/slots/production-green"
    )
    slot_mode=750
    probe_ports=(8001 8002)
    probe_host=vesselcalls.com
    web_units=(
      vessel-caller-web@production-blue.service
      vessel-caller-web@production-green.service
    )
    worker_unit=""
    ;;
  *)
    echo "Usage: $0 <staging|production> <qualified-tag> <qualified-sha> <key-sha> <sender-sha>" >&2
    exit 2
    ;;
esac

if [[ ! -f "${flag_file}" || -L "${flag_file}" ]] \
  || [[ "$(stat -c '%U:%G:%a' "${flag_file}")" != "root:${runtime_group}:640" ]] \
  || [[ "$(cat "${flag_file}")" != disabled ]]; then
  echo "The environment-specific mutation flag must already be fail-closed." >&2
  exit 1
fi

exec 9>/run/lock/vessel-caller-release.lock
if ! flock --exclusive --wait 30 9; then
  echo "A release operation is active; System Admin mutations remain disabled." >&2
  exit 1
fi

for slot_root in "${slot_roots[@]}"; do
  current_link="${slot_root}/current"
  slot_name="$(basename "${slot_root}")"
  expected_target="${app_root}/releases/${expected_tag}/${slot_name}"
  if [[ ! -d "${slot_root}" || -L "${slot_root}" ]] \
    || [[ "$(stat -c '%U:%G:%a' "${slot_root}")" \
      != "root:${runtime_group}:${slot_mode}" ]] \
    || [[ ! -L "${current_link}" ]] \
    || [[ "$(stat -c '%U' "${current_link}")" != root ]] \
    || [[ "$(readlink -f -- "${current_link}")" != "${expected_target}" ]]; then
    echo "A release slot is not an exact root-owned qualified target." >&2
    exit 1
  fi
done

if [[ "${target}" == production ]]; then
  active_port="$(
    awk '/^server / {gsub(/[;:]/, " ", $0); print $3}' \
      /etc/nginx/vessel-caller/active-upstream.conf 2>/dev/null || true
  )"
  case "${active_port}" in
    8001) worker_unit=vessel-caller-worker@production-blue.service ;;
    8002) worker_unit=vessel-caller-worker@production-green.service ;;
    *)
      echo "The active production worker cannot be resolved safely." >&2
      exit 1
      ;;
  esac
fi

probe_qualified_slots() {
  local port response
  for port in "${probe_ports[@]}"; do
    if ! response="$(
      curl \
        --fail \
        --silent \
        --show-error \
        --max-time 5 \
        --header "Host: ${probe_host}" \
        --header "X-Forwarded-Proto: https" \
        "http://127.0.0.1:${port}/api/readiness"
    )"; then
      echo "A required System Admin rollback slot is not ready." >&2
      return 1
    fi
    if ! jq \
      --exit-status \
      --arg tag "${expected_tag}" \
      --arg sha "${expected_sha}" \
      '.status == "ready"
       and .release.tag == $tag
       and .release.sha == $sha
       and .capabilities.organizationAccessStatus == true
       and .capabilities.systemAdminEmailDeliveryReady == true' \
      <<<"${response}" >/dev/null; then
      echo "A required rollback slot does not match the qualified status-aware release." >&2
      return 1
    fi
  done
}

require_process_email_delivery() {
  local unit_name="${1}"
  local process_pid process_environment effective_configuration
  if ! systemctl is-active --quiet "${unit_name}"; then
    echo "A required email-capable process is not running." >&2
    return 1
  fi
  process_pid="$(systemctl show --property=MainPID --value "${unit_name}")"
  process_environment="/proc/${process_pid}/environ"
  if [[ ! "${process_pid}" =~ ^[0-9]+$ ]] || [[ "${process_pid}" -le 1 ]] \
    || [[ ! -r "${process_environment}" ]]; then
    echo "A required process environment cannot be verified." >&2
    return 1
  fi
  if ! effective_configuration="$(
    /usr/bin/python3 -c '
import hashlib
import pathlib
import sys

values = {}
for entry in pathlib.Path(sys.argv[1]).read_bytes().split(b"\0"):
    if b"=" in entry:
        key, value = entry.split(b"=", 1)
        values[key] = value
backend = values.get(b"VC_EMAIL_DELIVERY_BACKEND", b"").decode("ascii", "replace")
key_sha = hashlib.sha256(values.get(b"VC_RESEND_API_KEY", b"")).hexdigest()
sender_sha = hashlib.sha256(values.get(b"VC_EMAIL_FROM", b"")).hexdigest()
print(backend, key_sha, sender_sha)
' "${process_environment}"
  )"; then
    echo "A required process environment could not be fingerprinted." >&2
    return 1
  fi
  if [[ "${effective_configuration}" \
    != "resend ${expected_resend_key_sha} ${expected_email_from_sha}" ]]; then
    echo "A required process has stale or disabled Resend configuration." >&2
    return 1
  fi
}

require_runtime_email_delivery() {
  local web_unit
  for web_unit in "${web_units[@]}"; do
    require_process_email_delivery "${web_unit}"
  done
  require_process_email_delivery "${worker_unit}"
}

release_env="${release_root}/RELEASE.env"
python="${release_root}/backend/.venv/bin/python"
manage="${release_root}/backend/manage.py"
for required_path in "${runtime_env}" "${release_env}" "${manage}"; do
  if [[ ! -f "${required_path}" || -L "${required_path}" ]]; then
    echo "The exact qualified runtime is incomplete or contains an unsafe link." >&2
    exit 1
  fi
  required_owner="$(stat -c '%U' "${required_path}")"
  required_mode="$(stat -c '%a' "${required_path}")"
  if [[ "${required_owner}" != root ]] || (( (8#${required_mode} & 8#22) != 0 )); then
    echo "The exact qualified runtime contains a non-root-owned or writable control file." >&2
    exit 1
  fi
done

# Python virtual environments intentionally install bin/python as a symlink.
# Keep invoking that path so Python selects the release's venv, but trust it
# only when its fully resolved interpreter is a root-owned, non-writable file.
if [[ ! -x "${python}" ]]; then
  echo "The exact qualified runtime does not contain an executable Python environment." >&2
  exit 1
fi
resolved_python="$(readlink -f -- "${python}")"
if [[ -z "${resolved_python}" || ! -f "${resolved_python}" || -L "${resolved_python}" ]] \
  || [[ "$(stat -c '%U' "${resolved_python}")" != root ]] \
  || (( (8#$(stat -c '%a' "${resolved_python}") & 8#22) != 0 )); then
  echo "The release Python interpreter does not resolve to a trusted system file." >&2
  exit 1
fi

probe_qualified_slots
require_runtime_email_delivery

set +e
evidence="$({
  /usr/bin/systemd-run \
    --quiet \
    --wait \
    --pipe \
    --collect \
    --service-type=exec \
    "--unit=vessel-caller-system-admin-preflight-${target}" \
    "--uid=${runtime_user}" \
    "--gid=${runtime_group}" \
    "--working-directory=${release_root}/backend" \
    "--property=EnvironmentFile=${runtime_env}" \
    "--property=EnvironmentFile=${release_env}" \
    --property=NoNewPrivileges=yes \
    --property=PrivateTmp=yes \
    --property=ProtectSystem=strict \
    --property=ProtectHome=yes \
    --property=UMask=0077 \
    '--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' \
    --setenv=PYTHONDONTWRITEBYTECODE=1 \
    --setenv=PYTHONUNBUFFERED=1 \
    "${python}" "${manage}" system_admin_rollout_preflight --evidence-file -
} 2>/dev/null)"
preflight_status=$?
set -e

if ! canonical_evidence="$(jq --compact-output --sort-keys . <<<"${evidence}" 2>/dev/null)" \
  || [[ "${canonical_evidence}" != "${evidence}" ]]; then
  echo "The rollout preflight did not return canonical JSON evidence." >&2
  exit 1
fi
if ! jq \
  --exit-status \
  --arg environment "${runtime_environment}" \
  --arg tag "${expected_tag}" \
  --arg sha "${expected_sha}" \
  '.environment == $environment and .release.tag == $tag and .release.sha == $sha' \
  <<<"${evidence}" >/dev/null; then
  echo "The rollout preflight evidence does not identify the qualified release." >&2
  exit 1
fi

evidence_directory="${state_root}/system-admin-rollout-evidence"
evidence_name="${runtime_environment}-${expected_tag}-${expected_sha}.json"
evidence_file="${evidence_directory}/${evidence_name}"
install -d -o root -g root -m 0700 "${evidence_directory}"
if [[ -L "${evidence_directory}" ]] \
  || [[ "$(stat -c '%U:%G:%a' "${evidence_directory}")" != root:root:700 ]]; then
  echo "The rollout evidence directory is not a private root-owned directory." >&2
  exit 1
fi
temporary_evidence=""
temporary_checksum=""
temporary_flag=""
cleanup() {
  if [[ -n "${temporary_evidence}" ]]; then
    rm -f -- "${temporary_evidence}"
  fi
  if [[ -n "${temporary_checksum}" ]]; then
    rm -f -- "${temporary_checksum}"
  fi
  if [[ -n "${temporary_flag}" ]]; then
    rm -f -- "${temporary_flag}"
  fi
}
trap cleanup EXIT
temporary_evidence="$(mktemp "${evidence_directory}/.${evidence_name}.XXXXXX")"
temporary_checksum="$(mktemp "${evidence_directory}/.${evidence_name}.sha256.XXXXXX")"
printf '%s\n' "${evidence}" >"${temporary_evidence}"
chown root:root "${temporary_evidence}"
chmod 0600 "${temporary_evidence}"
mv -f "${temporary_evidence}" "${evidence_file}"
temporary_evidence=""
evidence_digest="$(sha256sum "${evidence_file}" | awk '{print $1}')"
printf '%s  %s\n' "${evidence_digest}" "${evidence_name}" >"${temporary_checksum}"
chown root:root "${temporary_checksum}"
chmod 0600 "${temporary_checksum}"
mv -f "${temporary_checksum}" "${evidence_file}.sha256"
temporary_checksum=""

if [[ "${preflight_status}" -ne 0 ]] \
  || ! jq --exit-status '.passed == true' <<<"${evidence}" >/dev/null; then
  echo "The rollout preflight failed; System Admin mutations remain disabled." >&2
  exit 1
fi

# A deployment cannot replace a slot while this process holds the shared lock.
# Recheck immediately before the atomic flag transition to catch any unmanaged
# service change that occurred during the read-only database/broker preflight.
probe_qualified_slots
require_runtime_email_delivery

temporary_flag="$(mktemp "${config_root}/.system-admin-mutations-${runtime_environment}.XXXXXX")"
printf 'enabled\n' >"${temporary_flag}"
chown "root:${runtime_group}" "${temporary_flag}"
chmod 0640 "${temporary_flag}"
mv -f "${temporary_flag}" "${flag_file}"
temporary_flag=""

echo "System Admin mutations enabled for the qualified ${runtime_environment} release."
