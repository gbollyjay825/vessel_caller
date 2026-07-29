from __future__ import annotations

import hashlib
import base64
import subprocess
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, rsa

from scripts import finalize_release, release_signing
from scripts.release_signing import ReleaseSigningError


def _private_material(key) -> bytes:
    if isinstance(key, ed25519.Ed25519PrivateKey):
        private_format = serialization.PrivateFormat.OpenSSH
    else:
        private_format = serialization.PrivateFormat.PKCS8
    return key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=private_format,
        encryption_algorithm=serialization.NoEncryption(),
    )


def _public_material(key, *, openssh: bool = False) -> bytes:
    if openssh:
        return key.public_key().public_bytes(
            encoding=serialization.Encoding.OpenSSH,
            format=serialization.PublicFormat.OpenSSH,
        )
    return key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )


def test_ed25519_openssh_signature_verifies_and_rejects_tampering(tmp_path):
    archive = tmp_path / "vessel-caller-v1.2.3.tar.gz"
    archive.write_bytes(b"immutable release bytes")
    private_key = ed25519.Ed25519PrivateKey.generate()
    loaded_private = release_signing.load_private_key(_private_material(private_key))
    public_key = release_signing.load_public_key(_public_material(private_key, openssh=True))

    signature = release_signing.sign_archive(archive, loaded_private)

    assert signature.startswith(b"-----BEGIN SSH SIGNATURE-----")
    release_signing.verify_archive(archive, signature, public_key)
    signature_path = archive.with_name(f"{archive.name}.sig")
    signature_path.write_bytes(signature)
    allowed_signers = tmp_path / "allowed_signers"
    allowed_signers.write_bytes(b"release " + _public_material(private_key, openssh=True) + b"\n")
    openssh_result = subprocess.run(  # noqa: S603 - fixed verifier and fixture paths.
        [
            "/usr/bin/ssh-keygen",
            "-Y",
            "verify",
            "-f",
            str(allowed_signers),
            "-I",
            "release",
            "-n",
            "vessel-caller-release",
            "-s",
            str(signature_path),
        ],
        input=archive.read_bytes(),
        capture_output=True,
        check=False,
    )
    assert openssh_result.returncode == 0

    archive.write_bytes(b"tampered release bytes")
    with pytest.raises(ReleaseSigningError, match="verification failed"):
        release_signing.verify_archive(archive, signature, public_key)


@pytest.mark.parametrize(
    "private_key",
    [
        pytest.param(rsa.generate_private_key(public_exponent=65537, key_size=2048), id="rsa"),
        pytest.param(ec.generate_private_key(ec.SECP256R1()), id="ecdsa"),
    ],
)
def test_legacy_pem_signatures_remain_compatible(private_key, tmp_path):
    archive = tmp_path / "vessel-caller-v1.2.3.tar.gz"
    archive.write_bytes(b"legacy-compatible release")
    loaded_private = release_signing.load_private_key(_private_material(private_key))
    public_key = release_signing.load_public_key(_public_material(private_key))

    signature = release_signing.sign_archive(archive, loaded_private)

    release_signing.verify_archive(archive, signature, public_key)


def test_keychain_lookup_uses_fixed_service_and_account_without_text_output(monkeypatch):
    private_key = ed25519.Ed25519PrivateKey.generate()
    material = _private_material(private_key)
    observed = {}

    def fake_run(command, **kwargs):
        observed["command"] = command
        observed["kwargs"] = kwargs
        return subprocess.CompletedProcess(
            command,
            0,
            stdout=base64.b64encode(material) + b"\n",
            stderr=b"",
        )

    monkeypatch.setattr(release_signing.sys, "platform", "darwin")
    returned = release_signing.read_private_key_from_keychain(run=fake_run)

    assert returned == bytearray(material)
    assert observed == {
        "command": [
            "/usr/bin/security",
            "find-generic-password",
            "-w",
            "-s",
            "vessel-caller-release-signing-key",
            "-a",
            "gbolahan-salami",
        ],
        "kwargs": {
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "check": False,
        },
    }


def test_keychain_lookup_rejects_non_base64_secret(monkeypatch):
    def fake_run(command, **kwargs):
        return subprocess.CompletedProcess(command, 0, stdout=b"not base64!", stderr=b"")

    monkeypatch.setattr(release_signing.sys, "platform", "darwin")
    with pytest.raises(ReleaseSigningError, match="strict base64"):
        release_signing.read_private_key_from_keychain(run=fake_run)


def test_private_and_public_key_must_match():
    private_key = ed25519.Ed25519PrivateKey.generate()
    different_key = ed25519.Ed25519PrivateKey.generate()
    assert release_signing.public_keys_match(private_key, private_key.public_key())
    assert not release_signing.public_keys_match(private_key, different_key.public_key())


def test_release_workflow_creates_unsigned_draft_for_local_finalization():
    repository_root = Path(__file__).resolve().parents[2]
    workflow = (repository_root / ".github/workflows/release.yml").read_text(encoding="utf-8")

    assert "RELEASE_SIGNING_PRIVATE_KEY" not in workflow
    assert "--draft" in workflow
    assert "artifacts/vessel-caller-${RELEASE_TAG}.tar.gz.sig" not in workflow


def test_finalizer_signs_draft_then_publishes_without_exposing_private_key(
    monkeypatch,
    capsys,
):
    tag = "v1.2.3"
    archive_name = f"vessel-caller-{tag}.tar.gz"
    archive_bytes = b"attested immutable archive"
    private_key = ed25519.Ed25519PrivateKey.generate()
    private_material = _private_material(private_key)
    public_material = _public_material(private_key, openssh=True).decode()
    commands = []
    uploaded_signature = {}

    def fake_run(command, *, capture_output=False):
        commands.append(command)
        if command[:3] == ["gh", "repo", "view"]:
            return subprocess.CompletedProcess(command, 0, stdout="owner/repository\n", stderr="")
        if command[:3] == ["gh", "release", "view"]:
            return subprocess.CompletedProcess(command, 0, stdout=f"{tag}\ttrue\n", stderr="")
        if command[:3] == ["gh", "release", "download"]:
            artifact_dir = Path(command[command.index("--dir") + 1])
            archive = artifact_dir / archive_name
            archive.write_bytes(archive_bytes)
            checksum = hashlib.sha256(archive_bytes).hexdigest()
            archive.with_name(f"{archive.name}.sha256").write_text(
                f"{checksum}  {archive.name}\n",
                encoding="utf-8",
            )
        if command[:3] == ["gh", "release", "upload"]:
            uploaded_signature["value"] = Path(command[4]).read_bytes()
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(finalize_release, "_run", fake_run)
    monkeypatch.setattr(
        finalize_release,
        "read_private_key_from_keychain",
        lambda: bytearray(private_material),
    )

    finalize_release.finalize_release(
        tag,
        environ={"RELEASE_SIGNING_PUBLIC_KEY": public_material},
    )

    assert uploaded_signature["value"].startswith(b"-----BEGIN SSH SIGNATURE-----")
    assert commands[-1] == ["gh", "release", "edit", tag, "--draft=false"]
    assert private_material.decode() not in capsys.readouterr().out
    assert all(private_material.decode() not in " ".join(command) for command in commands)
