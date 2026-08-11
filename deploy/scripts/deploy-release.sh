#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root through the restricted vessel-deploy sudo rule." >&2
  exit 1
fi

exec 9>/run/lock/vessel-caller-release.lock
if ! flock --nonblock 9; then
  echo "Another Vessel Caller release operation is already running." >&2
  exit 1
fi
target="${1:-}"
archive="${2:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
  staging)
    # Staging has an independently pinned artifact key.  Never replace the
    # production verifier merely to stage a candidate release.
    export RELEASE_SIGNATURE_PUBLIC_KEY=/etc/vessel-caller/staging-release-signing-public.pem
    fail_close_system_admin_mutations staging vessel-caller-staging
    "${script_dir}/install-release.sh" staging "${archive}"
    # The isolated staging browser gate authenticates only deterministic
    # fixture accounts. Refresh them on each staging release so an expired
    # MFA grace period can never silently remove their permissions. The
    # password remains in the root-owned staging environment file; it is
    # neither emitted nor passed through GitHub Actions.
    set -a
    # shellcheck disable=SC1091
    . /etc/vessel-caller/staging.env
    # shellcheck disable=SC1091
    . /opt/vessel-caller/slots/staging/current/RELEASE.env
    set +a
    runuser -u vessel-caller-staging --preserve-environment -- \
      /opt/vessel-caller/slots/staging/current/backend/.venv/bin/python \
      /opt/vessel-caller/slots/staging/current/backend/manage.py \
      seed_e2e --force
    systemctl restart vessel-caller-staging-worker.service
    systemctl enable vessel-caller-staging-worker.service >/dev/null
    curl \
      --fail \
      --silent \
      --show-error \
      --header "Host: staging.vesselcalls.com" \
      --header "X-Forwarded-Proto: https" \
      http://127.0.0.1:8010/api/readiness >/dev/null
    ;;
  production)
    export RELEASE_SIGNATURE_PUBLIC_KEY=/etc/vessel-caller/release-signing-public.pem
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
  *)
    echo "Usage: $0 <staging|production> <release.tar.gz>" >&2
    exit 2
    ;;
esac

rm -f "${archive}" "${archive}.sha256" "${archive}.sig"
