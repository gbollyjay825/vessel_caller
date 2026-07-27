#!/usr/bin/env bash
set -euo pipefail

archive="${1:-}"
if [[ -z "${archive}" || ! -f "${archive}" || ! -f "${archive}.sha256" ]]; then
  echo "Usage: $0 <release.tar.gz> (with adjacent .sha256)" >&2
  exit 2
fi

archive_dir="$(cd "$(dirname "${archive}")" && pwd)"
archive_name="$(basename "${archive}")"
release_name="${archive_name%.tar.gz}"
release_tag="${release_name#vessel-caller-}"
if [[ "${release_name}" == "${archive_name}" ]] \
  || [[ ! "${release_tag}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "Archive must be named vessel-caller-vMAJOR.MINOR.PATCH.tar.gz." >&2
  exit 1
fi

signature_key="${RELEASE_SIGNATURE_PUBLIC_KEY:-/etc/vessel-caller/release-signing-public.pem}"
if [[ "${REQUIRE_RELEASE_SIGNATURE:-false}" == "true" || -f "${signature_key}" ]]; then
  if [[ ! -r "${signature_key}" || ! -f "${archive}.sig" ]]; then
    echo "Release signature or pinned verification key is missing." >&2
    exit 1
  fi
  first_key_line="$(head -n 1 "${signature_key}")"
  if [[ "${first_key_line}" == ssh-ed25519\ * ]]; then
    allowed_signers="$(mktemp)"
    printf 'release %s\n' "${first_key_line}" > "${allowed_signers}"
    if ! ssh-keygen \
      -Y verify \
      -f "${allowed_signers}" \
      -I release \
      -n vessel-caller-release \
      -s "${archive}.sig" \
      < "${archive}"; then
      rm -f "${allowed_signers}"
      exit 1
    fi
    rm -f "${allowed_signers}"
  else
    openssl dgst \
      -sha256 \
      -verify "${signature_key}" \
      -signature "${archive}.sig" \
      "${archive}"
  fi
fi
(
  cd "${archive_dir}"
  sha256sum --check "${archive_name}.sha256"
)

if tar -tzf "${archive}" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  echo "Archive contains an unsafe path." >&2
  exit 1
fi
if tar -tvzf "${archive}" | grep -Eq '^[lhbcp]'; then
  echo "Archive contains links or special device entries." >&2
  exit 1
fi

verify_root="$(mktemp -d)"
trap 'rm -rf "${verify_root}"' EXIT
tar --no-same-owner --no-same-permissions -xzf "${archive}" -C "${verify_root}"
payload="${verify_root}/${release_name}"
if [[ -z "${payload}" || ! -f "${payload}/SHA256SUMS" || ! -f "${payload}/RELEASE.json" ]]; then
  echo "Release metadata is incomplete." >&2
  exit 1
fi
(
  cd "${payload}"
  sha256sum --check SHA256SUMS
)

jq -e \
  --arg release "${release_tag}" \
  '.schemaVersion == 1 and .immutable == true and .release == $release' \
  "${payload}/RELEASE.json" >/dev/null
echo "Verified $(basename "${archive}")."
