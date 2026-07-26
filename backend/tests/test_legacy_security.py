from legacy_fastapi.email_validation import MAX_EMAIL_LENGTH, is_valid_email


def test_legacy_email_validation_is_bounded_and_preserves_shape():
    assert is_valid_email("admin@acme.test")
    assert is_valid_email("admin@acme.test.")
    assert is_valid_email("admin@acme..")
    assert not is_valid_email("")
    assert not is_valid_email("admin@.test")
    assert not is_valid_email("admin@acme.")
    assert not is_valid_email("admin@@acme.test")
    assert not is_valid_email("admin @acme.test")
    assert not is_valid_email("a" * MAX_EMAIL_LENGTH + "@b.co")
