from __future__ import annotations

import hashlib
import logging
import os
import uuid
from datetime import timedelta

from django.core import signing
from django.core.files.storage import default_storage
from django.urls import reverse
from django.utils import timezone

logger = logging.getLogger(__name__)


def safe_name(file_name: str) -> str:
    base = os.path.basename(file_name).replace(" ", "-")
    return "".join(ch for ch in base if ch.isalnum() or ch in "._-")[:180] or "evidence"


def object_key(organization_id: str, inspection_id: str, file_name: str) -> str:
    return (
        f"organizations/{organization_id}/inspections/{inspection_id}/uploads/"
        f"{uuid.uuid4().hex}-{safe_name(file_name)}"
    )


def permanent_object_key(organization_id: str, inspection_id: str, file_name: str) -> str:
    return (
        f"organizations/{organization_id}/inspections/{inspection_id}/evidence/"
        f"{uuid.uuid4().hex}-{safe_name(file_name)}"
    )


def invoice_upload_key(organization_id: str, invoice_id: str, file_name: str) -> str:
    return (
        f"organizations/{organization_id}/invoices/{invoice_id}/uploads/"
        f"{uuid.uuid4().hex}-{safe_name(file_name)}"
    )


def permanent_invoice_object_key(organization_id: str, invoice_id: str, file_name: str) -> str:
    return (
        f"organizations/{organization_id}/invoices/{invoice_id}/attachments/"
        f"{uuid.uuid4().hex}-{safe_name(file_name)}"
    )


def logo_upload_key(organization_id: str, file_name: str) -> str:
    return (
        f"organizations/{organization_id}/logos/uploads/{uuid.uuid4().hex}-{safe_name(file_name)}"
    )


def logo_key(organization_id: str, file_name: str) -> str:
    return f"organizations/{organization_id}/logos/{uuid.uuid4().hex}-{safe_name(file_name)}"


def validate_logo(key: str, content_type: str, size: int) -> None:
    allowed = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}
    if content_type not in allowed or size < 1 or size > 2 * 1024 * 1024:
        raise ValueError("Logo must be PNG, JPEG, or WebP and at most 2 MB")
    from PIL import Image

    with default_storage.open(key, "rb") as source:
        image = Image.open(source)
        image.verify()
    with default_storage.open(key, "rb") as source:
        image = Image.open(source)
        width, height = image.size
        if image.format != allowed[content_type] or not (
            16 <= width <= 4096 and 16 <= height <= 4096
        ):
            raise ValueError("Logo image format or dimensions are invalid")


def validate_invoice_attachment(key: str, content_type: str, size: int) -> None:
    """Verify the uploaded document before moving it into its permanent private key."""
    allowed_images = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}
    if content_type not in {*allowed_images, "application/pdf"} or not (
        1 <= size <= 15 * 1024 * 1024
    ):
        raise ValueError("Invoice file type or size is invalid")
    with default_storage.open(key, "rb") as source:
        if content_type == "application/pdf":
            if not source.read(5).startswith(b"%PDF-"):
                raise ValueError("Invoice file is not a valid PDF")
            return

        from PIL import Image

        image = Image.open(source)
        image.verify()
    with default_storage.open(key, "rb") as source:
        image = Image.open(source)
        width, height = image.size
        if image.format != allowed_images[content_type] or not (
            16 <= width <= 4096 and 16 <= height <= 4096
        ):
            raise ValueError("Invoice image format or dimensions are invalid")


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


def store_private_upload(*, key: str, body: bytes, content_type: str, checksum: str) -> dict | None:
    """Store a small authenticated upload without relying on browser-to-S3 CORS.

    Presigned uploads remain the preferred path for large evidence.  Logos are
    intentionally small, so this same-origin fallback gives organizations a
    safe upload path when a private Space has no browser CORS policy (or a
    corporate browser blocks cross-origin PUT requests).
    """
    if not body or len(body) > 2 * 1024 * 1024:
        raise ValueError("Logo upload size is invalid")
    client = _s3_client()
    try:
        if client:
            client.put_object(
                Bucket=os.environ["VC_SPACES_BUCKET"],
                Key=key,
                Body=body,
                ContentType=content_type,
                Metadata={
                    "declared-size": str(len(body)),
                    "sha256": checksum.removeprefix("sha256:"),
                },
            )
        else:
            from django.core.files.base import ContentFile

            if default_storage.exists(key):
                raise ValueError("Object already exists")
            default_storage.save(key, ContentFile(body))
        return object_metadata(key)
    except Exception:
        logger.warning("Private logo upload failed", extra={"object_key": key}, exc_info=True)
        try:
            delete_object(key)
        except Exception:
            logger.warning("Failed to remove partial logo upload", extra={"object_key": key})
        return None


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


def promote_object(source_key: str, destination_key: str) -> dict | None:
    client = _s3_client()
    if client:
        try:
            client.copy_object(
                Bucket=os.environ["VC_SPACES_BUCKET"],
                CopySource={
                    "Bucket": os.environ["VC_SPACES_BUCKET"],
                    "Key": source_key,
                },
                Key=destination_key,
                MetadataDirective="COPY",
            )
            metadata = object_metadata(destination_key)
            if not metadata:
                raise RuntimeError("Promoted evidence object could not be verified")
            client.delete_object(Bucket=os.environ["VC_SPACES_BUCKET"], Key=source_key)
            return metadata
        except Exception:
            try:
                client.delete_object(
                    Bucket=os.environ["VC_SPACES_BUCKET"],
                    Key=destination_key,
                )
            except Exception:
                logger.warning(
                    "Failed to remove partial evidence object after promotion error",
                    extra={"object_key": destination_key},
                    exc_info=True,
                )
            return None
    if not default_storage.exists(source_key) or default_storage.exists(destination_key):
        return None
    with default_storage.open(source_key, "rb") as source:
        from django.core.files.base import File

        default_storage.save(destination_key, File(source))
    metadata = object_metadata(destination_key)
    if not metadata:
        default_storage.delete(destination_key)
        return None
    default_storage.delete(source_key)
    return metadata


def delete_object(key: str) -> None:
    client = _s3_client()
    if client:
        client.delete_object(Bucket=os.environ["VC_SPACES_BUCKET"], Key=key)
    elif default_storage.exists(key):
        default_storage.delete(key)
