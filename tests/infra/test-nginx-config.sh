#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture_root="$(mktemp -d)"
trap 'rm -rf "${fixture_root}"' EXIT

mkdir -p \
  "${fixture_root}/conf.d" \
  "${fixture_root}/logs" \
  "${fixture_root}/vessel-caller" \
  "${fixture_root}/letsencrypt/live/vesselcalls.com" \
  "${fixture_root}/letsencrypt/live/staging-api.vesselcalls.com" \
  "${fixture_root}/var/lib/vessel-caller" \
  "${fixture_root}/var/www/letsencrypt" \
  "${fixture_root}/var/www/vessel-caller"

printf 'server 127.0.0.1:8001;\n' > "${fixture_root}/vessel-caller/active-upstream.conf"
cp "${repo_root}/deploy/staff-allowlist.conf" "${fixture_root}/vessel-caller/staff-allowlist.conf"
printf '"test-only-staging-proxy-secret" 1;\n' > "${fixture_root}/vessel-caller/staging-proxy-map.conf"
openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -days 1 \
  -subj /CN=vesselcalls.com \
  -keyout "${fixture_root}/letsencrypt/live/vesselcalls.com/privkey.pem" \
  -out "${fixture_root}/letsencrypt/live/vesselcalls.com/fullchain.pem" \
  >/dev/null 2>&1
cp \
  "${fixture_root}/letsencrypt/live/vesselcalls.com/privkey.pem" \
  "${fixture_root}/letsencrypt/live/staging-api.vesselcalls.com/privkey.pem"
cp \
  "${fixture_root}/letsencrypt/live/vesselcalls.com/fullchain.pem" \
  "${fixture_root}/letsencrypt/live/staging-api.vesselcalls.com/fullchain.pem"

validate_variant() {
  local production_config="$1"
  local staging_config="$2"
  if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    cp "${repo_root}/deploy/${production_config}" "${fixture_root}/conf.d/production.conf"
    cp "${repo_root}/deploy/${staging_config}" "${fixture_root}/conf.d/staging.conf"
    docker run \
      --rm \
      --volume "${fixture_root}/conf.d:/etc/nginx/conf.d:ro" \
      --volume "${fixture_root}/vessel-caller:/etc/nginx/vessel-caller:ro" \
      --volume "${fixture_root}/letsencrypt:/etc/letsencrypt:ro" \
      nginx:1.28.0-alpine \
      nginx -t
    return
  fi

  if ! command -v nginx >/dev/null; then
    echo "Docker or a local Nginx binary is required." >&2
    return 1
  fi

  local replacements=(
    -e "s#/etc/nginx/vessel-caller#${fixture_root}/vessel-caller#g"
    -e "s#/etc/letsencrypt#${fixture_root}/letsencrypt#g"
    -e "s#/var/log/nginx#${fixture_root}/logs#g"
    -e "s#/var/lib/vessel-caller#${fixture_root}/var/lib/vessel-caller#g"
    -e "s#/var/www/letsencrypt#${fixture_root}/var/www/letsencrypt#g"
    -e "s#/var/www/vessel-caller#${fixture_root}/var/www/vessel-caller#g"
  )
  sed "${replacements[@]}" \
    "${repo_root}/deploy/${production_config}" \
    > "${fixture_root}/conf.d/production.conf"
  sed "${replacements[@]}" \
    "${repo_root}/deploy/${staging_config}" \
    > "${fixture_root}/conf.d/staging.conf"
  printf \
    'worker_processes 1;\nerror_log %s/error.log;\npid %s/nginx.pid;\nevents { worker_connections 64; }\nhttp { include %s/conf.d/*.conf; }\n' \
    "${fixture_root}/logs" \
    "${fixture_root}" \
    "${fixture_root}" \
    > "${fixture_root}/nginx.conf"
  nginx -t -p "${fixture_root}/" -c "${fixture_root}/nginx.conf"
}

validate_variant nginx-vessel-caller.conf nginx-vessel-caller-staging.conf
validate_variant nginx-vessel-caller-bootstrap.conf nginx-vessel-caller-staging-bootstrap.conf
echo "Production and bootstrap Nginx configurations passed nginx -t."
