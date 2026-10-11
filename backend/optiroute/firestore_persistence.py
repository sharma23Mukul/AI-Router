"""Durable snapshots for the SQLite database on an ephemeral web service.

SQLite remains the query engine, preserving the application's existing SQL and
transactions. When enabled, each committed database state is published to
Firestore before the request succeeds. A new process restores the last
published state before opening SQLite.

This backend is intended for OptiRoute's single-instance demo deployment.
Do not run multiple writers against the same Firestore snapshot.
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import uuid
import zlib
from pathlib import Path


_COLLECTION = "optiroute_sqlite_snapshots"
_MANIFEST = "current"
_CHUNK_SIZE = 480_000  # Well below Firestore's 1 MiB document limit.
_MAX_CHUNKS = 20
_commit_lock = asyncio.Lock()
_enabled = False


def configured() -> bool:
    return os.environ.get("OPTIROUTE_FIRESTORE_PERSISTENCE", "").lower() in {
        "1", "true", "yes"
    }


def _collection():
    from firebase_admin import firestore

    return firestore.client(database_id="(default)").collection(_COLLECTION)


def _restore(path: Path) -> bool:
    collection = _collection()
    manifest = collection.document(_MANIFEST).get()
    if not manifest.exists:
        return False

    metadata = manifest.to_dict() or {}
    version = metadata["version"]
    chunk_count = int(metadata["chunks"])
    if chunk_count < 1 or chunk_count > _MAX_CHUNKS:
        raise RuntimeError("Invalid Firestore database snapshot manifest")

    parts = []
    for index in range(chunk_count):
        chunk = collection.document(f"{version}_{index}").get()
        if not chunk.exists:
            raise RuntimeError("Incomplete Firestore database snapshot")
        parts.append(chunk.to_dict()["payload"])
    raw = zlib.decompress(b"".join(parts))
    if not raw.startswith(b"SQLite format 3\x00"):
        raise RuntimeError("Invalid SQLite data in Firestore snapshot")

    path.parent.mkdir(parents=True, exist_ok=True)
    restored = path.with_suffix(".restore")
    restored.write_bytes(raw)
    for suffix in ("-wal", "-shm"):
        stale = Path(f"{path}{suffix}")
        if stale.exists():
            stale.unlink()
    os.replace(restored, path)
    return True


def _sqlite_bytes(path: Path) -> bytes:
    source = sqlite3.connect(str(path))
    copy = sqlite3.connect(":memory:")
    try:
        source.backup(copy)
        return copy.serialize()
    finally:
        copy.close()
        source.close()


def _publish(path: Path) -> None:
    compressed = zlib.compress(_sqlite_bytes(path), level=6)
    chunks = [
        compressed[index:index + _CHUNK_SIZE]
        for index in range(0, len(compressed), _CHUNK_SIZE)
    ]
    if not chunks or len(chunks) > _MAX_CHUNKS:
        raise RuntimeError("SQLite database is too large for the demo Firestore snapshot")

    collection = _collection()
    previous = collection.document(_MANIFEST).get()
    old_metadata = previous.to_dict() if previous.exists else None
    version = uuid.uuid4().hex
    from firebase_admin import firestore

    batch = firestore.client(database_id="(default)").batch()
    for index, chunk in enumerate(chunks):
        batch.set(collection.document(f"{version}_{index}"), {"payload": chunk})
    # Publishing the manifest in the same atomic batch prevents partial reads.
    batch.set(collection.document(_MANIFEST), {"version": version, "chunks": len(chunks)})
    batch.commit()

    if old_metadata and old_metadata.get("version") != version:
        try:
            cleanup = firestore.client(database_id="(default)").batch()
            for index in range(int(old_metadata.get("chunks", 0))):
                cleanup.delete(collection.document(f"{old_metadata['version']}_{index}"))
            cleanup.commit()
        except Exception:
            # Stale chunks are harmless; the new manifest is already durable.
            pass


async def restore_before_init(path: Path) -> None:
    global _enabled
    if not configured():
        _enabled = False
        return
    local_key = Path(__file__).resolve().parent.parent / "firebase-adminsdk.json"
    if not os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON") and not local_key.exists():
        raise RuntimeError(
            "Firestore persistence needs FIREBASE_SERVICE_ACCOUNT_JSON "
            "or a local firebase-adminsdk.json"
        )
    # Fail at startup if credentials or the Firestore database are unavailable.
    await asyncio.to_thread(_restore, path)
    _enabled = True


class DurableConnection:
    """The aiosqlite interface with a durable commit boundary."""

    def __init__(self, connection, path: Path):
        self._connection = connection
        self._path = path

    def __getattr__(self, name):
        return getattr(self._connection, name)

    async def commit(self):
        async with _commit_lock:
            await self._connection.commit()
            await asyncio.to_thread(_publish, self._path)


def wrap(connection, path: Path):
    return DurableConnection(connection, path) if _enabled else connection
