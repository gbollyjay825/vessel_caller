#!/usr/bin/env bash
set -euo pipefail

original_command="${SSH_ORIGINAL_COMMAND:-}"
case "${original_command}" in
  "scp -t /var/tmp"|\
  "scp -t /var/tmp/"|\
  "scp -d -t /var/tmp"|\
  "scp -d -t /var/tmp/")
    exec /usr/bin/scp -t /var/tmp/
    ;;
esac

if [[ "${original_command}" =~ ^sudo\ /usr/local/sbin/vessel-caller-deploy\ (staging|production)\ (/var/tmp/vessel-caller-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\.tar\.gz)$ ]]; then
  exec \
    /usr/bin/sudo \
    /usr/local/sbin/vessel-caller-deploy \
    "${BASH_REMATCH[1]}" \
    "${BASH_REMATCH[2]}"
fi

echo "This SSH key is restricted to signed Vessel Caller release uploads and deployments." >&2
exit 1
