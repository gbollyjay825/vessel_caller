#!/usr/bin/env bash
# shellcheck shell=bash

# This file is sourced by deploy-release.sh. Keep the state explicit so the
# failure paths can be exercised without invoking the privileged entrypoint.
staging_services_paused="${staging_services_paused:-false}"
staging_cutover_started="${staging_cutover_started:-false}"
staging_cutover_verified="${staging_cutover_verified:-false}"

readonly staging_web_unit="vessel-caller-staging-web.service"
readonly staging_worker_unit="vessel-caller-staging-worker.service"

staging_current_is_compatible() {
  /usr/local/lib/vessel-caller/staging-compatibility-guard.sh
}

staging_unit_activity() {
  local unit="${1}"
  local load_state
  local active_state
  if ! load_state="$(systemctl show --property=LoadState --value "${unit}")" \
    || [[ "${load_state}" != loaded ]] \
    || ! active_state="$(systemctl show --property=ActiveState --value "${unit}")"; then
    echo "Could not prove staging unit state for ${unit}." >&2
    return 1
  fi
  case "${active_state}" in
    active) printf 'active\n' ;;
    inactive|failed) printf 'inactive\n' ;;
    *)
      echo "Staging unit ${unit} is in unsafe transitional state ${active_state}." >&2
      return 1
      ;;
  esac
}

stop_staging_writers_fail_closed() {
  local failed=0
  systemctl stop "${staging_web_unit}" || failed=1
  systemctl stop "${staging_worker_unit}" || failed=1
  local web_state=""
  local worker_state=""
  web_state="$(staging_unit_activity "${staging_web_unit}")" || failed=1
  worker_state="$(staging_unit_activity "${staging_worker_unit}")" || failed=1
  [[ "${web_state}" == inactive ]] || failed=1
  [[ "${worker_state}" == inactive ]] || failed=1
  if [[ "${failed}" -ne 0 ]]; then
    echo "CRITICAL: staging writers could not be proven inactive; manual containment is required." >&2
    return 1
  fi
}

pause_staging_writers() {
  local web_state
  local worker_state
  web_state="$(staging_unit_activity "${staging_web_unit}")" || return 1
  worker_state="$(staging_unit_activity "${staging_worker_unit}")" || return 1
  if [[ "${web_state}" != "${worker_state}" ]]; then
    echo "Staging web and worker must both be active or both be inactive before cutover." >&2
    return 1
  fi
  # Mark the group paused before the first stop. If either stop fails, the EXIT
  # handler will restore the pre-cutover services instead of leaving one down.
  staging_services_paused=true
  if [[ "${web_state}" != active ]]; then
    # A prior failed cutover intentionally leaves both writers down. Treat that
    # symmetric state as already quiesced so a corrected signed release can
    # recover through the same supported entrypoint.
    return 0
  fi
  if ! systemctl stop "${staging_web_unit}"; then
    return 1
  fi
  if ! systemctl stop "${staging_worker_unit}"; then
    return 1
  fi
  web_state="$(staging_unit_activity "${staging_web_unit}")" || return 1
  worker_state="$(staging_unit_activity "${staging_worker_unit}")" || return 1
  if [[ "${web_state}" != inactive || "${worker_state}" != inactive ]]; then
    echo "Staging writers did not become inactive before cutover." >&2
    return 1
  fi
}

resume_staging_writers() {
  if [[ "${staging_services_paused}" != "true" ]]; then
    return 0
  fi

  local failed=0
  if ! staging_current_is_compatible; then
    echo "Staging current release failed the durable compatibility guard." >&2
    stop_staging_writers_fail_closed || return 1
    return 1
  fi
  # Bring the asynchronous writer up before reopening the public web writer.
  systemctl start "${staging_worker_unit}" || failed=1
  systemctl start "${staging_web_unit}" || failed=1
  local worker_state=""
  local web_state=""
  worker_state="$(staging_unit_activity "${staging_worker_unit}")" || failed=1
  web_state="$(staging_unit_activity "${staging_web_unit}")" || failed=1
  [[ "${worker_state}" == active ]] || failed=1
  [[ "${web_state}" == active ]] || failed=1

  if [[ "${failed}" -eq 0 ]]; then
    staging_services_paused=false
    return 0
  fi

  # A partially resumed release must not accept requests or background work.
  stop_staging_writers_fail_closed || return 1
  return 1
}

cleanup_paused_staging_writers() {
  if [[ "${staging_cutover_started}" == "true" ]] \
    && [[ "${staging_cutover_verified}" != "true" ]]; then
    echo "Staging cutover did not verify; keeping web and worker fail-closed." >&2
    stop_staging_writers_fail_closed
    return
  fi

  if [[ "${staging_services_paused}" == "true" ]]; then
    resume_staging_writers
  fi
}

handle_staging_writer_exit() {
  local exit_status=$?
  trap - EXIT
  if ! cleanup_paused_staging_writers && [[ "${exit_status}" -eq 0 ]]; then
    exit_status=1
  fi
  exit "${exit_status}"
}
