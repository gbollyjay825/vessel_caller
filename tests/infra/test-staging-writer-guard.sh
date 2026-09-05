#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
guard="${repo_root}/deploy/scripts/staging-writer-guard.sh"
fixture_root="$(mktemp -d)"
trap 'rm -rf "${fixture_root}"' EXIT

assert_log() {
  local expected="${1}"
  local actual
  actual="$(cat "${SYSTEMCTL_LOG}")"
  if [[ "${actual}" != "${expected}" ]]; then
    printf 'Unexpected systemctl calls.\nExpected:\n%s\nActual:\n%s\n' \
      "${expected}" "${actual}" >&2
    return 1
  fi
}

web_probe=$'show --property=LoadState --value vessel-caller-staging-web.service\nshow --property=ActiveState --value vessel-caller-staging-web.service'
worker_probe=$'show --property=LoadState --value vessel-caller-staging-worker.service\nshow --property=ActiveState --value vessel-caller-staging-worker.service'

install_systemctl_mock() {
  SYSTEMCTL_LOG="${1}"
  : >"${SYSTEMCTL_LOG}"
  SYSTEMCTL_FAIL="${2:-}"
  WEB_ACTIVE="${3:-true}"
  WORKER_ACTIVE="${4:-true}"

  systemctl() {
    local invocation="$*"
    printf '%s\n' "${invocation}" >>"${SYSTEMCTL_LOG}"
    if grep -Fxq -- "${invocation}" <<<"${SYSTEMCTL_FAIL}"; then
      return 1
    fi
    case "${invocation}" in
      "show --property=LoadState --value vessel-caller-staging-web.service"|\
      "show --property=LoadState --value vessel-caller-staging-worker.service")
        printf 'loaded\n'
        ;;
      "show --property=ActiveState --value vessel-caller-staging-web.service")
        [[ "${WEB_ACTIVE}" == true ]] && printf 'active\n' || printf 'inactive\n'
        ;;
      "show --property=ActiveState --value vessel-caller-staging-worker.service")
        [[ "${WORKER_ACTIVE}" == true ]] && printf 'active\n' || printf 'inactive\n'
        ;;
      "stop vessel-caller-staging-web.service") WEB_ACTIVE=false ;;
      "stop vessel-caller-staging-worker.service") WORKER_ACTIVE=false ;;
      "start vessel-caller-staging-web.service") WEB_ACTIVE=true ;;
      "start vessel-caller-staging-worker.service") WORKER_ACTIVE=true ;;
      *) return 0 ;;
    esac
  }
  staging_current_is_compatible() {
    return 0
  }
}

# Normal quiescence stops the public writer before the background writer.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock "${fixture_root}/pause.log"
  pause_staging_writers
  assert_log "${web_probe}"$'\n'"${worker_probe}"$'\nstop vessel-caller-staging-web.service\nstop vessel-caller-staging-worker.service\n'"${web_probe}"$'\n'"${worker_probe}"
)

# A stop failure before cutover restores both services.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock \
    "${fixture_root}/pre-cutover-failure.log" \
    "stop vessel-caller-staging-worker.service"
  if pause_staging_writers; then
    echo "A simulated worker stop failure unexpectedly succeeded." >&2
    exit 1
  fi
  SYSTEMCTL_FAIL=""
  cleanup_paused_staging_writers
  assert_log "${web_probe}"$'\n'"${worker_probe}"$'\nstop vessel-caller-staging-web.service\nstop vessel-caller-staging-worker.service\nstart vessel-caller-staging-worker.service\nstart vessel-caller-staging-web.service\n'"${worker_probe}"$'\n'"${web_probe}"
)

# A mixed baseline is rejected without changing either service.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock \
    "${fixture_root}/baseline-failure.log" \
    "" true false
  if pause_staging_writers; then
    echo "A mixed staging writer baseline unexpectedly passed." >&2
    exit 1
  fi
  [[ "${staging_services_paused}" == "false" ]]
  assert_log "${web_probe}"$'\n'"${worker_probe}"
)

# A retry after a fail-closed cutover accepts both writers already inactive.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock \
    "${fixture_root}/fail-closed-retry.log" \
    "" false false
  pause_staging_writers
  [[ "${staging_services_paused}" == "true" ]]
  SYSTEMCTL_FAIL=""
  resume_staging_writers
  [[ "${staging_services_paused}" == "false" ]]
  assert_log "${web_probe}"$'\n'"${worker_probe}"$'\nstart vessel-caller-staging-worker.service\nstart vessel-caller-staging-web.service\n'"${worker_probe}"$'\n'"${web_probe}"
)

# Once cutover starts, cleanup only stops writers; it must never reopen v0.1.10.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock "${fixture_root}/post-cutover-failure.log"
  staging_services_paused=true
  staging_cutover_started=true
  cleanup_paused_staging_writers
  assert_log $'stop vessel-caller-staging-web.service\nstop vessel-caller-staging-worker.service\n'"${web_probe}"$'\n'"${worker_probe}"
)

# A partial resume fails closed and stops both services again.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock \
    "${fixture_root}/resume-failure.log" \
    "start vessel-caller-staging-web.service" false false
  staging_services_paused=true
  if resume_staging_writers; then
    echo "A simulated web start failure unexpectedly resumed staging." >&2
    exit 1
  fi
  [[ "${staging_services_paused}" == "true" ]]
  assert_log $'start vessel-caller-staging-worker.service\nstart vessel-caller-staging-web.service\n'"${worker_probe}"$'\n'"${web_probe}"$'\nstop vessel-caller-staging-web.service\nstop vessel-caller-staging-worker.service\n'"${web_probe}"$'\n'"${worker_probe}"
)

# An incompatible current release is never restarted after the durable floor.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock "${fixture_root}/incompatible-current.log" "" false false
  staging_current_is_compatible() {
    return 1
  }
  staging_services_paused=true
  if resume_staging_writers; then
    echo "An incompatible staging release unexpectedly resumed." >&2
    exit 1
  fi
  assert_log $'stop vessel-caller-staging-web.service\nstop vessel-caller-staging-worker.service\n'"${web_probe}"$'\n'"${worker_probe}"
)

# Successful resume requires both services to report active.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock "${fixture_root}/resume-success.log" "" false false
  staging_services_paused=true
  resume_staging_writers
  [[ "${staging_services_paused}" == "false" ]]
  assert_log $'start vessel-caller-staging-worker.service\nstart vessel-caller-staging-web.service\n'"${worker_probe}"$'\n'"${web_probe}"
)

# A failed stop is a hard containment failure, even if the other writer stops.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock \
    "${fixture_root}/containment-failure.log" \
    "stop vessel-caller-staging-web.service"
  if stop_staging_writers_fail_closed 2>/dev/null; then
    echo "An uncontained staging web writer was reported as safely stopped." >&2
    exit 1
  fi
  [[ "${WEB_ACTIVE}" == true && "${WORKER_ACTIVE}" == false ]]
  assert_log $'stop vessel-caller-staging-web.service\nstop vessel-caller-staging-worker.service\n'"${web_probe}"$'\n'"${worker_probe}"
)

# Post-cutover cleanup propagates a stop failure to the release entrypoint.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock \
    "${fixture_root}/cleanup-containment-failure.log" \
    "stop vessel-caller-staging-worker.service"
  staging_services_paused=true
  staging_cutover_started=true
  if cleanup_paused_staging_writers 2>/dev/null; then
    echo "Post-cutover cleanup swallowed a writer stop failure." >&2
    exit 1
  fi
  assert_log $'stop vessel-caller-staging-web.service\nstop vessel-caller-staging-worker.service\n'"${web_probe}"$'\n'"${worker_probe}"
)

# Query failures are unknown, never equivalent to both writers being inactive.
(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock \
    "${fixture_root}/probe-failure.log" \
    $'show --property=LoadState --value vessel-caller-staging-web.service\nshow --property=LoadState --value vessel-caller-staging-worker.service'
  if pause_staging_writers 2>/dev/null; then
    echo "Failed service-manager probes were accepted as quiescence." >&2
    exit 1
  fi
  [[ "${WEB_ACTIVE}" == true && "${WORKER_ACTIVE}" == true ]]
  assert_log $'show --property=LoadState --value vessel-caller-staging-web.service'
)

(
  # shellcheck source=deploy/scripts/staging-writer-guard.sh
  source "${guard}"
  install_systemctl_mock \
    "${fixture_root}/worker-probe-failure.log" \
    "show --property=LoadState --value vessel-caller-staging-worker.service"
  if pause_staging_writers 2>/dev/null; then
    echo "A failed worker state probe was accepted as quiescence." >&2
    exit 1
  fi
  [[ "${WEB_ACTIVE}" == true && "${WORKER_ACTIVE}" == true ]]
  assert_log "${web_probe}"$'\nshow --property=LoadState --value vessel-caller-staging-worker.service'
)

echo "Staging writer guard fault injection: passed"
