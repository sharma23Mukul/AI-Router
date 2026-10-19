"""Local checks for durable SQLite snapshot round trips."""

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from optiroute import database as db
from optiroute import firestore_persistence as durable


class _Document:
    def __init__(self, data, key):
        self.data = data
        self.key = key

    def get(self):
        return self

    @property
    def exists(self):
        return self.key in self.data

    def to_dict(self):
        return self.data[self.key]


class _Collection:
    def __init__(self, data):
        self.data = data

    def document(self, key):
        return _Document(self.data, key)


class _Batch:
    def __init__(self, data):
        self.data = data
        self.operations = []

    def set(self, document, value):
        self.operations.append(("set", document.key, value))

    def delete(self, document):
        self.operations.append(("delete", document.key, None))

    def commit(self):
        for operation, key, value in self.operations:
            if operation == "set":
                self.data[key] = value
            else:
                self.data.pop(key, None)


class _Client:
    def __init__(self):
        self.data = {}

    def collection(self, name):
        return _Collection(self.data)

    def batch(self):
        return _Batch(self.data)


class SnapshotTests(unittest.TestCase):
    def test_snapshot_survives_local_database_loss(self):
        from firebase_admin import firestore

        client = _Client()
        with tempfile.TemporaryDirectory() as directory, patch.object(
            firestore, "client", return_value=client
        ):
            path = Path(directory) / "optiroute.db"
            connection = sqlite3.connect(path)
            try:
                connection.execute("CREATE TABLE prompts (value TEXT)")
                connection.execute("INSERT INTO prompts VALUES ('first')")
                connection.commit()
                durable._publish(path)
                connection.execute("INSERT INTO prompts VALUES ('second')")
                connection.commit()
                durable._publish(path)
            finally:
                connection.close()

            self.assertEqual(len(client.data), 2)  # manifest and current chunk
            path.unlink()
            self.assertTrue(durable._restore(path))
            restored = sqlite3.connect(path)
            try:
                rows = restored.execute("SELECT value FROM prompts ORDER BY rowid").fetchall()
            finally:
                restored.close()
            self.assertEqual(rows, [("first",), ("second",)])


class DatabaseIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_database_commit_is_restored_at_next_start(self):
        from firebase_admin import firestore

        client = _Client()
        with tempfile.TemporaryDirectory() as directory, \
            patch.object(firestore, "client", return_value=client), \
            patch.dict("os.environ", {
                "OPTIROUTE_FIRESTORE_PERSISTENCE": "1",
                "FIREBASE_SERVICE_ACCOUNT_JSON": "{}",
            }), \
            patch.object(db, "_DB_DIR", Path(directory)), \
            patch.object(db, "_DB_PATH", Path(directory) / "optiroute.db"):
            try:
                await db.init_db()
                connection = await db.get_connection()
                try:
                    await connection.execute(
                        "INSERT INTO users (client_id, api_key_hash, email) VALUES (?, ?, ?)",
                        ("restore-test", "hash", "restore@example.com"),
                    )
                    await connection.commit()
                finally:
                    await connection.close()

                path = db._DB_PATH
                path.unlink()
                for suffix in ("-wal", "-shm"):
                    stale = Path(f"{path}{suffix}")
                    if stale.exists():
                        stale.unlink()
                await db.init_db()
                connection = await db.get_connection()
                try:
                    row = await (await connection.execute(
                        "SELECT email FROM users WHERE client_id = ?", ("restore-test",)
                    )).fetchone()
                    self.assertEqual(row[0], "restore@example.com")
                finally:
                    await connection.close()
            finally:
                durable._enabled = False


if __name__ == "__main__":
    unittest.main()
