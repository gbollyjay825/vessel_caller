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
export REQUIRE_RELEASE_SIGNATURE=true
export RELEASE_SIGNATURE_PUBLIC_KEY=/etc/vessel-caller/release-signing-public.pem

target="${1:-}"
archive="${2:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "${target}" in
  staging)
    "${script_dir}/install-release.sh" staging "${archive}"
    systemctl restart vessel-caller-staging-worker.service
    systemctl enable vessel-caller-staging-worker.service >/dev/null
    curl \
      --fail \
      --silent \
      --show-error \
      --header "Host: staging-api.vesselcalls.com" \
      --header "X-Forwarded-Proto: https" \
      http://127.0.0.1:8010/api/readiness >/dev/null
    ;;
  production)
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
    "${script_dir}/install-release.sh" "${candidate}" "${archive}"
    "${script_dir}/promote-release.sh" "${candidate}"
    ;;
  *)
    echo "Usage: $0 <staging|production> <release.tar.gz>" >&2
    exit 2
    ;;
esac

rm -f "${archive}" "${archive}.sha256" "${archive}.sig"
