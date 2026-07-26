from __future__ import annotations

import hashlib
import os
import uuid
from datetime import timedelta

from django.core import signing
from django.core.files.storage import default_storage
from django.urls import reverse
from django.utils import timezone


def safe_name(file_name: str) -> str:
    base = os.path.basename(file_name).replace(" ", "-")
    return "".join(ch for ch in base if ch.isalnum() or ch in "._-")[:180] or "evidence"


def object_key(organization_id: str, inspection_id: str, file_name: str) -> str:
    return (
        f"organizations/{organization_id}/inspections/{inspection_id}/"
        f"{uuid.uuid4().hex}-{safe_name(file_name)}"
    )


def _s3_client():
    key = os.getenv("VC_SPACES_KEY")
    if not key:
        return None
    import boto3

    return boto3.client(
        "s3",
        region_name=os.getenv("VC_SPACES_REGION", "nyc3"),
        endpoint_url=os.getenv("VC_SPACES_ENDPOINT_URL"),
        aws_access_key_id=key,
        aws_secret_access_key=os.getenv("VC_SPACES_SECRET"),
    )


def presign_upload(
    request,
    *,
    key: str,
    content_type: str,
    size: int,
    checksum: str,
) -> dict:
    client = _s3_client()
    expires = timezone.now() + timedelta(minutes=10)
    checksum_hex = checksum.removeprefix("sha256:")
    if client:
        url = client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": os.environ["VC_SPACES_BUCKET"],
                "Key": key,
                "ContentType": content_type,
                "ContentLength": size,
                "Metadata": {
                    "declared-size": str(size),
                    "sha256": checksum_hex,
                },
            },
            ExpiresIn=600,
        )
    else:
        token = signing.dumps(
            {
                "key": key,
                "contentType": content_type,
                "size": size,
                "checksum": checksum_hex,
            },
            salt="evidence-upload",
        )
        url = request.build_absolute_uri(reverse("evidence-local-upload", kwargs={"token": token}))
    return {
        "uploadUrl": url,
        "method": "PUT",
        "headers": {
            "Content-Type": content_type,
            **(
                {
                    "x-amz-meta-declared-size": str(size),
                    "x-amz-meta-sha256": checksum_hex,
                }
                if client
                else {}
            ),
        },
        "objectKey": key,
        "expiresAt": expires.isoformat(),
    }


def presign_download(request, *, key: str) -> str:
    client = _s3_client()
    if client:
        return client.generate_presigned_url(
            "get_object",
            Params={"Bucket": os.environ["VC_SPACES_BUCKET"], "Key": key},
            ExpiresIn=300,
        )
    token = signing.dumps({"key": key}, salt="evidence-download")
    return request.build_absolute_uri(reverse("evidence-local-download", kwargs={"token": token}))


def local_upload(token: str, body: bytes, content_type: str) -> str:
    payload = signing.loads(token, salt="evidence-upload", max_age=600)
    if content_type.split(";", 1)[0] != payload["contentType"]:
        raise ValueError("Content type does not match signed upload")
    if len(body) != payload["size"] or len(body) > 15 * 1024 * 1024:
        raise ValueError("Upload size does not match signed size")
    if hashlib.sha256(body).hexdigest() != payload["checksum"]:
        raise ValueError("Upload checksum does not match signed checksum")
    from django.core.files.base import ContentFile

    key = payload["key"]
    if default_storage.exists(key):
        raise ValueError("Object already exists")
    default_storage.save(key, ContentFile(body))
    return key


def local_download(token: str):
    payload = signing.loads(token, salt="evidence-download", max_age=300)
    return default_storage.open(payload["key"], "rb")


def object_metadata(key: str) -> dict | None:
    client = _s3_client()
    if client:
        try:
            head = client.head_object(Bucket=os.environ["VC_SPACES_BUCKET"], Key=key)
            metadata = head.get("Metadata") or {}
            size = int(head["ContentLength"])
            if size > 15 * 1024 * 1024:
                return {
                    "size": size,
                    "contentType": str(head.get("ContentType", "")).split(";", 1)[0],
                    "declaredSize": metadata.get("declared-size", ""),
                    "checksum": "",
                }
            response = client.get_object(Bucket=os.environ["VC_SPACES_BUCKET"], Key=key)
            stream = response["Body"]
            digest = hashlib.sha256()
            try:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            finally:
                stream.close()
            return {
                "size": size,
                "contentType": str(head.get("ContentType", "")).split(";", 1)[0],
                "declaredSize": metadata.get("declared-size", ""),
                "checksum": digest.hexdigest(),
            }
        except Exception:
            return None
    if not default_storage.exists(key):
        return None
    with default_storage.open(key, "rb") as stored:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stored.read(1024 * 1024), b""):
            digest.update(chunk)
    return {
        "size": default_storage.size(key),
        "contentType": "",
        "declaredSize": "",
        "checksum": digest.hexdigest(),
    }


def object_exists(key: str) -> bool:
    return object_metadata(key) is not None


def delete_object(key: str) -> None:
    client = _s3_client()
    if client:
        client.delete_object(Bucket=os.environ["VC_SPACES_BUCKET"], Key=key)
    elif default_storage.exists(key):
        default_storage.delete(key)
