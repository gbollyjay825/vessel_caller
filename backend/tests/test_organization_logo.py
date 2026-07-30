from __future__ import annotations

from io import BytesIO

import pytest
from django.core.files.uploadedfile import SimpleUploadedFile

from api import documents, operation_views, storage
from api.documents import simple_pdf
from .conftest import authenticated


pytestmark = pytest.mark.django_db

CHECKSUM = "sha256:" + "a" * 64


def payload(**extra):
    return {
        "fileName": "brand.png",
        "contentType": "image/png",
        "size": 128,
        "checksum": CHECKSUM,
        **extra,
    }


def test_logo_endpoints_require_organization_admin(admin, viewer):
    viewer_client = authenticated(viewer)
    assert viewer_client.get("/api/organization/logo").status_code == 403
    assert viewer_client.post("/api/organization/logo", payload(), format="json").status_code == 403
    assert viewer_client.delete("/api/organization/logo").status_code == 403
    assert (
        viewer_client.post(
            "/api/organization/logo/content",
            {"file": SimpleUploadedFile("brand.png", b"png", content_type="image/png")},
        ).status_code
        == 403
    )


def test_logo_same_origin_fallback_stores_a_validated_private_upload(admin, monkeypatch):
    png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x0dIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82"
    saved: dict[str, object] = {}

    def save(**kwargs):
        saved.update(kwargs)
        return {"size": len(png), "checksum": kwargs["checksum"].removeprefix("sha256:")}

    monkeypatch.setattr(operation_views, "store_private_upload", save)
    monkeypatch.setattr(operation_views, "validate_logo", lambda *_: None)
    response = authenticated(admin).post(
        "/api/organization/logo/content",
        {"file": SimpleUploadedFile("brand.png", png, content_type="image/png")},
    )
    assert response.status_code == 201
    assert response.data["objectKey"].startswith(
        f"organizations/{admin.organization_id}/logos/uploads/"
    )
    assert saved["content_type"] == "image/png"
    assert saved["checksum"] == response.data["checksum"]


def test_logo_same_origin_fallback_rejects_invalid_content(admin):
    response = authenticated(admin).post(
        "/api/organization/logo/content",
        {"file": SimpleUploadedFile("brand.gif", b"not-an-image", content_type="image/gif")},
    )
    assert response.status_code == 400


def test_logo_preview_is_private_and_admin_only(admin, viewer, monkeypatch):
    admin.organization.logo_object_key = (
        f"organizations/{admin.organization_id}/logos/private-brand.png"
    )
    admin.organization.save(update_fields=("logo_object_key",))
    monkeypatch.setattr(
        operation_views,
        "presign_download",
        lambda *_args, **_kwargs: "https://private.example/logo",
    )
    response = authenticated(admin).get("/api/organization/logo")
    assert response.status_code == 200
    assert response.data == {"hasLogo": True, "downloadUrl": "https://private.example/logo"}
    assert authenticated(viewer).get("/api/organization/logo").status_code == 403


def test_logo_presign_rejects_non_image_and_oversized_payloads(admin):
    client = authenticated(admin)
    assert (
        client.post(
            "/api/organization/logo", payload(contentType="image/gif"), format="json"
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/organization/logo", payload(size=2 * 1024 * 1024 + 1), format="json"
        ).status_code
        == 400
    )
    assert (
        client.post(
            "/api/organization/logo", payload(fileName="brand.gif"), format="json"
        ).status_code
        == 400
    )


def test_logo_validation_rejects_corrupt_or_mismatched_magic(monkeypatch):
    class CorruptStorage:
        def open(self, *_args, **_kwargs):
            return BytesIO(b"not an image")

    monkeypatch.setattr(storage, "default_storage", CorruptStorage())
    with pytest.raises(OSError):
        storage.validate_logo("organizations/org/logos/uploads/bad.png", "image/png", 12)


def test_logo_finalize_stores_private_key_and_remove_clears_it(admin, monkeypatch):
    client = authenticated(admin)
    key = f"organizations/{admin.organization_id}/logos/uploads/upload-brand.png"
    monkeypatch.setattr(
        operation_views, "object_metadata", lambda _: {"size": 128, "checksum": "a" * 64}
    )
    monkeypatch.setattr(operation_views, "validate_logo", lambda *_: None)
    monkeypatch.setattr(
        operation_views,
        "logo_key",
        lambda *_: f"organizations/{admin.organization_id}/logos/final-brand.png",
    )
    monkeypatch.setattr(operation_views, "promote_object", lambda *_: {"size": 128})
    monkeypatch.setattr(
        operation_views,
        "presign_download",
        lambda *_args, **_kwargs: "https://private.example/logo",
    )
    deleted: list[str] = []
    monkeypatch.setattr(operation_views, "delete_object", deleted.append)

    response = client.put("/api/organization/logo", payload(objectKey=key), format="json")
    assert response.status_code == 200
    admin.organization.refresh_from_db()
    assert (
        admin.organization.logo_object_key
        == f"organizations/{admin.organization_id}/logos/final-brand.png"
    )
    assert not admin.organization.logo_object_key.startswith("data:")
    assert client.delete("/api/organization/logo").status_code == 204
    admin.organization.refresh_from_db()
    assert admin.organization.logo_object_key == ""
    assert deleted == [f"organizations/{admin.organization_id}/logos/final-brand.png"]


def test_logo_finalize_rejects_cross_organization_key(admin):
    response = authenticated(admin).put(
        "/api/organization/logo",
        payload(objectKey="organizations/org-other/logos/uploads/nope.png"),
        format="json",
    )
    assert response.status_code == 400


def test_logo_finalize_rejects_unverified_or_unpromotable_upload(admin, monkeypatch):
    client = authenticated(admin)
    key = f"organizations/{admin.organization_id}/logos/uploads/upload-brand.png"
    monkeypatch.setattr(
        operation_views, "object_metadata", lambda _: {"size": 127, "checksum": "a" * 64}
    )
    assert (
        client.put("/api/organization/logo", payload(objectKey=key), format="json").status_code
        == 400
    )

    monkeypatch.setattr(
        operation_views, "object_metadata", lambda _: {"size": 128, "checksum": "a" * 64}
    )
    monkeypatch.setattr(operation_views, "validate_logo", lambda *_: None)
    monkeypatch.setattr(operation_views, "promote_object", lambda *_: None)
    assert (
        client.put("/api/organization/logo", payload(objectKey=key), format="json").status_code
        == 400
    )


def test_pdf_renders_private_logo_and_degrades_when_unavailable(monkeypatch):
    # A 1x1 PNG is enough to exercise ReportLab's private-storage image path.
    png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x0dIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82"

    class LogoStorage:
        def open(self, key, *_args, **_kwargs):
            if key == "valid/logo.png":
                return BytesIO(png)
            if key == "corrupt/logo.png":
                return BytesIO(b"corrupt")
            raise FileNotFoundError(key)

    monkeypatch.setattr(documents, "default_storage", LogoStorage())
    baseline = simple_pdf("Invoice", [("Status", "Draft")])
    rendered = simple_pdf("Invoice", [("Status", "Draft")], logo_key="valid/logo.png")
    corrupt = simple_pdf("Invoice", [("Status", "Draft")], logo_key="corrupt/logo.png")
    missing = simple_pdf("Invoice", [("Status", "Draft")], logo_key="missing/logo.png")
    assert rendered.startswith(b"%PDF") and len(rendered) > len(baseline)
    assert corrupt.startswith(b"%PDF") and missing.startswith(b"%PDF")


def test_pdf_wraps_long_values_and_repeats_table_header():
    long_value = "Long marine description & location <unquoted> " * 120
    rendered = simple_pdf(
        "Invoice for A & B <Marine> with a very long organization name that must wrap safely",
        [("Description", long_value), ("Measurement", long_value)] * 18,
    )
    assert rendered.startswith(b"%PDF")
    # A multi-page PDF has more than the original single-page canvas marker.
    assert rendered.count(b"/Type /Page") > 2
