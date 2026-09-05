#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

python3 - "${repo_root}" <<'PY'
from pathlib import Path
import sys

import yaml

root = Path(sys.argv[1])
for unit_name in (
    "deploy/systemd/vessel-caller-web@.service",
    "deploy/systemd/vessel-caller-staging-web.service",
):
    unit = (root / unit_name).read_text(encoding="utf-8")
    assert "--access-logfile" not in unit, (
        "Gunicorn's default access format includes sensitive query strings; "
        "Nginx owns sanitized access logging"
    )

for nginx_name, format_name in (
    ("deploy/nginx-vessel-caller.conf", "vessel_sanitized"),
    ("deploy/nginx-vessel-caller-staging.conf", "vessel_staging_sanitized"),
):
    nginx = (root / nginx_name).read_text(encoding="utf-8")
    start = nginx.index(f"log_format {format_name}")
    log_format = nginx[start : nginx.index(";", start) + 1]
    assert "$uri" in log_format
    assert "$request " not in log_format and "$request_uri" not in log_format

tasks = yaml.safe_load(
    (root / "ansible/roles/vessel_caller/tasks/main.yml").read_text(encoding="utf-8")
)
by_name = {task.get("name"): task for task in tasks}
production_environment = by_name["Write production slot environments"]

production_slots = by_name["Create production release slots"]["ansible.builtin.file"]
staging_slot = by_name["Create staging release slot"]["ansible.builtin.file"]
assert production_slots["owner"] == "root" and production_slots["mode"] == "0750"
assert staging_slot["owner"] == "root" and staging_slot["mode"] == "0751"

expected = {
    "Fail-close the production System Admin mutation kill switch": (
        "{{ vessel_config_root }}/system-admin-mutations-production.flag",
        "{{ vessel_production_group }}",
    ),
    "Fail-close the staging System Admin mutation kill switch": (
        "{{ vessel_config_root }}/system-admin-mutations-staging.flag",
        "{{ vessel_staging_group }}",
    ),
}
destinations = set()
for name, (destination, group) in expected.items():
    task = by_name[name]
    copy = task["ansible.builtin.copy"]
    assert copy["dest"] == destination
    assert copy["owner"] == "root"
    assert copy["group"] == group
    assert copy["mode"] == "0640"
    assert copy["content"] == "disabled\n"
    assert "notify" not in task, "the request-time kill switch must not require a restart"
    assert tasks.index(task) < tasks.index(production_environment)
    destinations.add(destination)
assert len(destinations) == 2, "production and staging must never share a kill-switch file"

for environment in ("staging", "production"):
    run = by_name[
        f"Verify and enable {environment} System Admin mutations under the release lock"
    ]
    argv = run["ansible.builtin.command"]["argv"]
    assert argv == [
        "/usr/local/lib/vessel-caller/enable-system-admin-mutations.sh",
        environment,
        f"{{{{ vessel_{environment}_system_admin_qualified_release_tag }}}}",
        f"{{{{ vessel_{environment}_system_admin_qualified_release_sha }}}}",
        f"{{{{ vessel_{environment}_resend_api_key | hash('sha256') }}}}",
        f"{{{{ vessel_{environment}_email_from | hash('sha256') }}}}",
    ]
    assert run["no_log"] is True
    assert any(
        f"vessel_{environment}_system_admin_mutations_enabled" in str(value)
        for value in run["when"]
    )
    fail_close = by_name[
        f"Fail-close the {environment} System Admin mutation kill switch"
    ]
    assert tasks.index(fail_close) < tasks.index(run)

installed_scripts = by_name["Install release and operational scripts"][
    "ansible.builtin.copy"
]
assert installed_scripts["owner"] == "root"
assert installed_scripts["mode"] == "0755"
installed_script_names = by_name["Install release and operational scripts"]["loop"]
assert "enable-system-admin-mutations.sh" in installed_script_names
assert "staging-writer-guard.sh" in installed_script_names
assert "staging-compatibility-guard.sh" in installed_script_names
assert "staging-lifecycle-state.sh" in installed_script_names
assert "release-target-policy.sh" in installed_script_names

enable_script = (
    root / "deploy/scripts/enable-system-admin-mutations.sh"
).read_text(encoding="utf-8")
assert "exec 9>/run/lock/vessel-caller-release.lock" in enable_script
assert "flock --exclusive --wait" in enable_script
assert 'slot_roots=("${app_root}/slots/staging")' in enable_script
assert '"${app_root}/slots/production-blue"' in enable_script
assert '"${app_root}/slots/production-green"' in enable_script
assert '!= "root:${runtime_group}:${slot_mode}"' in enable_script
assert '"${app_root}/releases/${expected_tag}/${slot_name}"' in enable_script
assert 'stat -c \'%U\' "${current_link}"' in enable_script
assert enable_script.count("probe_qualified_slots") >= 3
assert enable_script.count("require_runtime_email_delivery") >= 3
assert enable_script.index("exec 9>/run/lock/vessel-caller-release.lock") < enable_script.index(
    "probe_qualified_slots()"
)
assert enable_script.rindex("probe_qualified_slots") < enable_script.rindex(
    "printf 'enabled\\n'"
)
assert "system_admin_rollout_preflight --evidence-file -" in enable_script
assert ".capabilities.systemAdminEmailDeliveryReady == true" in enable_script
assert 'values.get(b"VC_EMAIL_DELIVERY_BACKEND", b"")' in enable_script
assert '!= "resend ${expected_resend_key_sha} ${expected_email_from_sha}"' in enable_script
assert 'values.get(b"VC_RESEND_API_KEY", b"")' in enable_script
assert 'values.get(b"VC_EMAIL_FROM", b"")' in enable_script
assert "/proc/${process_pid}/environ" in enable_script
assert "expected_resend_key_sha" in enable_script
assert "expected_email_from_sha" in enable_script
assert 'for required_path in "${runtime_env}" "${release_env}" "${manage}"' in enable_script
assert 'resolved_python="$(readlink -f -- "${python}")"' in enable_script
assert 'stat -c \'%U\' "${resolved_python}"' in enable_script
assert 'stat -c \'%a\' "${resolved_python}"' in enable_script
assert "/usr/bin/systemd-run" in enable_script
assert "--property=EnvironmentFile=${runtime_env}" in enable_script
assert "--property=EnvironmentFile=${release_env}" in enable_script
assert "--uid=${runtime_user}" in enable_script
assert "--gid=${runtime_group}" in enable_script
assert "${runtime_environment}-${expected_tag}-${expected_sha}.json" in enable_script
assert "install -d -o root -g root -m 0700" in enable_script
assert "root:root:700" in enable_script
assert "chmod 0600" in enable_script
assert "chown root:root" in enable_script
assert "printf 'enabled\\n'" in enable_script
assert enable_script.index("probe_qualified_slots") < enable_script.rindex("printf 'enabled\\n'")

install_script = (root / "deploy/scripts/install-release.sh").read_text(encoding="utf-8")
assert 'install -d -o root -g "${app_group}" -m 0750 "${slot_root}"' in install_script
assert 'if [[ "${instance}" == staging ]]' in install_script
assert 'chmod o+x "${slot_root}"' in install_script
assert "Staging web and worker must be stopped before release preparation." in install_script
assert "Staging preparation failed after cutover began; writers remain stopped." in install_script
assert "Missing or untrusted protected staging seed environment." in install_script
assert "Staging preparation was skipped or did not complete; writers remain stopped." in install_script
assert "--property=AssertResult" in install_script
assert "--property=ExecMainStatus" in install_script
assert "Staging candidate failed readiness; writers remain stopped." in install_script
staging_prepare_failure = install_script.split(
    'if ! flock /run/lock/vessel-caller-migrate.lock', 1
)[1].split('systemctl restart "${web_unit}"', 1)[0]
assert 'if [[ "${instance}" == staging ]]' in staging_prepare_failure
assert 'ln -sfn "${previous_target}" "${slot_root}/current"' in staging_prepare_failure

deploy_script = (root / "deploy/scripts/deploy-release.sh").read_text(encoding="utf-8")
writer_guard = (
    root / "deploy/scripts/staging-writer-guard.sh"
).read_text(encoding="utf-8")
compatibility_guard = (
    root / "deploy/scripts/staging-compatibility-guard.sh"
).read_text(encoding="utf-8")
lifecycle_state = (
    root / "deploy/scripts/staging-lifecycle-state.sh"
).read_text(encoding="utf-8")
target_policy = (
    root / "deploy/scripts/release-target-policy.sh"
).read_text(encoding="utf-8")
assert "exec 9>/run/lock/vessel-caller-release.lock" in deploy_script
assert 'script_path="$(readlink -f -- "${BASH_SOURCE[0]}")"' in deploy_script
assert 'script_dir="$(dirname -- "${script_path}")"' in deploy_script
assert "Installed deployment helper is not trusted" in deploy_script
assert 'source "${script_dir}/staging-writer-guard.sh"' in deploy_script
assert 'source "${script_dir}/release-target-policy.sh"' in deploy_script
assert "fail_close_system_admin_mutations()" in deploy_script
assert deploy_script.count("fail_close_system_admin_mutations") == 3
assert 'config_root=/etc/vessel-caller' in deploy_script
assert 'system-admin-mutations-${runtime_environment}.flag' in deploy_script
assert 'root:root:755' in deploy_script
assert 'root:${runtime_group}:640' in deploy_script
assert "printf 'disabled\\n'" in deploy_script
assert 'chown "root:${runtime_group}"' in deploy_script
assert "chmod 0640" in deploy_script
assert 'mv -f "${temporary_flag}" "${flag_file}"' in deploy_script
assert deploy_script.index("exec 9>/run/lock/vessel-caller-release.lock") < deploy_script.index(
    "fail_close_system_admin_mutations staging vessel-caller-staging"
)
assert deploy_script.index('snapshot-release.py" "${archive}"') < deploy_script.index(
    '"${script_dir}/verify-release.sh" "${archive}"'
)
assert "release_snapshot_base=/var/lib/vessel-caller" in deploy_script
assert "root:root:755" in deploy_script
assert '.release-input.XXXXXX' in deploy_script
assert "trap handle_deploy_release_exit EXIT" in deploy_script
assert 'rm -rf -- "${release_snapshot_root}"' in deploy_script
staging_case = deploy_script.split('  staging)\n', 1)[1].split('  production)\n', 1)[0]
assert staging_case.index(
    "fail_close_system_admin_mutations staging vessel-caller-staging"
)
assert staging_case.index(
    "fail_close_system_admin_mutations staging vessel-caller-staging"
) < staging_case.index("pause_staging_writers")
assert staging_case.index("pause_staging_writers") < staging_case.index(
    "staging_cutover_started=true"
) < staging_case.index(
    'enforce_staging_compatibility_floor "${archive}"'
) < staging_case.index(
    '"${script_dir}/install-release.sh" staging'
)
assert staging_case.index('"${script_dir}/install-release.sh" staging') < staging_case.index(
    "resume_staging_writers"
)
assert 'systemctl stop "${staging_web_unit}"' in writer_guard
assert 'systemctl stop "${staging_worker_unit}"' in writer_guard
assert writer_guard.index(
    'systemctl stop "${staging_web_unit}"'
) < writer_guard.index('systemctl stop "${staging_worker_unit}"')
assert 'systemctl start "${staging_worker_unit}"' in writer_guard
assert 'systemctl start "${staging_web_unit}"' in writer_guard
assert "staging_current_is_compatible" in writer_guard
assert "staging_unit_activity()" in writer_guard
assert "--property=LoadState --value" in writer_guard
assert "--property=ActiveState --value" in writer_guard
assert '[[ "${load_state}" != loaded ]]' in writer_guard
assert "inactive|failed" in writer_guard
assert "unsafe transitional state" in writer_guard
assert "staging_unit_activity" in install_script
assert "staging_cutover_started=true" in staging_case
assert "staging_cutover_verified=true" in staging_case
assert "seed_e2e --force" not in deploy_script
assert "cleanup_paused_staging_writers()" in writer_guard
assert "handle_staging_writer_exit()" in writer_guard
for unit_name in (
    "vessel-caller-staging-web.service",
    "vessel-caller-staging-worker.service",
    "vessel-caller-staging-prepare.service",
):
    unit = (root / "deploy/systemd" / unit_name).read_text(encoding="utf-8")
    assert "ExecStartPre=/usr/local/lib/vessel-caller/staging-compatibility-guard.sh" in unit
prepare_unit = (
    root / "deploy/systemd/vessel-caller-staging-prepare.service"
).read_text(encoding="utf-8")
assert "AssertPathExists=/etc/vessel-caller/staging-e2e.env" in prepare_unit
assert "ConditionPathExists=/etc/vessel-caller/staging-e2e.env" not in prepare_unit
assert 'organizationApprovalLifecycle == true' in compatibility_guard
assert 'staging-organization-approval-lifecycle.cutover' in compatibility_guard
assert "staging-lifecycle-state.sh" in compatibility_guard
assert "django_migrations" in lifecycle_state
assert "to_regclass('django_migrations')" in lifecycle_state
assert "0004_organization_approval_lifecycle" in lifecycle_state
assert "PGCONNECT_TIMEOUT=5" in lifecycle_state
assert "state_root_base=/var/lib/vessel-caller/staging" in lifecycle_state
assert "vessel-caller-staging:vessel-caller-staging:750" in lifecycle_state
assert "read_staging_lifecycle_state" in target_policy
assert install_script.index('if [[ "${instance}" == staging ]]') < install_script.index(
    'systemctl restart "${web_unit}"'
)
production_case = deploy_script.split('  production)\n', 1)[1].split('  *)\n', 1)[0]
assert production_case.index('"${script_dir}/verify-release.sh" "${archive}"') < production_case.index(
    'enforce_release_target_policy production "${archive}"'
)
assert production_case.index(
    'enforce_release_target_policy production "${archive}"'
) < production_case.index(
    "fail_close_system_admin_mutations production vessel-caller-production"
)
assert production_case.index(
    "fail_close_system_admin_mutations production vessel-caller-production"
) < production_case.index('"${script_dir}/install-release.sh" "${candidate}"')
assert '.stagingOnlySchemaCutover == true' in target_policy
assert ".organizationApprovalLifecycle == true" in target_policy
assert "staging-organization-approval-lifecycle.cutover" in target_policy
assert "organizationApprovalLifecycle=true" in target_policy
assert target_policy.index('sync -f "${temporary_marker}"') < target_policy.index(
    'mv -f -- "${temporary_marker}" "${marker}"'
) < target_policy.index('sync -f "${marker_dir}"')
assert "production deployment is blocked" in target_policy

build_script = (root / "deploy/scripts/build-release.sh").read_text(encoding="utf-8")
assert "stagingOnlySchemaCutover: true" in build_script
assert "organizationApprovalLifecycle: true" in build_script
deploy_workflow = (root / ".github/workflows/deploy.yml").read_text(encoding="utf-8")
assert "Enforce signed release target policy" in deploy_workflow
assert '.stagingOnlySchemaCutover == true' in deploy_workflow
assert '.organizationApprovalLifecycle == true' in deploy_workflow
assert "legacy tag checkouts need not contain the policy helper" in deploy_workflow
assert deploy_workflow.index("Download immutable release") < deploy_workflow.index(
    "Enforce signed release target policy"
) < deploy_workflow.index("Upload and install inactive release")

qualification_workflow = (
    root / ".github/workflows/qualification.yml"
).read_text(encoding="utf-8")
assert qualification_workflow.count(".stagingOnlySchemaCutover != true") >= 2
assert qualification_workflow.count(".organizationApprovalLifecycle == true") >= 2
assert qualification_workflow.index(".stagingOnlySchemaCutover != true") < qualification_workflow.index(
    "Publish production qualification evidence"
)

email_backend = production_environment["vars"]["runtime_email_delivery_backend"]
assert "vessel_production_resend_api_key" in email_backend
assert "vessel_production_deferred_provider_cutover" not in email_backend, (
    "Resend delivery and deferred Sentry qualification are independent gates"
)

runtime = (root / "ansible/roles/vessel_caller/templates/runtime.env.j2").read_text(
    encoding="utf-8"
)
assert "VC_SYSTEM_ADMIN_MUTATIONS_ENABLED=false" in runtime
assert (
    "VC_SYSTEM_ADMIN_MUTATION_FLAG_FILE="
    "{{ runtime_system_admin_mutation_flag_file | to_json }}"
) in runtime

bootstrap = (root / "ansible/playbooks/bootstrap.yml").read_text(encoding="utf-8")
for port in (8001, 8002, 8010):
    assert f"port: {port}" in bootstrap
assert "organizationAccessStatus" in bootstrap
assert "systemAdminEmailDeliveryReady" in bootstrap
assert "/api/readiness" in bootstrap
assert "system_admin_capability_probe.json.release.tag != item.expected_tag" in bootstrap
assert "system_admin_capability_probe.json.release.sha != item.expected_sha" in bootstrap
assert "vessel_production_resend_api_key | length > 0" in bootstrap
deferred_provider_gate = bootstrap.split(
    "Keep deferred production telemetry disabled and reject placeholder email keys", 1
)[1].split("when:", 1)[0]
assert "vessel_production_email_from | length > 0" in deferred_provider_gate
assert "'CHANGE_ME' not in vessel_production_email_from" in deferred_provider_gate
system_admin_gate = bootstrap.split(
    "not (vessel_production_system_admin_mutations_enabled | bool)", 1
)[1].split("fail_msg:", 1)[0]
assert "vessel_production_deferred_provider_cutover" not in system_admin_gate
assert "vessel_production_email_from | length > 0" in system_admin_gate
PY

echo "System Admin infrastructure controls: passed"
