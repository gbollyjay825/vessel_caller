#!/usr/bin/env bash
# shellcheck shell=bash

# Evaluate only after verify-release.sh has authenticated the archive. The same
# helper runs in CI and on the host so a staging-only artifact cannot reach the
# production installer through either supported path.
enforce_release_target_policy() {
  local target="${1:-}"
  local archive="${2:-}"
  local archive_name
  local release_name
  local manifest

  case "${target}" in
    staging|production) ;;
    *)
      echo "Release target policy requires staging or production." >&2
      return 2
      ;;
  esac
  archive_name="$(basename -- "${archive}")"
  release_name="${archive_name%.tar.gz}"
  if [[ ! -f "${archive}" || "${release_name}" == "${archive_name}" \
    || "${release_name}" != vessel-caller-v* ]]; then
    echo "Release target policy received an invalid archive name." >&2
    return 2
  fi
  if ! manifest="$(tar -xOf "${archive}" "${release_name}/RELEASE.json")"; then
    echo "Release target policy could not read the authenticated manifest." >&2
    return 1
  fi
  if ! jq -e '.schemaVersion == 1 and .application == "vessel-caller"' \
    <<<"${manifest}" >/dev/null; then
    echo "Release target policy rejected an invalid manifest." >&2
    return 1
  fi

  # Missing scope is retained only for already-published legacy releases.
  # New lifecycle artifacts explicitly set this signed field to true.
  if [[ "${target}" == "production" ]] \
    && jq -e '.stagingOnlySchemaCutover == true' <<<"${manifest}" >/dev/null; then
    echo "This signed release is restricted to staging; production deployment is blocked." >&2
    return 1
  fi
}

read_staging_lifecycle_state() {
  /usr/local/lib/vessel-caller/staging-lifecycle-state.sh
}

persist_staging_compatibility_marker() {
  local marker="${1}"
  local marker_dir
  local temporary_marker

  marker_dir="$(dirname -- "${marker}")"
  temporary_marker="$(mktemp "${marker_dir}/.staging-organization-approval-lifecycle.XXXXXX")"
  if ! printf 'organizationApprovalLifecycle=true\n' >"${temporary_marker}" \
    || ! chown root:root "${temporary_marker}" \
    || ! chmod 0644 "${temporary_marker}" \
    || ! sync -f "${temporary_marker}" \
    || ! mv -f -- "${temporary_marker}" "${marker}" \
    || ! sync -f "${marker_dir}"; then
    rm -f -- "${temporary_marker}"
    echo "The staging compatibility floor could not be persisted safely." >&2
    return 1
  fi
}

# Persist an irreversible, root-owned staging compatibility floor before the
# first approval-lifecycle cutover can touch the database. A failed cutover
# therefore permits only another compatible signed release; it can never
# reopen legacy writers against the expanded schema.
enforce_staging_compatibility_floor() {
  local archive="${1:-}"
  local marker="${2:-/var/lib/vessel-caller/staging-organization-approval-lifecycle.cutover}"
  local archive_name
  local release_name
  local manifest
  local marker_dir
  local lifecycle_state
  local supports_lifecycle=false

  archive_name="$(basename -- "${archive}")"
  release_name="${archive_name%.tar.gz}"
  if [[ ! -f "${archive}" || "${release_name}" == "${archive_name}" \
    || "${release_name}" != vessel-caller-v* ]]; then
    echo "Staging compatibility policy received an invalid archive name." >&2
    return 2
  fi
  if ! manifest="$(tar -xOf "${archive}" "${release_name}/RELEASE.json")"; then
    echo "Staging compatibility policy could not read the authenticated manifest." >&2
    return 1
  fi
  if jq -e \
    '.schemaVersion == 1 and .application == "vessel-caller" and .organizationApprovalLifecycle == true' \
    <<<"${manifest}" >/dev/null; then
    supports_lifecycle=true
  fi

  marker_dir="$(dirname -- "${marker}")"
  if [[ ! -d "${marker_dir}" || -L "${marker_dir}" ]] \
    || [[ "$(stat -c '%U:%G:%a' "${marker_dir}")" != root:root:755 ]]; then
    echo "The staging compatibility marker directory is not trusted." >&2
    return 1
  fi

  if [[ -e "${marker}" || -L "${marker}" ]]; then
    if [[ ! -f "${marker}" || -L "${marker}" ]] \
      || [[ "$(stat -c '%U:%G:%a' "${marker}")" != root:root:644 ]] \
      || [[ "$(<"${marker}")" != "organizationApprovalLifecycle=true" ]]; then
      echo "The staging compatibility marker is not trusted." >&2
      return 1
    fi
    if [[ "${supports_lifecycle}" != true ]]; then
      echo "Staging has crossed the organization-approval compatibility floor; this legacy release is blocked." >&2
      return 1
    fi
    return 0
  fi

  if ! lifecycle_state="$(read_staging_lifecycle_state)"; then
    echo "The authoritative staging lifecycle state could not be established." >&2
    return 1
  fi
  case "${lifecycle_state}" in
    absent)
      if [[ "${supports_lifecycle}" != true ]]; then
        # Legacy releases remain valid only before the first lifecycle cutover.
        return 0
      fi
      ;;
    present)
      if [[ "${supports_lifecycle}" != true ]]; then
        echo "Staging has crossed the organization-approval compatibility floor; this legacy release is blocked." >&2
        return 1
      fi
      ;;
    *)
      echo "The authoritative staging lifecycle state is invalid." >&2
      return 1
      ;;
  esac

  # Compatible releases establish the marker before migration. If the host was
  # rebuilt after migration, this reconstructs the cache from database truth.
  persist_staging_compatibility_marker "${marker}"
}
