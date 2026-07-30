from __future__ import annotations

import pytest

from api import storage


class FakeSpacesClient:
    def __init__(
        self, *, copy_error: Exception | None = None, delete_error: Exception | None = None
    ):
        self.copy_error = copy_error
        self.delete_error = delete_error
        self.copies: list[dict] = []
        self.deletes: list[dict] = []

    def copy_object(self, **kwargs):
        self.copies.append(kwargs)
        if self.copy_error:
            raise self.copy_error

    def delete_object(self, **kwargs):
        self.deletes.append(kwargs)
        if self.delete_error:
            raise self.delete_error


def test_spaces_promotion_copies_verifies_and_removes_source(monkeypatch):
    client = FakeSpacesClient()
    metadata = {"size": 12, "checksum": "verified"}
    monkeypatch.setattr(storage, "_s3_client", lambda: client)
    monkeypatch.setattr(storage, "object_metadata", lambda key: metadata)
    monkeypatch.setenv("VC_SPACES_BUCKET", "private-evidence")

    assert storage.promote_object("uploads/source", "evidence/final") == metadata
    assert client.copies[0]["CopySource"]["Key"] == "uploads/source"
    assert client.copies[0]["Key"] == "evidence/final"
    assert client.deletes == [{"Bucket": "private-evidence", "Key": "uploads/source"}]


def test_spaces_promotion_keeps_source_when_final_object_cannot_be_verified(monkeypatch):
    client = FakeSpacesClient()
    monkeypatch.setattr(storage, "_s3_client", lambda: client)
    monkeypatch.setattr(storage, "object_metadata", lambda key: None)
    monkeypatch.setenv("VC_SPACES_BUCKET", "private-evidence")

    assert storage.promote_object("uploads/source", "evidence/final") is None
    assert client.deletes == [{"Bucket": "private-evidence", "Key": "evidence/final"}]


def test_spaces_promotion_cleans_partial_destination_on_copy_failure(monkeypatch):
    client = FakeSpacesClient(copy_error=RuntimeError("copy failed"))
    monkeypatch.setattr(storage, "_s3_client", lambda: client)
    monkeypatch.setenv("VC_SPACES_BUCKET", "private-evidence")

    assert storage.promote_object("uploads/source", "evidence/final") is None
    assert client.deletes == [{"Bucket": "private-evidence", "Key": "evidence/final"}]


def test_spaces_promotion_masks_cleanup_failure(monkeypatch):
    client = FakeSpacesClient(
        copy_error=RuntimeError("copy failed"),
        delete_error=RuntimeError("cleanup failed"),
    )
    monkeypatch.setattr(storage, "_s3_client", lambda: client)
    monkeypatch.setenv("VC_SPACES_BUCKET", "private-evidence")

    assert storage.promote_object("uploads/source", "evidence/final") is None


def test_private_logo_upload_rejects_empty_or_oversized_content():
    with pytest.raises(ValueError, match="size"):
        storage.store_private_upload(
            key="organizations/org/logos/uploads/logo.png",
            body=b"",
            content_type="image/png",
            checksum="sha256:abc",
        )
    with pytest.raises(ValueError, match="size"):
        storage.store_private_upload(
            key="organizations/org/logos/uploads/logo.png",
            body=b"x" * (2 * 1024 * 1024 + 1),
            content_type="image/png",
            checksum="sha256:abc",
        )


def test_private_logo_upload_uses_local_private_storage_when_spaces_is_unavailable(monkeypatch):
    saved: dict[str, bytes] = {}

    class LocalStorage:
        def exists(self, _key):
            return False

        def save(self, key, content):
            saved[key] = content.read()
            return key

    monkeypatch.setattr(storage, "_s3_client", lambda: None)
    monkeypatch.setattr(storage, "default_storage", LocalStorage())
    monkeypatch.setattr(
        storage,
        "object_metadata",
        lambda _key: {"size": 3, "checksum": "abc"},
    )
    result = storage.store_private_upload(
        key="organizations/org/logos/uploads/logo.png",
        body=b"png",
        content_type="image/png",
        checksum="sha256:abc",
    )
    assert result == {"size": 3, "checksum": "abc"}
    assert saved == {"organizations/org/logos/uploads/logo.png": b"png"}


def test_private_logo_upload_rejects_existing_local_object_and_cleans_up(monkeypatch):
    deleted: list[str] = []

    class ExistingLocalStorage:
        def exists(self, _key):
            return True

    monkeypatch.setattr(storage, "_s3_client", lambda: None)
    monkeypatch.setattr(storage, "default_storage", ExistingLocalStorage())
    monkeypatch.setattr(storage, "delete_object", deleted.append)
    assert (
        storage.store_private_upload(
            key="organizations/org/logos/uploads/logo.png",
            body=b"png",
            content_type="image/png",
            checksum="sha256:abc",
        )
        is None
    )
    assert deleted == ["organizations/org/logos/uploads/logo.png"]


def test_private_logo_upload_uses_private_spaces_and_records_metadata(monkeypatch):
    puts: list[dict] = []

    class SpacesClient:
        def put_object(self, **kwargs):
            puts.append(kwargs)

    monkeypatch.setattr(storage, "_s3_client", SpacesClient)
    monkeypatch.setattr(storage, "object_metadata", lambda _key: {"size": 3, "checksum": "abc"})
    monkeypatch.setenv("VC_SPACES_BUCKET", "vessel-caller-staging-private")
    result = storage.store_private_upload(
        key="organizations/org/logos/uploads/logo.png",
        body=b"png",
        content_type="image/png",
        checksum="sha256:abc",
    )
    assert result == {"size": 3, "checksum": "abc"}
    assert puts == [
        {
            "Bucket": "vessel-caller-staging-private",
            "Key": "organizations/org/logos/uploads/logo.png",
            "Body": b"png",
            "ContentType": "image/png",
            "Metadata": {"declared-size": "3", "sha256": "abc"},
        }
    ]


def test_logo_validation_rejects_unknown_type_without_opening_storage():
    with pytest.raises(ValueError, match="PNG"):
        storage.validate_logo("organizations/org/logos/uploads/logo.gif", "image/gif", 3)
