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
assert "enable-system-admin-mutations.sh" in by_name[
    "Install release and operational scripts"
]["loop"]

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

deploy_script = (root / "deploy/scripts/deploy-release.sh").read_text(encoding="utf-8")
assert "exec 9>/run/lock/vessel-caller-release.lock" in deploy_script
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
staging_case = deploy_script.split('  staging)\n', 1)[1].split('  production)\n', 1)[0]
assert staging_case.index(
    "fail_close_system_admin_mutations staging vessel-caller-staging"
) < staging_case.index('"${script_dir}/install-release.sh" staging')
production_case = deploy_script.split('  production)\n', 1)[1].split('  *)\n', 1)[0]
assert production_case.index(
    "fail_close_system_admin_mutations production vessel-caller-production"
) < production_case.index('"${script_dir}/install-release.sh" "${candidate}"')

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
