"""Dependency-free validation helpers retained for the legacy API."""

MAX_EMAIL_LENGTH = 254


def is_valid_email(email: str) -> bool:
    """Validate the legacy email shape in bounded linear time."""
    if not email or len(email) > MAX_EMAIL_LENGTH:
        return False
    if any(character.isspace() for character in email):
        return False
    at_index = email.find("@")
    if at_index <= 0 or at_index != email.rfind("@"):
        return False
    return email.find(".", at_index + 2, len(email) - 1) != -1
