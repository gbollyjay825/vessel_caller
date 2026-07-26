#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root through the restricted vessel-deploy sudo rule." >&2
  exit 1
fi

candidate="${1:-}"
case "${candidate}" in
  production-blue)
    candidate_port=8001
    previous="production-green"
    ;;
  production-green)
    candidate_port=8002
    previous="production-blue"
    ;;
  *)
    echo "Usage: $0 <production-blue|production-green>" >&2
    exit 2
    ;;
esac

readonly app_root="/opt/vessel-caller"
readonly upstream_file="/etc/nginx/vessel-caller/active-upstream.conf"
readonly current_link="${app_root}/current"
readonly candidate_release="${app_root}/slots/${candidate}/current"
readonly public_url="${VESSEL_CALLER_PUBLIC_URL:-https://vesselcalls.com}"
readonly flexschools_url="${FLEXSCHOOLS_HEALTH_URL:-https://flexschools.ng/}"

if [[ ! -L "${candidate_release}" ]]; then
  echo "Candidate slot has no installed release: ${candidate}" >&2
  exit 1
fi

curl --fail --silent --show-error --max-time 20 "${flexschools_url}" >/dev/null
candidate_status="$(curl \
  --silent \
  --show-error \
  --max-time 5 \
  --output /dev/null \
  --write-out '%{http_code}' \
  --header "Host: vesselcalls.com" \
  --header "X-Forwarded-Proto: https" \
  "http://127.0.0.1:${candidate_port}/api/readiness")"
if [[ "${candidate_status}" != "200" ]]; then
  echo "Candidate readiness returned HTTP ${candidate_status}." >&2
  exit 1
fi

previous_upstream="$(mktemp)"
previous_current=""
had_previous_upstream=false
trap 'rm -f "${previous_upstream}"' EXIT
if [[ -f "${upstream_file}" ]]; then
  cp -a "${upstream_file}" "${previous_upstream}"
  had_previous_upstream=true
fi
if [[ -L "${current_link}" ]]; then
  previous_current="$(readlink -f "${current_link}")"
elif [[ -e "${current_link}" ]]; then
  echo "Refusing to replace non-symlink ${current_link}." >&2
  exit 1
fi

install -d -o root -g root -m 0755 "$(dirname "${upstream_file}")"
printf 'server 127.0.0.1:%s;\n' "${candidate_port}" > "${upstream_file}.next"
chown root:root "${upstream_file}.next"
chmod 0644 "${upstream_file}.next"
mv -f "${upstream_file}.next" "${upstream_file}"
ln -sfn "$(readlink -f "${candidate_release}")" "${current_link}.next"
mv -Tf "${current_link}.next" "${current_link}"

rollback() {
  if [[ "${had_previous_upstream}" == "true" ]]; then
    cp -a "${previous_upstream}" "${upstream_file}"
  else
    rm -f "${upstream_file}"
  fi
  if [[ -n "${previous_current}" ]]; then
    ln -sfn "${previous_current}" "${current_link}.next"
    mv -Tf "${current_link}.next" "${current_link}"
  else
    rm -f "${current_link}"
  fi
  nginx -t
  systemctl reload nginx
}

if ! nginx -t; then
  rollback
  exit 1
fi
systemctl reload nginx

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if ! "${script_dir}/smoke-test.sh" "${public_url}"; then
  rollback
  exit 1
fi
if ! curl --fail --silent --show-error --max-time 20 "${flexschools_url}" >/dev/null; then
  echo "FlexSchools regression check failed; rolling Vessel Caller back." >&2
  rollback
  exit 1
fi

systemctl restart "vessel-caller-worker@${candidate}.service"
systemctl enable "vessel-caller-worker@${candidate}.service" >/dev/null
systemctl stop "vessel-caller-worker@${previous}.service" 2>/dev/null || true
echo "${candidate} is now the production slot."
