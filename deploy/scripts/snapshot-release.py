#!/usr/bin/env python3
"""Copy deploy-user release inputs into an immutable root-owned snapshot."""

from __future__ import annotations

import os
import pwd
import re
import stat
import sys
from pathlib import Path


ARCHIVE_PATTERN = re.compile(
    r"^vessel-caller-v(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)\."
    r"(?:0|[1-9][0-9]*)"
    r"(?:-[0-9A-Za-z.-]+)?\.tar\.gz$"
)


class SnapshotError(RuntimeError):
    pass


def _stable_identity(value: os.stat_result) -> tuple[int, ...]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_uid,
        value.st_gid,
        value.st_nlink,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _validate_source(value: os.stat_result, expected_uid: int, label: str) -> None:
    if not stat.S_ISREG(value.st_mode):
        raise SnapshotError(f"{label} must be a regular file")
    if value.st_uid != expected_uid:
        raise SnapshotError(f"{label} has an unexpected owner")
    if value.st_nlink != 1:
        raise SnapshotError(f"{label} must not be hard-linked")
    if stat.S_IMODE(value.st_mode) & 0o022:
        raise SnapshotError(f"{label} must not be group- or world-writable")


def snapshot_release_inputs(
    archive: Path,
    destination: Path,
    *,
    source_directory: Path,
    expected_source_uid: int,
    expected_destination_uid: int,
    unlink_sources: bool = False,
) -> Path:
    archive = Path(os.path.abspath(archive))
    destination = Path(os.path.abspath(destination))
    source_directory = Path(os.path.abspath(source_directory))
    if archive.parent != source_directory or not ARCHIVE_PATTERN.fullmatch(archive.name):
        raise SnapshotError("release archive has an unexpected path or basename")

    destination_stat = os.stat(destination, follow_symlinks=False)
    if not stat.S_ISDIR(destination_stat.st_mode) or stat.S_ISLNK(destination_stat.st_mode):
        raise SnapshotError("snapshot destination must be a real directory")
    if destination_stat.st_uid != expected_destination_uid:
        raise SnapshotError("snapshot destination has an unexpected owner")
    if stat.S_IMODE(destination_stat.st_mode) != 0o700:
        raise SnapshotError("snapshot destination must use mode 0700")

    destination_fd = os.open(
        destination,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
    )
    copied_sources: list[tuple[Path, os.stat_result]] = []
    try:
        for source in (archive, Path(f"{archive}.sha256"), Path(f"{archive}.sig")):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK
            try:
                source_fd = os.open(source, flags)
            except OSError as exc:
                raise SnapshotError(f"could not safely open {source.name}") from exc
            destination_file_fd: int | None = None
            try:
                before = os.fstat(source_fd)
                _validate_source(before, expected_source_uid, source.name)
                destination_file_fd = os.open(
                    source.name,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                    0o600,
                    dir_fd=destination_fd,
                )
                while chunk := os.read(source_fd, 1024 * 1024):
                    view = memoryview(chunk)
                    while view:
                        written = os.write(destination_file_fd, view)
                        view = view[written:]
                os.fsync(destination_file_fd)
                after = os.fstat(source_fd)
                if _stable_identity(before) != _stable_identity(after):
                    raise SnapshotError(f"{source.name} changed while it was copied")
                copied_sources.append((source, before))
            finally:
                if destination_file_fd is not None:
                    os.close(destination_file_fd)
                os.close(source_fd)
        os.fsync(destination_fd)
    finally:
        os.close(destination_fd)

    if unlink_sources:
        for source, opened_stat in copied_sources:
            try:
                current = os.stat(source, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if (current.st_dev, current.st_ino) == (opened_stat.st_dev, opened_stat.st_ino):
                os.unlink(source)

    return destination / archive.name


def main() -> int:
    if os.geteuid() != 0:
        print("Run as root through the restricted vessel-deploy sudo rule.", file=sys.stderr)
        return 1
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} </var/tmp/release.tar.gz> <snapshot-directory>", file=sys.stderr)
        return 2
    try:
        deploy_uid = pwd.getpwnam("vessel-deploy").pw_uid
        snapshot = snapshot_release_inputs(
            Path(sys.argv[1]),
            Path(sys.argv[2]),
            source_directory=Path("/var/tmp"),
            expected_source_uid=deploy_uid,
            expected_destination_uid=0,
            unlink_sources=True,
        )
    except (KeyError, OSError, SnapshotError) as exc:
        print(f"Release input snapshot failed: {exc}", file=sys.stderr)
        return 1
    print(snapshot)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
