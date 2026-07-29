#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

while IFS= read -r script; do
  bash -n "${script}"
done < <(find "${repo_root}/deploy" -type f -name '*.sh' | LC_ALL=C sort)
echo "Bash syntax: passed"

if command -v ruby >/dev/null; then
  while IFS= read -r yaml; do
    ruby -e 'require "yaml"; YAML.safe_load(File.read(ARGV.fetch(0)), [], [], true)' "${yaml}"
  done < <(find "${repo_root}/.github" "${repo_root}/ansible" -type f \( -name '*.yml' -o -name '*.yaml' \) | LC_ALL=C sort)
  echo "YAML syntax: passed"
else
  echo "YAML syntax: skipped (Ruby/Psych unavailable)"
fi

python3 -m json.tool "${repo_root}/deploy/backup-lifecycle.json" >/dev/null
echo "JSON syntax: passed"

if command -v shellcheck >/dev/null; then
  find "${repo_root}/deploy" "${repo_root}/tests/infra" -type f -name '*.sh' -print0 \
    | xargs -0 shellcheck
  echo "ShellCheck: passed"
else
  echo "ShellCheck: skipped (shellcheck unavailable)"
fi

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  docker compose -f "${repo_root}/compose.yml" config --quiet
  echo "Docker Compose: passed"
else
  echo "Docker Compose: skipped (Compose plugin unavailable)"
fi

if command -v ansible-playbook >/dev/null; then
  (
    cd "${repo_root}/ansible"
    ANSIBLE_CONFIG="${repo_root}/ansible/ansible.cfg" \
      ansible-playbook \
      --syntax-check \
      --inventory inventory/hosts.example.yml \
      playbooks/preflight.yml
    ANSIBLE_CONFIG="${repo_root}/ansible/ansible.cfg" \
      ansible-playbook \
      --syntax-check \
      --inventory inventory/hosts.example.yml \
      playbooks/bootstrap.yml
    ANSIBLE_CONFIG="${repo_root}/ansible/ansible.cfg" \
      ansible-playbook \
      --syntax-check \
      --inventory inventory/hosts.example.yml \
      playbooks/verify.yml
  )
  echo "Ansible syntax: passed"
else
  echo "Ansible syntax: skipped (ansible-playbook unavailable)"
fi

echo "Available infrastructure validation completed."
