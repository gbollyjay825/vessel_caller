#!/usr/bin/env bash
set -euo pipefail

script_path="$(readlink -f -- "${BASH_SOURCE[0]}")"
script_dir="$(dirname -- "${script_path}")"
if [[ "${1:-}" == "--print-resolved-script-dir" ]]; then
  # Read-only diagnostic used by the symlink-path regression test. The forced
  # SSH command and sudo rule cannot invoke this mode.
  printf '%s\n' "${script_dir}"
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root through the restricted vessel-deploy sudo rule." >&2
  exit 1
fi
if [[ ! -f "${script_path}" || -L "${script_path}" ]] \
  || [[ "$(stat -c '%U:%G:%a' "${script_path}")" != root:root:755 ]] \
  || [[ ! -d "${script_dir}" || -L "${script_dir}" ]] \
  || [[ "$(stat -c '%U:%G:%a' "${script_dir}")" != root:root:755 ]]; then
  echo "The installed deployment control path is not trusted." >&2
  exit 1
fi

for helper in \
  install-release.sh \
  release-target-policy.sh \
  snapshot-release.py \
  staging-compatibility-guard.sh \
  staging-lifecycle-state.sh \
  staging-writer-guard.sh \
  libpq-env.sh \
  verify-release.sh; do
  helper_path="${script_dir}/${helper}"
  if [[ ! -f "${helper_path}" || -L "${helper_path}" ]] \
    || [[ "$(stat -c '%U:%G:%a' "${helper_path}")" != root:root:755 ]]; then
    echo "Installed deployment helper is not trusted: ${helper}" >&2
    exit 1
  fi
done

exec 9>/run/lock/vessel-caller-release.lock
if ! flock --nonblock 9; then
  echo "Another Vessel Caller release operation is already running." >&2
  exit 1
fi
target="${1:-}"
archive="${2:-}"
# shellcheck source=deploy/scripts/staging-writer-guard.sh
source "${script_dir}/staging-writer-guard.sh"
# shellcheck source=deploy/scripts/release-target-policy.sh
source "${script_dir}/release-target-policy.sh"

release_snapshot_root=""

cleanup_release_snapshot() {
  if [[ -z "${release_snapshot_root}" ]]; then
    return 0
  fi
  if [[ "${release_snapshot_root}" != /var/lib/vessel-caller/.release-input.* ]] \
    || [[ ! -d "${release_snapshot_root}" ]] \
    || [[ -L "${release_snapshot_root}" ]]; then
    echo "Refusing to remove an unexpected release snapshot path." >&2
    return 1
  fi
  rm -rf -- "${release_snapshot_root}"
  release_snapshot_root=""
}

handle_deploy_release_exit() {
  local exit_status=$?
  trap - EXIT
  if ! cleanup_release_snapshot && [[ "${exit_status}" -eq 0 ]]; then
    exit_status=1
  fi
  if ! cleanup_paused_staging_writers && [[ "${exit_status}" -eq 0 ]]; then
    exit_status=1
  fi
  exit "${exit_status}"
}

trap handle_deploy_release_exit EXIT

export REQUIRE_RELEASE_SIGNATURE=true

fail_close_system_admin_mutations() {
  local runtime_environment="${1}"
  local runtime_group="${2}"
  local config_root=/etc/vessel-caller
  local flag_file="${config_root}/system-admin-mutations-${runtime_environment}.flag"
  local temporary_flag

  if [[ ! -d "${config_root}" || -L "${config_root}" ]] \
    || [[ "$(stat -c '%U:%G:%a' "${config_root}")" != root:root:755 ]]; then
    echo "The Vessel Caller configuration root is not a trusted root-owned directory." >&2
    return 1
  fi
  if [[ ! -f "${flag_file}" || -L "${flag_file}" ]] \
    || [[ "$(stat -c '%U:%G:%a' "${flag_file}")" != "root:${runtime_group}:640" ]]; then
    echo "The environment-specific System Admin mutation flag is not trusted." >&2
    return 1
  fi

  temporary_flag="$(mktemp "${config_root}/.system-admin-mutations-${runtime_environment}.XXXXXX")"
  if ! printf 'disabled\n' >"${temporary_flag}" \
    || ! chown "root:${runtime_group}" "${temporary_flag}" \
    || ! chmod 0640 "${temporary_flag}" \
    || ! mv -f "${temporary_flag}" "${flag_file}"; then
    rm -f -- "${temporary_flag}"
    echo "System Admin mutations could not be disabled safely." >&2
    return 1
  fi
}

case "${target}" in
  staging|production) ;;
  *)
    echo "Usage: $0 <staging|production> <release.tar.gz>" >&2
    exit 2
    ;;
esac

# The upload account owns /var/tmp and can retain writable file descriptors.
# Snapshot all inputs under the release lock before any verification; every
# subsequent verifier, policy check, and extractor uses only these bytes.
release_snapshot_base=/var/lib/vessel-caller
if [[ ! -d "${release_snapshot_base}" || -L "${release_snapshot_base}" ]] \
  || [[ "$(stat -c '%U:%G:%a' "${release_snapshot_base}")" != root:root:755 ]]; then
  echo "The release snapshot base is not a trusted root-owned directory." >&2
  exit 1
fi
release_snapshot_root="$(mktemp -d "${release_snapshot_base}/.release-input.XXXXXX")"
chown root:root "${release_snapshot_root}"
chmod 0700 "${release_snapshot_root}"
archive="$("${script_dir}/snapshot-release.py" "${archive}" "${release_snapshot_root}")"

case "${target}" in
  staging)
    # Staging has an independently pinned artifact key.  Never replace the
    # production verifier merely to stage a candidate release.
    export RELEASE_SIGNATURE_PUBLIC_KEY=/etc/vessel-caller/staging-release-signing-public.pem
    "${script_dir}/verify-release.sh" "${archive}"
    enforce_release_target_policy staging "${archive}"
    fail_close_system_admin_mutations staging vessel-caller-staging
    pause_staging_writers
    # From this point every exit path stays fail-closed. Persist the floor only
    # after both legacy writers are confirmed down.
    staging_cutover_started=true
    enforce_staging_compatibility_floor "${archive}"
    "${script_dir}/install-release.sh" staging "${archive}"
    # The prepare unit already refreshes deterministic staging fixtures before
    # the candidate web starts. Do not seed a second time through a live slot.
    resume_staging_writers
    systemctl enable \
      vessel-caller-staging-worker.service \
      vessel-caller-staging-web.service >/dev/null
    staging_healthy=false
    for _ in $(seq 1 30); do
      if curl \
        --fail \
        --silent \
        --show-error \
        --max-time 3 \
        --header "Host: staging.vesselcalls.com" \
        --header "X-Forwarded-Proto: https" \
        http://127.0.0.1:8010/api/readiness >/dev/null; then
        staging_healthy=true
        break
      fi
      sleep 1
    done
    if [[ "${staging_healthy}" != true ]]; then
      echo "Staging candidate failed readiness; keeping web and worker fail-closed." >&2
      exit 1
    fi
    staging_cutover_verified=true
    ;;
  production)
    export RELEASE_SIGNATURE_PUBLIC_KEY=/etc/vessel-caller/release-signing-public.pem
    "${script_dir}/verify-release.sh" "${archive}"
    enforce_release_target_policy production "${archive}"
    active_port="$(awk '/^server / {gsub(/[;:]/, " ", $0); print $3}' \
      /etc/nginx/vessel-caller/active-upstream.conf 2>/dev/null || true)"
    if [[ "${active_port}" == "8002" ]]; then
      candidate="production-blue"
    else
      candidate="production-green"
    fi
    if [[ "${candidate}" == "production-blue" ]] \
      && ! systemctl is-active --quiet vessel-caller-web@production-blue.service \
      && ss --listening --tcp --numeric 'sport = :8001' | grep -q ':8001'; then
      echo "Port 8001 is still reserved by legacy FastAPI blue; do not repurpose it before the approved seven-day retirement." >&2
      exit 1
    fi
    fail_close_system_admin_mutations production vessel-caller-production
    "${script_dir}/install-release.sh" "${candidate}" "${archive}"
    "${script_dir}/promote-release.sh" "${candidate}"
    ;;
esac
