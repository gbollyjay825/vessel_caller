#!/usr/bin/env bash
set -euo pipefail

release_tag="${1:-}"
output_dir="${2:-artifacts}"

if [[ ! "${release_tag}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Usage: $0 <vMAJOR.MINOR.PATCH> [output-directory]" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
cd "${repo_root}"

tag_commit="$(git rev-parse "${release_tag}^{commit}")"
head_commit="$(git rev-parse HEAD)"
if [[ "${tag_commit}" != "${head_commit}" ]]; then
  echo "HEAD ${head_commit} does not match ${release_tag} (${tag_commit})." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing to package a dirty working tree." >&2
  exit 1
fi
if [[ ! -f backend/manage.py || ! -f backend/requirements/production.txt ]]; then
  echo "Django backend or production requirements are missing." >&2
  exit 1
fi

stage_root="$(mktemp -d)"
trap 'rm -rf "${stage_root}"' EXIT
source_root="${stage_root}/source"
mkdir -p "${source_root}"
git archive --format=tar "${head_commit}" | tar -xf - -C "${source_root}"

npm ci --prefix "${source_root}/frontend"
npm --prefix "${source_root}/frontend" run build

release_name="vessel-caller-${release_tag}"
payload="${stage_root}/${release_name}"
mkdir -p "${payload}/backend" "${payload}/frontend" "${payload}/wheelhouse" "${output_dir}"

rsync -a "${source_root}/backend/" "${payload}/backend/"
rsync -a "${source_root}/frontend/dist/" "${payload}/frontend/dist/"
rsync -a "${source_root}/deploy/" "${payload}/deploy/"
rsync -a "${source_root}/docs/" "${payload}/docs/"

python -m pip download \
  --disable-pip-version-check \
  --only-binary=:all: \
  --require-hashes \
  --requirement "${source_root}/backend/requirements/production.txt" \
  --dest "${payload}/wheelhouse"

source_date_epoch="$(git show -s --format=%ct HEAD)"
commit_timestamp="$(git show -s --format=%cI HEAD)"
sbom_uuid="${head_commit:0:8}-${head_commit:8:4}-${head_commit:12:4}-${head_commit:16:4}-${head_commit:20:12}"
jq -n \
  --arg release "${release_tag}" \
  --arg commit "${head_commit}" \
  --arg created "${commit_timestamp}" \
  --arg python "$(tr -d '[:space:]' < "${source_root}/.python-version")" \
  --arg node "$(tr -d '[:space:]' < "${source_root}/.nvmrc")" \
  '{
    schemaVersion: 1,
    application: "vessel-caller",
    release: $release,
    commit: $commit,
    createdAt: $created,
    runtimes: {python: $python, node: $node},
    immutable: true
  }' > "${payload}/RELEASE.json"

checksum_file="${stage_root}/SHA256SUMS"
(
  cd "${payload}"
  find . -type f ! -name SHA256SUMS -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
) > "${checksum_file}"
mv "${checksum_file}" "${payload}/SHA256SUMS"

mkdir -p "${repo_root}/${output_dir}"
archive="${repo_root}/${output_dir}/${release_name}.tar.gz"
if tar --help 2>&1 | grep -q -- '--sort'; then
  tar \
    --sort=name \
    --mtime="@${source_date_epoch}" \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    -C "${stage_root}" \
    -czf "${archive}" \
    "${release_name}"
else
  tar -C "${stage_root}" -czf "${archive}" "${release_name}"
fi

(
  cd "$(dirname "${archive}")"
  sha256sum "$(basename "${archive}")" > "$(basename "${archive}").sha256"
)

jq -n \
  --arg release "${release_tag}" \
  --arg commit "${head_commit}" \
  --arg serial "urn:uuid:${sbom_uuid}" \
  --arg archive "$(basename "${archive}")" \
  '{
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: $serial,
    version: 1,
    metadata: {
      component: {
        type: "application",
        name: "vessel-caller",
        version: $release,
        properties: [
          {name: "vessel-caller:git-commit", value: $commit},
          {name: "vessel-caller:release-archive", value: $archive}
        ]
      }
    }
  }' > "${repo_root}/${output_dir}/${release_name}.sbom.json"

echo "Built ${archive}"
