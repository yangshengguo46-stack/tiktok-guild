"""Native terminal output identities and reads of the attested bytes."""

from __future__ import annotations

import hashlib
import os
import posixpath
import stat
import tempfile
from typing import BinaryIO

from deerflow.config.paths import get_paths

ARTIFACT_INTEGRITY_VERSION = 1
_CHUNK_BYTES = 64 * 1024
_SPOOL_MEMORY_BYTES = 2 * 1024 * 1024


def _output_path(thread_id: str, path: str, *, user_id: str):
    virtual = "/" + posixpath.normpath(path.lstrip("/"))
    if not virtual.startswith("/mnt/user-data/outputs/"):
        raise ValueError("Native delivery requires an outputs path")
    paths = get_paths()
    actual = paths.resolve_virtual_path(thread_id, virtual, user_id=user_id)
    root = paths.sandbox_outputs_dir(thread_id, user_id=user_id).resolve()
    if actual == root or not actual.is_relative_to(root):
        raise ValueError("Native delivery path is outside outputs")
    return virtual, actual


def _capture_output(thread_id: str, path: str, *, user_id: str) -> tuple[BinaryIO, dict]:
    """Hash the bytes being buffered; reject replacement/mutation while reading."""
    virtual, actual = _output_path(thread_id, path, user_id=user_id)
    buffer = tempfile.SpooledTemporaryFile(max_size=_SPOOL_MEMORY_BYTES, mode="w+b")
    try:
        fd = os.open(actual, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(fd, "rb") as source:
            before = os.fstat(source.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise ValueError("Native delivered output is not a regular file")
            digest, size = hashlib.sha256(), 0
            while chunk := source.read(_CHUNK_BYTES):
                buffer.write(chunk)
                digest.update(chunk)
                size += len(chunk)
            after = os.fstat(source.fileno())
            current = actual.stat()
            _, current_path = _output_path(thread_id, path, user_id=user_id)
            if current_path != actual:
                raise ValueError("Native delivered output path changed during content capture")

            def identity(value):
                return (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)

            if identity(before) != identity(after) or identity(after) != identity(current) or size != after.st_size:
                raise ValueError("Native delivered output changed during content capture")
        buffer.seek(0)
        return buffer, {"path": virtual, "sha256": digest.hexdigest(), "size_bytes": size}
    except BaseException:
        buffer.close()
        raise


def attest_delivery_outputs(thread_id: str, content: dict, *, user_id: str) -> dict:
    """Capture content identity in the worker, before run.delivery is durable."""
    paths = content.get("matched_paths") if content.get("produced_paths") else content.get("paths")
    if not paths:
        return content
    identities = []
    for path in dict.fromkeys(paths):
        try:
            buffer, identity = _capture_output(thread_id, path, user_id=user_id)
            buffer.close()
            identities.append(identity)
        except (OSError, ValueError) as exc:
            identities.append({"path": path, "error": str(exc)})
    return {**content, "artifact_integrity_version": ARTIFACT_INTEGRITY_VERSION, "artifact_integrity": identities}


def read_attested_output(thread_id: str, path: str, identity: dict, *, user_id: str) -> BinaryIO:
    """Return the very buffer whose identity matches the native terminal event."""
    buffer, current = _capture_output(thread_id, path, user_id=user_id)
    if current != identity:
        buffer.close()
        raise ValueError("Native delivered output no longer matches its run receipt")
    return buffer


def verify_attested_output(thread_id: str, path: str, identity: dict, *, user_id: str) -> None:
    buffer = read_attested_output(thread_id, path, identity, user_id=user_id)
    buffer.close()
