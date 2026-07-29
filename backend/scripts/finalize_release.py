from __future__ import annotations

import argparse
import hashlib
import os
import re
import subprocess
import tempfile
from collections.abc import Mapping
from pathlib import Path

from .release_signing import (
    ReleaseSigningError,
    load_private_key,
    load_public_key,
    public_keys_match,
    read_private_key_from_keychain,
    sign_archive,
    verify_archive,
)

SEMANTIC_TAG = re.compile(
    r"^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z.-]+)?$"
)


def _run(command: list[str], *, capture_output: bool = False) -> subprocess.CompletedProcess:
    return subprocess.run(  # noqa: S603 - arguments are fixed or strictly validated.
        command,
        check=True,
        capture_output=capture_output,
        text=True,
    )


def _verify_checksum(archive: Path) -> None:
    checksum_file = archive.with_name(f"{archive.name}.sha256")
    try:
        fields = checksum_file.read_text(encoding="utf-8").strip().split()
    except OSError as exc:
        raise ReleaseSigningError("The draft release checksum is missing") from exc
    if len(fields) != 2 or fields[1].lstrip("*") != archive.name:
        raise ReleaseSigningError("The draft release checksum manifest is invalid")
    expected = fields[0].lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ReleaseSigningError("The draft release checksum is invalid")
    digest = hashlib.sha256()
    with archive.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != expected:
        raise ReleaseSigningError("The draft release archive does not match its checksum")


def _repository_name() -> str:
    result = _run(
        ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        capture_output=True,
    )
    repository = result.stdout.strip()
    if not repository or "/" not in repository:
        raise ReleaseSigningError("Could not resolve the GitHub repository")
    return repository


def _require_draft_release(tag: str) -> None:
    result = _run(
        [
            "gh",
            "release",
            "view",
            tag,
            "--json",
            "isDraft,tagName",
            "--jq",
            "[.tagName, (.isDraft | tostring)] | @tsv",
        ],
        capture_output=True,
    )
    if result.stdout.strip() != f"{tag}\ttrue":
        raise ReleaseSigningError("The target must be the exact unpublished draft release")


def finalize_release(tag: str, *, environ: Mapping[str, str] = os.environ) -> None:
    if not SEMANTIC_TAG.fullmatch(tag):
        raise ReleaseSigningError("Release tag must use semantic vMAJOR.MINOR.PATCH syntax")
    public_material = environ.get("RELEASE_SIGNING_PUBLIC_KEY", "").strip()
    if not public_material:
        raise ReleaseSigningError("RELEASE_SIGNING_PUBLIC_KEY is required")

    repository = _repository_name()
    _require_draft_release(tag)
    release_name = f"vessel-caller-{tag}"
    with tempfile.TemporaryDirectory(prefix="vessel-caller-release-") as temporary:
        artifact_dir = Path(temporary)
        _run(
            [
                "gh",
                "release",
                "download",
                tag,
                "--dir",
                str(artifact_dir),
                "--pattern",
                f"{release_name}.tar.gz*",
            ]
        )
        archive = artifact_dir / f"{release_name}.tar.gz"
        if not archive.is_file():
            raise ReleaseSigningError("The draft release archive is missing")
        _verify_checksum(archive)
        _run(["gh", "attestation", "verify", str(archive), "--repo", repository])

        key_material = read_private_key_from_keychain()
        try:
            private_key = load_private_key(key_material)
        finally:
            key_material[:] = b"\0" * len(key_material)
        public_key = load_public_key(public_material)
        if not public_keys_match(private_key, public_key):
            raise ReleaseSigningError(
                "The Keychain private key does not match RELEASE_SIGNING_PUBLIC_KEY"
            )

        signature = sign_archive(archive, private_key)
        verify_archive(archive, signature, public_key)
        signature_path = archive.with_name(f"{archive.name}.sig")
        signature_path.write_bytes(signature)
        signature_path.chmod(0o644)

        _run(["gh", "release", "upload", tag, str(signature_path), "--clobber"])
        _run(["gh", "release", "edit", tag, "--draft=false"])
    print(f"Published signed immutable release {tag}.")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Sign and publish a CI-built draft release with the approved Keychain key."
    )
    parser.add_argument("tag", help="Existing CI-created draft vMAJOR.MINOR.PATCH release")
    args = parser.parse_args()
    try:
        finalize_release(args.tag)
    except (OSError, subprocess.CalledProcessError, ReleaseSigningError) as exc:
        parser.exit(1, f"Release finalization failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
