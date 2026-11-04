import json
import logging
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from capture_receiver import (
    HOST,
    INGEST_PATH,
    SECRET_ENV_NAME,
    SECRET_HEADER,
    CaptureStore,
    CaptureValidationError,
    ConfigError,
    IngestServer,
    load_config,
    parse_capture,
)

SECRET = "s" * 32
CAPTURE = {
    "url": "https://teams.example/api/assignments?token=abc",
    "body": '{"items": []}',
    "captured_at": "2026-11-02T10:00:00.000Z",
}


def setUpModule() -> None:
    logging.disable(logging.CRITICAL)


def tearDownModule() -> None:
    logging.disable(logging.NOTSET)


class ParseCaptureTest(unittest.TestCase):
    def test_accepts_a_valid_capture(self) -> None:
        self.assertEqual(parse_capture(json.dumps(CAPTURE).encode()), CAPTURE)

    def test_rejects_invalid_json(self) -> None:
        with self.assertRaises(CaptureValidationError):
            parse_capture(b"{not json")

    def test_rejects_non_utf8_bytes(self) -> None:
        with self.assertRaises(CaptureValidationError):
            parse_capture(b"\xff\xfe")

    def test_rejects_a_json_list(self) -> None:
        with self.assertRaises(CaptureValidationError):
            parse_capture(b"[]")

    def test_rejects_a_missing_or_non_text_field(self) -> None:
        for field in CAPTURE:
            broken = {**CAPTURE, field: 123}
            with self.subTest(field=field), self.assertRaises(CaptureValidationError):
                parse_capture(json.dumps(broken).encode())


class LoadConfigTest(unittest.TestCase):
    def test_requires_a_long_enough_secret(self) -> None:
        for environment in ({}, {SECRET_ENV_NAME: "short"}):
            with self.subTest(environment=environment), self.assertRaises(ConfigError):
                load_config(environment)

    def test_uses_the_default_raw_directory(self) -> None:
        config = load_config({SECRET_ENV_NAME: SECRET})
        self.assertEqual(config.raw_dir, Path("data/raw"))


class CaptureStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        self.raw_dir = Path(temporary_directory.name)
        self.store = CaptureStore(self.raw_dir)

    def test_identical_captures_make_one_snapshot_but_every_observation_is_logged(self) -> None:
        first_is_new = self.store.save(CAPTURE)
        second_is_new = self.store.save({**CAPTURE, "captured_at": "2026-11-02T11:00:00.000Z"})

        self.assertTrue(first_is_new)
        self.assertFalse(second_is_new)
        self.assertEqual(len(list((self.raw_dir / "snapshots").glob("*.json"))), 1)
        observation_lines = (self.raw_dir / "observations.jsonl").read_text().splitlines()
        self.assertEqual(len(observation_lines), 2)

    def test_changed_body_makes_a_new_snapshot(self) -> None:
        self.store.save(CAPTURE)
        self.assertTrue(self.store.save({**CAPTURE, "body": '{"items": [1]}'}))


class IngestServerTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        self.raw_dir = Path(temporary_directory.name)
        self.server = IngestServer((HOST, 0), CaptureStore(self.raw_dir), SECRET)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        # Cleanups run in reverse order: shutdown, then join, then close the socket.
        self.addCleanup(self.server.server_close)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.shutdown)

    def post(self, body: bytes, secret: str = SECRET, path: str = INGEST_PATH) -> int:
        port = self.server.server_address[1]
        request = urllib.request.Request(
            f"http://{HOST}:{port}{path}",
            data=body,
            method="POST",
            headers={SECRET_HEADER: secret, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code

    def test_stores_a_capture_sent_with_the_right_secret(self) -> None:
        self.assertEqual(self.post(json.dumps(CAPTURE).encode()), 200)
        self.assertEqual(len(list((self.raw_dir / "snapshots").glob("*.json"))), 1)

    def test_rejects_a_wrong_secret_and_stores_nothing(self) -> None:
        self.assertEqual(self.post(json.dumps(CAPTURE).encode(), secret="wrong"), 401)
        self.assertFalse((self.raw_dir / "snapshots").exists())

    def test_rejects_a_malformed_body(self) -> None:
        self.assertEqual(self.post(b"{not json"), 400)

    def test_returns_not_found_for_other_paths(self) -> None:
        self.assertEqual(self.post(b"{}", path="/other"), 404)


if __name__ == "__main__":
    unittest.main()
