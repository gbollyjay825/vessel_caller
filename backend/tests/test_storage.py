from __future__ import annotations

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
