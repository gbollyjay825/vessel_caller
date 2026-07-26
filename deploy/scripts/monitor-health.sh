#!/usr/bin/env bash
set -euo pipefail

production_url="${VESSEL_CALLER_PUBLIC_URL:-https://vesselcalls.com}"
flexschools_url="${FLEXSCHOOLS_HEALTH_URL:-https://flexschools.ng/}"
backup_marker="${BACKUP_MARKER:-/var/lib/vessel-caller/backups/last-success}"
max_backup_age="${MAX_BACKUP_AGE_SECONDS:-93600}"

failures=()
if ! curl --fail --silent --show-error --max-time 20 "${production_url}/api/readiness" >/dev/null; then
  failures+=("Vessel Caller readiness failed")
fi
if ! curl --fail --silent --show-error --max-time 20 "${flexschools_url}" >/dev/null; then
  failures+=("FlexSchools regression check failed")
fi
if [[ "${BACKUP_MONITORING_ENABLED:-true}" == "true" ]]; then
  if [[ ! -f "${backup_marker}" ]]; then
    failures+=("PostgreSQL backup marker missing")
  else
    marker_age="$(( $(date +%s) - $(stat -c %Y "${backup_marker}") ))"
    if (( marker_age > max_backup_age )); then
      failures+=("PostgreSQL backup is stale")
    fi
  fi
fi

if ! openssl x509 -checkend 1209600 -noout \
  -in <(openssl s_client -servername vesselcalls.com -connect vesselcalls.com:443 </dev/null 2>/dev/null); then
  failures+=("Vessel Caller TLS certificate expires within 14 days or is unreadable")
fi

disk_percent="$(df --output=pcent / | tail -n 1 | tr -dc '0-9')"
if [[ -z "${disk_percent}" || "${disk_percent}" -ge 80 ]]; then
  failures+=("Droplet root filesystem is at ${disk_percent:-unknown}%")
fi

if ! systemctl is-active --quiet redis-vessel-caller-production.service; then
  failures+=("Production Redis service is inactive")
fi
if ! systemctl is-active --quiet redis-vessel-caller-staging.service; then
  failures+=("Staging Redis service is inactive")
fi

active_port="$(awk '/^server / {gsub(/[;:]/, " ", $0); print $3}' \
  /etc/nginx/vessel-caller/active-upstream.conf 2>/dev/null || true)"
case "${active_port}" in
  8001) active_instance=production-blue ;;
  8002) active_instance=production-green ;;
  *) active_instance="" ;;
esac
if [[ -z "${active_instance}" ]]; then
  failures+=("Production upstream does not select a known slot")
else
  if [[ "${active_port}" == "8001" ]] \
    && systemctl is-active --quiet vessel-caller.service \
    && ! systemctl is-active --quiet vessel-caller-web@production-blue.service; then
    :
  else
    if ! systemctl is-active --quiet "vessel-caller-web@${active_instance}.service"; then
      failures+=("Active Django web service is inactive")
    fi
    if ! systemctl is-active --quiet "vessel-caller-worker@${active_instance}.service"; then
      failures+=("Active Celery worker is inactive")
    fi
  fi
fi

if (( ${#failures[@]} == 0 )); then
  logger --tag vessel-caller-monitor "All production checks passed"
  exit 0
fi

message="$(IFS='; '; echo "${failures[*]}")"
logger --priority user.err --tag vessel-caller-monitor "${message}"
if [[ -n "${ALERT_WEBHOOK_URL:-}" ]]; then
  curl \
    --fail \
    --silent \
    --show-error \
    --max-time 10 \
    --header "Content-Type: application/json" \
    --data "$(jq -n --arg text "${message}" '{text: $text}')" \
    "${ALERT_WEBHOOK_URL}" >/dev/null || true
fi
echo "${message}" >&2
exit 1
