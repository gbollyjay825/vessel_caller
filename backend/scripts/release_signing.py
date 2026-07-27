from __future__ import annotations

import base64
import binascii
import hashlib
import struct
import subprocess
import sys
import textwrap
from collections.abc import Callable
from pathlib import Path

from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa, utils

KEYCHAIN_SERVICE = "vessel-caller-release-signing-key"
KEYCHAIN_ACCOUNT = "gbolahan-salami"
SSHSIG_IDENTITY = "release"
SSHSIG_NAMESPACE = b"vessel-caller-release"
SSHSIG_HASH_ALGORITHM = b"sha512"
_SSHSIG_MAGIC = b"SSHSIG"
_SSHSIG_VERSION = 1

PrivateKey = ed25519.Ed25519PrivateKey | rsa.RSAPrivateKey | ec.EllipticCurvePrivateKey
PublicKey = ed25519.Ed25519PublicKey | rsa.RSAPublicKey | ec.EllipticCurvePublicKey
RunCommand = Callable[..., subprocess.CompletedProcess]


class ReleaseSigningError(RuntimeError):
    """A fail-closed release-signing or verification error."""


def _ssh_string(value: bytes) -> bytes:
    return struct.pack(">I", len(value)) + value


def _read_ssh_string(payload: bytes, offset: int) -> tuple[bytes, int]:
    if len(payload) - offset < 4:
        raise ReleaseSigningError("The SSH signature is truncated")
    length = struct.unpack(">I", payload[offset : offset + 4])[0]
    start = offset + 4
    end = start + length
    if end > len(payload):
        raise ReleaseSigningError("The SSH signature is truncated")
    return payload[start:end], end


def _sha256_file(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def _sha512_file(path: Path) -> bytes:
    digest = hashlib.sha512()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def load_private_key(material: bytes | bytearray) -> PrivateKey:
    loaders = (serialization.load_ssh_private_key, serialization.load_pem_private_key)
    for loader in loaders:
        try:
            key = loader(material, password=None)
        except (TypeError, ValueError, UnsupportedAlgorithm):
            continue
        if isinstance(
            key,
            (
                ed25519.Ed25519PrivateKey,
                rsa.RSAPrivateKey,
                ec.EllipticCurvePrivateKey,
            ),
        ):
            return key
        break
    raise ReleaseSigningError("The Keychain item is not a supported Ed25519, RSA, or ECDSA key")


def load_public_key(material: bytes | str) -> PublicKey:
    encoded = material.encode() if isinstance(material, str) else material
    loaders = (serialization.load_ssh_public_key, serialization.load_pem_public_key)
    for loader in loaders:
        try:
            key = loader(encoded)
        except (TypeError, ValueError, UnsupportedAlgorithm):
            continue
        if isinstance(
            key,
            (
                ed25519.Ed25519PublicKey,
                rsa.RSAPublicKey,
                ec.EllipticCurvePublicKey,
            ),
        ):
            return key
        break
    raise ReleaseSigningError("The release verification key is not valid Ed25519, RSA, or ECDSA")


def _public_key_blob(key: PublicKey) -> bytes:
    openssh = key.public_bytes(
        encoding=serialization.Encoding.OpenSSH,
        format=serialization.PublicFormat.OpenSSH,
    )
    try:
        return base64.b64decode(openssh.split()[1], validate=True)
    except (IndexError, binascii.Error) as exc:
        raise ReleaseSigningError("Could not encode the release public key") from exc


def public_keys_match(private_key: PrivateKey, public_key: PublicKey) -> bool:
    return _public_key_blob(private_key.public_key()) == _public_key_blob(public_key)


def _armor_sshsig(payload: bytes) -> bytes:
    encoded = base64.b64encode(payload).decode("ascii")
    wrapped = "\n".join(textwrap.wrap(encoded, width=70))
    return (f"-----BEGIN SSH SIGNATURE-----\n{wrapped}\n-----END SSH SIGNATURE-----\n").encode()


def _decode_sshsig(signature: bytes) -> bytes:
    try:
        text = signature.decode("ascii").strip()
    except UnicodeDecodeError as exc:
        raise ReleaseSigningError("The Ed25519 signature is not an armored SSH signature") from exc
    header = "-----BEGIN SSH SIGNATURE-----"
    footer = "-----END SSH SIGNATURE-----"
    if not text.startswith(header) or not text.endswith(footer):
        raise ReleaseSigningError("The Ed25519 signature is not an armored SSH signature")
    encoded = "".join(text[len(header) : -len(footer)].split())
    try:
        return base64.b64decode(encoded, validate=True)
    except binascii.Error as exc:
        raise ReleaseSigningError("The Ed25519 SSH signature is not valid base64") from exc


def _sign_ed25519_archive(archive: Path, key: ed25519.Ed25519PrivateKey) -> bytes:
    public_blob = _public_key_blob(key.public_key())
    message_digest = _sha512_file(archive)
    signed_payload = (
        _SSHSIG_MAGIC
        + _ssh_string(SSHSIG_NAMESPACE)
        + _ssh_string(b"")
        + _ssh_string(SSHSIG_HASH_ALGORITHM)
        + _ssh_string(message_digest)
    )
    raw_signature = key.sign(signed_payload)
    signature_blob = _ssh_string(b"ssh-ed25519") + _ssh_string(raw_signature)
    envelope = (
        _SSHSIG_MAGIC
        + struct.pack(">I", _SSHSIG_VERSION)
        + _ssh_string(public_blob)
        + _ssh_string(SSHSIG_NAMESPACE)
        + _ssh_string(b"")
        + _ssh_string(SSHSIG_HASH_ALGORITHM)
        + _ssh_string(signature_blob)
    )
    return _armor_sshsig(envelope)


def sign_archive(archive: Path, private_key: PrivateKey) -> bytes:
    if isinstance(private_key, ed25519.Ed25519PrivateKey):
        return _sign_ed25519_archive(archive, private_key)

    digest = _sha256_file(archive)
    if isinstance(private_key, rsa.RSAPrivateKey):
        return private_key.sign(
            digest,
            padding.PKCS1v15(),
            utils.Prehashed(hashes.SHA256()),
        )
    if isinstance(private_key, ec.EllipticCurvePrivateKey):
        return private_key.sign(
            digest,
            ec.ECDSA(utils.Prehashed(hashes.SHA256())),
        )
    raise ReleaseSigningError("Unsupported release private-key algorithm")


def _verify_ed25519_archive(
    archive: Path,
    signature: bytes,
    public_key: ed25519.Ed25519PublicKey,
) -> None:
    payload = _decode_sshsig(signature)
    if not payload.startswith(_SSHSIG_MAGIC):
        raise ReleaseSigningError("The SSH signature preamble is invalid")
    offset = len(_SSHSIG_MAGIC)
    if len(payload) - offset < 4:
        raise ReleaseSigningError("The SSH signature is truncated")
    version = struct.unpack(">I", payload[offset : offset + 4])[0]
    offset += 4
    public_blob, offset = _read_ssh_string(payload, offset)
    namespace, offset = _read_ssh_string(payload, offset)
    reserved, offset = _read_ssh_string(payload, offset)
    hash_algorithm, offset = _read_ssh_string(payload, offset)
    signature_blob, offset = _read_ssh_string(payload, offset)
    if offset != len(payload):
        raise ReleaseSigningError("The SSH signature contains trailing data")
    if version != _SSHSIG_VERSION:
        raise ReleaseSigningError("The SSH signature version is unsupported")
    if public_blob != _public_key_blob(public_key):
        raise ReleaseSigningError("The SSH signature was made by a different release key")
    if namespace != SSHSIG_NAMESPACE or reserved:
        raise ReleaseSigningError("The SSH signature namespace is invalid")
    if hash_algorithm != SSHSIG_HASH_ALGORITHM:
        raise ReleaseSigningError("The SSH signature hash algorithm is unsupported")

    algorithm, signature_offset = _read_ssh_string(signature_blob, 0)
    raw_signature, signature_offset = _read_ssh_string(signature_blob, signature_offset)
    if signature_offset != len(signature_blob) or algorithm != b"ssh-ed25519":
        raise ReleaseSigningError("The SSH signature algorithm is invalid")

    message_digest = _sha512_file(archive)
    signed_payload = (
        _SSHSIG_MAGIC
        + _ssh_string(namespace)
        + _ssh_string(reserved)
        + _ssh_string(hash_algorithm)
        + _ssh_string(message_digest)
    )
    public_key.verify(raw_signature, signed_payload)


def verify_archive(archive: Path, signature: bytes, public_key: PublicKey) -> None:
    try:
        if isinstance(public_key, ed25519.Ed25519PublicKey):
            _verify_ed25519_archive(archive, signature, public_key)
            return

        digest = _sha256_file(archive)
        if isinstance(public_key, rsa.RSAPublicKey):
            public_key.verify(
                signature,
                digest,
                padding.PKCS1v15(),
                utils.Prehashed(hashes.SHA256()),
            )
            return
        if isinstance(public_key, ec.EllipticCurvePublicKey):
            public_key.verify(
                signature,
                digest,
                ec.ECDSA(utils.Prehashed(hashes.SHA256())),
            )
            return
    except InvalidSignature as exc:
        raise ReleaseSigningError("Release archive signature verification failed") from exc
    raise ReleaseSigningError("Unsupported release public-key algorithm")


def read_private_key_from_keychain(
    *,
    run: RunCommand = subprocess.run,
) -> bytearray:
    if sys.platform != "darwin":
        raise ReleaseSigningError("The approved release signer is available only on macOS")
    result = run(
        [
            "/usr/bin/security",
            "find-generic-password",
            "-w",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            KEYCHAIN_ACCOUNT,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0 or not result.stdout:
        raise ReleaseSigningError(
            "The approved release-signing key is unavailable in macOS Keychain"
        )
    if not isinstance(result.stdout, bytes):
        raise ReleaseSigningError("macOS Keychain returned an invalid release-signing key")
    try:
        decoded = base64.b64decode(result.stdout.strip(), validate=True)
    except binascii.Error as exc:
        raise ReleaseSigningError(
            "The approved Keychain item is not a strict base64-encoded private key"
        ) from exc
    if not decoded:
        raise ReleaseSigningError("The approved Keychain item contains an empty private key")
    return bytearray(decoded)
