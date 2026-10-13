#!/usr/bin/env bash
set -euo pipefail

# This guard runs before every staging process start. The database migration
# ledger is authoritative after host replacement; the root-owned marker avoids
# a database dependency on ordinary starts once the first cutover begins.
marker="${1:-/var/lib/vessel-caller/staging-organization-approval-lifecycle.cutover}"
current_link="${2:-/opt/vessel-caller/slots/staging/current}"
release_root="${3:-/opt/vessel-caller/releases}"
temporary_password_marker="${4:-$(dirname -- "${marker}")/staging-temporary-password-lifecycle.cutover}"
require_organization=false
require_temporary_password=false

for lifecycle in organization temporary-password; do
  if [[ "${lifecycle}" == organization ]]; then
    lifecycle_marker="${marker}"
    capability=organizationApprovalLifecycle
  else
    lifecycle_marker="${temporary_password_marker}"
    capability=temporaryPasswordLifecycle
  fi
  if [[ ! -e "${lifecycle_marker}" && ! -L "${lifecycle_marker}" ]]; then
    if ! lifecycle_state="$(/usr/local/lib/vessel-caller/staging-lifecycle-state.sh "${lifecycle}")"; then
      echo "The authoritative staging ${lifecycle} lifecycle state could not be established." >&2
      exit 1
    fi
    case "${lifecycle_state}" in
      absent) continue ;;
      present) ;;
      *)
        echo "The authoritative staging ${lifecycle} lifecycle state is invalid." >&2
        exit 1
        ;;
    esac
  else
    marker_dir="$(dirname -- "${lifecycle_marker}")"
    if [[ ! -d "${marker_dir}" || -L "${marker_dir}" ]] \
      || [[ "$(stat -c '%U:%G:%a' "${marker_dir}")" != root:root:755 ]] \
      || [[ ! -f "${lifecycle_marker}" || -L "${lifecycle_marker}" ]] \
      || [[ "$(stat -c '%U:%G:%a' "${lifecycle_marker}")" != root:root:644 ]] \
      || [[ "$(<"${lifecycle_marker}")" != "${capability}=true" ]]; then
      echo "The staging ${lifecycle} lifecycle marker is not trusted." >&2
      exit 1
    fi
  fi
  if [[ "${lifecycle}" == organization ]]; then
    require_organization=true
  else
    require_temporary_password=true
  fi
done

if [[ "${require_organization}" != true && "${require_temporary_password}" != true ]]; then exit 0; fi

if [[ ! -L "${current_link}" ]] \
  || [[ "$(stat -c '%U' "${current_link}")" != root ]]; then
  echo "The staging current-release link is not trusted." >&2
  exit 1
fi
current_target="$(readlink -f -- "${current_link}")"
case "${current_target}" in
  "${release_root}"/v*/staging) ;;
  *)
    echo "The staging current-release target is outside the release root." >&2
    exit 1
    ;;
esac

manifest="${current_target}/RELEASE.json"
if [[ ! -d "${current_target}" || -L "${current_target}" ]] \
  || [[ "$(stat -c '%U' "${current_target}")" != root ]] \
  || [[ ! -f "${manifest}" || -L "${manifest}" ]] \
  || [[ "$(stat -c '%U' "${manifest}")" != root ]]; then
  echo "The staging release manifest is not trusted." >&2
  exit 1
fi
target_mode="$(stat -c '%a' "${current_target}")"
manifest_mode="$(stat -c '%a' "${manifest}")"
if (( (8#${target_mode} & 8#22) != 0 || (8#${manifest_mode} & 8#22) != 0 )); then
  echo "The staging release is writable outside root." >&2
  exit 1
fi
if ! jq --exit-status \
  --argjson require_organization "${require_organization}" \
  --argjson require_temporary_password "${require_temporary_password}" \
  '.schemaVersion == 1 and .application == "vessel-caller" and
   ($require_organization == false or .organizationApprovalLifecycle == true) and
   ($require_temporary_password == false or .temporaryPasswordLifecycle == true)' \
  "${manifest}" >/dev/null; then
  echo "The staging release predates a required lifecycle." >&2
  exit 1
fi
