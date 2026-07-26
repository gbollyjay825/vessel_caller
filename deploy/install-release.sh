#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
    echo "Run this installer as root." >&2
    exit 1
fi

release_id="${1:-}"
if [[ ! "${release_id}" =~ ^[0-9]{14}-[0-9a-f]{7,40}$ ]]; then
    echo "Usage: $0 <YYYYMMDDHHMMSS-git-sha>" >&2
    exit 1
fi

readonly app_user="vessel-caller"
readonly app_root="/opt/vessel-caller"
readonly release_dir="${app_root}/releases/${release_id}"
readonly current_link="${app_root}/current"
readonly data_dir="/var/lib/vessel-caller"
readonly env_dir="/etc/vessel-caller"
readonly env_file="${env_dir}/vessel-caller.env"
readonly service_file="/etc/systemd/system/vessel-caller.service"
readonly nginx_available="/etc/nginx/sites-available/vessel-caller"
readonly nginx_enabled="/etc/nginx/sites-enabled/vessel-caller"
readonly public_origin="https://vesselcalls.com"
readonly api_health="http://127.0.0.1:8001/api/health"
readonly certificate_file="/etc/letsencrypt/live/vesselcalls.com/fullchain.pem"

if [[ ! -d "${release_dir}/backend/app" || ! -f "${release_dir}/frontend/dist/index.html" ]]; then
    echo "Release payload is incomplete: ${release_dir}" >&2
    exit 1
fi

if ! id "${app_user}" >/dev/null 2>&1; then
    useradd \
        --system \
        --home-dir "${data_dir}" \
        --create-home \
        --shell /usr/sbin/nologin \
        "${app_user}"
fi

install -d -m 0755 "${app_root}" "${app_root}/releases"
install -d -o www-data -g www-data -m 0755 /var/www/letsencrypt
install -d -o "${app_user}" -g "${app_user}" -m 0750 "${data_dir}"
install -d -o root -g "${app_user}" -m 0750 "${env_dir}"
chown -R "${app_user}:${app_user}" "${release_dir}"

if [[ ! -x "${release_dir}/backend/.venv/bin/uvicorn" ]]; then
    if ! python3 -c 'import ensurepip' >/dev/null 2>&1; then
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv
    fi
    rm -rf "${release_dir}/backend/.venv"
    runuser -u "${app_user}" -- python3 -m venv "${release_dir}/backend/.venv"
    runuser -u "${app_user}" -- \
        "${release_dir}/backend/.venv/bin/pip" install \
        --disable-pip-version-check \
        --no-cache-dir \
        -r "${release_dir}/backend/requirements.txt"
fi

if [[ ! -f "${env_file}" ]]; then
    jwt_secret="$(python3 -c 'import secrets; print(secrets.token_urlsafe(64))')"
    {
        printf 'VC_ENVIRONMENT=production\n'
        printf 'VC_DATABASE_URL=sqlite:////var/lib/vessel-caller/vessel_caller.db\n'
        printf 'VC_JWT_SECRET=%s\n' "${jwt_secret}"
        printf 'VC_ACCESS_TOKEN_EXPIRE_MINUTES=720\n'
        printf 'VC_CORS_ORIGINS=%s\n' "${public_origin}"
        printf 'VC_SEED_ON_STARTUP=false\n'
    } > "${env_file}"
    chown root:"${app_user}" "${env_file}"
    chmod 0640 "${env_file}"
fi

install -o root -g root -m 0644 \
    "${release_dir}/deploy/vessel-caller.service" \
    "${service_file}"

previous_release=""
if [[ -L "${current_link}" ]]; then
    previous_release="$(readlink -f "${current_link}")"
elif [[ -e "${current_link}" ]]; then
    echo "Refusing to replace non-symlink path: ${current_link}" >&2
    exit 1
fi

rm -f "${current_link}.next"
ln -s "${release_dir}" "${current_link}.next"
mv -Tf "${current_link}.next" "${current_link}"

systemctl daemon-reload
systemctl enable vessel-caller.service >/dev/null
systemctl restart vessel-caller.service

healthy=false
for _ in $(seq 1 20); do
    if curl --fail --silent --show-error "${api_health}" >/dev/null; then
        healthy=true
        break
    fi
    sleep 1
done

if [[ "${healthy}" != "true" ]]; then
    echo "Vessel Caller API did not become healthy; rolling back the active release." >&2
    if [[ -n "${previous_release}" ]]; then
        rm -f "${current_link}.next"
        ln -s "${previous_release}" "${current_link}.next"
        mv -Tf "${current_link}.next" "${current_link}"
        systemctl restart vessel-caller.service
    else
        systemctl stop vessel-caller.service
        rm -f "${current_link}"
    fi
    journalctl -u vessel-caller.service -n 80 --no-pager >&2
    exit 1
fi

nginx_backup="$(mktemp)"
had_nginx_config=false
if [[ -f "${nginx_available}" ]]; then
    cp -a "${nginx_available}" "${nginx_backup}"
    had_nginx_config=true
fi

nginx_source="${release_dir}/deploy/nginx-vessel-caller-bootstrap.conf"
if [[ -f "${certificate_file}" ]]; then
    nginx_source="${release_dir}/deploy/nginx-vessel-caller.conf"
fi

install -o root -g root -m 0644 "${nginx_source}" "${nginx_available}"
ln -sfn "${nginx_available}" "${nginx_enabled}"

if ! nginx -t; then
    echo "Nginx validation failed; restoring the previous Vessel Caller configuration." >&2
    if [[ "${had_nginx_config}" == "true" ]]; then
        cp -a "${nginx_backup}" "${nginx_available}"
    else
        rm -f "${nginx_available}" "${nginx_enabled}"
    fi
    rm -f "${nginx_backup}"
    nginx -t
    exit 1
fi

rm -f "${nginx_backup}"
systemctl reload nginx

curl --fail --silent --show-error "${api_health}"
echo
echo "Vessel Caller release ${release_id} is active at ${public_origin}"
