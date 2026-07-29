#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run as root through the restricted vessel-deploy sudo rule." >&2
  exit 1
fi

instance="${1:-}"
archive="${2:-}"
case "${instance}" in
  production-blue|production-green|staging) ;;
  *)
    echo "Usage: $0 <production-blue|production-green|staging> <release.tar.gz>" >&2
    exit 2
    ;;
esac
if [[ ! -f "${archive}" || ! -f "${archive}.sha256" ]]; then
  echo "Release archive and adjacent checksum are required." >&2
  exit 2
fi

if [[ "${instance}" == "staging" ]]; then
  readonly app_user="vessel-caller-staging"
  readonly app_group="vessel-caller-staging"
  readonly prepare_unit="vessel-caller-staging-prepare.service"
  readonly web_unit="vessel-caller-staging-web.service"
else
  readonly app_user="vessel-caller-production"
  readonly app_group="vessel-caller-production"
  readonly prepare_unit="vessel-caller-prepare@${instance}.service"
  readonly web_unit="vessel-caller-web@${instance}.service"
fi
readonly app_root="/opt/vessel-caller"
readonly release_root="${app_root}/releases"
readonly slot_root="${app_root}/slots/${instance}"
readonly env_file="/etc/vessel-caller/${instance}.env"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -r "${env_file}" ]]; then
  echo "Missing protected environment file: ${env_file}" >&2
  exit 1
fi

"${script_dir}/verify-release.sh" "${archive}"

release_name="$(basename "${archive}" .tar.gz)"
release_tag="${release_name#vessel-caller-}"
if [[ "${release_tag}" == "${release_name}" ]]; then
  echo "Unexpected archive name: ${release_name}" >&2
  exit 1
fi
release_tag_root="${release_root}/${release_tag}"
release_dir="${release_tag_root}/${instance}"

install -d -o root -g root -m 0755 "${app_root}" "${release_root}" "${app_root}/slots"
install -d -o "${app_user}" -g "${app_group}" -m 0750 "${slot_root}"
install -d -o root -g root -m 0755 "${release_tag_root}"

if [[ ! -d "${release_dir}" ]]; then
  extract_root="$(mktemp -d "${release_root}/.extract.XXXXXX")"
  trap 'rm -rf "${extract_root}"' EXIT
  tar --no-same-owner --no-same-permissions -xzf "${archive}" -C "${extract_root}"
  extracted="${extract_root}/${release_name}"
  if [[ ! -d "${extracted}/backend" || ! -d "${extracted}/frontend/dist" ]]; then
    echo "Release payload is incomplete." >&2
    exit 1
  fi
  mv "${extracted}" "${release_dir}"
  chown -R "${app_user}:${app_group}" "${release_dir}"
  chmod -R u=rwX,g=rX,o= "${release_dir}"
  trap - EXIT
  rm -rf "${extract_root}"
else
  (
    cd "${release_dir}"
    sha256sum --check SHA256SUMS
  )
fi

release_manifest_tag="$(jq -er '.release | select(type == "string")' "${release_dir}/RELEASE.json")"
release_sha="$(jq -er '.commit | select(type == "string" and test("^[0-9a-f]{40}$"))' "${release_dir}/RELEASE.json")"
if [[ "${release_manifest_tag}" != "${release_tag}" ]]; then
  echo "Release manifest tag does not match archive name." >&2
  exit 1
fi
printf \
  'VC_RELEASE_SHA=%s\nVC_RELEASE_TAG=%s\n' \
  "${release_sha}" \
  "${release_manifest_tag}" \
  > "${release_dir}/RELEASE.env"

if [[ ! -x "${release_dir}/backend/.venv/bin/gunicorn" ]]; then
  runuser -u "${app_user}" -- \
    python3.12 -m venv "${release_dir}/backend/.venv"
  runuser -u "${app_user}" -- \
    "${release_dir}/backend/.venv/bin/pip" install \
    --disable-pip-version-check \
    --no-index \
    --require-hashes \
    --find-links "${release_dir}/wheelhouse" \
    --requirement "${release_dir}/backend/requirements/production.txt"
fi
chown -R root:"${app_group}" "${release_dir}"
chmod -R u=rwX,g=rX,o= "${release_dir}"
chmod 0644 "${release_dir}/RELEASE.env"
install \
  -d \
  -o "${app_user}" \
  -g "${app_group}" \
  -m 0750 \
  "${release_dir}/backend/staticfiles"

previous_target=""
if [[ -L "${slot_root}/current" ]]; then
  previous_target="$(readlink -f "${slot_root}/current")"
elif [[ -e "${slot_root}/current" ]]; then
  echo "Refusing to replace non-symlink ${slot_root}/current." >&2
  exit 1
fi

ln -sfn "${release_dir}" "${slot_root}/current.next"
mv -Tf "${slot_root}/current.next" "${slot_root}/current"

systemctl daemon-reload
if ! flock /run/lock/vessel-caller-migrate.lock \
  systemctl start "${prepare_unit}"; then
  if [[ -n "${previous_target}" ]]; then
    ln -sfn "${previous_target}" "${slot_root}/current"
  else
    rm -f "${slot_root}/current"
  fi
  exit 1
fi

systemctl restart "${web_unit}"
systemctl enable "${web_unit}" >/dev/null

case "${instance}" in
  production-blue)
    port=8001
    health_host=vesselcalls.com
    ;;
  production-green)
    port=8002
    health_host=vesselcalls.com
    ;;
  staging)
    port=8010
    health_host=staging.vesselcalls.com
    ;;
esac

healthy=false
for _ in $(seq 1 30); do
  status="$(curl \
    --silent \
    --show-error \
    --max-time 3 \
    --output /dev/null \
    --write-out '%{http_code}' \
    --header "Host: ${health_host}" \
    --header "X-Forwarded-Proto: https" \
    "http://127.0.0.1:${port}/api/readiness" || true)"
  if [[ "${status}" == "200" ]]; then
    healthy=true
    break
  fi
  sleep 1
done

if [[ "${healthy}" != "true" ]]; then
  systemctl stop "${web_unit}"
  if [[ -n "${previous_target}" ]]; then
    ln -sfn "${previous_target}" "${slot_root}/current"
    systemctl restart "${web_unit}"
  else
    rm -f "${slot_root}/current"
  fi
  journalctl -u "${web_unit}" -n 100 --no-pager >&2
  exit 1
fi

echo "${release_tag} is healthy in inactive slot ${instance}."
