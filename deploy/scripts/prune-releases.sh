#!/usr/bin/env bash
set -euo pipefail

release_root="${VESSEL_CALLER_RELEASE_ROOT:-/opt/vessel-caller/releases}"
if [[ "${release_root}" != /opt/vessel-caller/releases || ! -d "${release_root}" ]]; then
  echo "Refusing to prune unexpected release root: ${release_root}" >&2
  exit 1
fi

active_targets=()
for link in /opt/vessel-caller/current /opt/vessel-caller/slots/*/current; do
  if [[ -L "${link}" ]]; then
    active_targets+=("$(readlink -f "${link}")")
  fi
done

while IFS= read -r -d '' release; do
  canonical="$(readlink -f "${release}")"
  keep=false
  for active in "${active_targets[@]}"; do
    if [[ "${canonical}" == "${active}" ]]; then
      keep=true
      break
    fi
  done
  if [[ "${keep}" == "true" ]]; then
    continue
  fi
  case "${canonical}" in
    /opt/vessel-caller/releases/v*)
      find "${canonical}" -depth -delete
      logger --tag vessel-caller-release "Pruned inactive release ${canonical}"
      ;;
    *)
      echo "Refusing to prune unexpected path: ${canonical}" >&2
      exit 1
      ;;
  esac
done < <(find "${release_root}" -mindepth 1 -maxdepth 1 -type d -name 'v*' -mtime +30 -print0)
