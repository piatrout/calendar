"""Local HTTP receiver: stores raw browser captures exactly as received."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlparse

# Loopback only: the receiver must never be reachable from the network.
HOST = "127.0.0.1"
PORT = 8765  # keep in sync with RECEIVER_URL in extension/background.js
INGEST_PATH = "/ingest"
MAX_REQUEST_BYTES = 20 * 1024 * 1024
SECRET_HEADER = "X-Collector-Secret"
SECRET_ENV_NAME = "COLLECTOR_SECRET"
RAW_DIR_ENV_NAME = "COLLECTOR_RAW_DIR"
DEFAULT_RAW_DIR = "data/raw"
MIN_SECRET_LENGTH = 24
REQUIRED_TEXT_FIELDS = ("url", "body", "captured_at")

logger = logging.getLogger("capture_receiver")


class CaptureValidationError(ValueError):
    """The request is not a well-formed capture."""


class ConfigError(Exception):
    """Required configuration is missing or invalid."""


@dataclass(frozen=True)
class ReceiverConfig:
    secret: str
    raw_dir: Path


def load_config(environment: Mapping[str, str]) -> ReceiverConfig:
    """Read settings from environment variables and fail fast if they are unusable."""
    secret = environment.get(SECRET_ENV_NAME, "")
    if len(secret) < MIN_SECRET_LENGTH:
        raise ConfigError(
            f"{SECRET_ENV_NAME} must be set and at least {MIN_SECRET_LENGTH} characters long"
        )
    raw_dir = Path(environment.get(RAW_DIR_ENV_NAME, DEFAULT_RAW_DIR))
    return ReceiverConfig(secret=secret, raw_dir=raw_dir)


def describe_url(url: str) -> str:
    """Return only the path: query strings can carry tokens and must stay out of logs."""
    return urlparse(url).path


def parse_capture(raw_body: bytes) -> dict:
    """Validate the request body and return the capture as a dict."""
    try:
        capture = json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise CaptureValidationError(f"Body is not valid JSON: {error}") from error
    if not isinstance(capture, dict):
        raise CaptureValidationError(
            f"Body must be a JSON object, got {type(capture).__name__}"
        )
    invalid_fields = [
        name for name in REQUIRED_TEXT_FIELDS if not isinstance(capture.get(name), str)
    ]
    if invalid_fields:
        raise CaptureValidationError(f"Missing or non-text fields: {invalid_fields}")
    return capture


def compute_digest(capture: dict) -> str:
    """Identify a response by its address and content, so identical repeats collapse."""
    content = f"{capture['url']}\n{capture['body']}"
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def write_atomically(path: Path, text: str) -> None:
    # Write-then-rename: a crash never leaves a half-written snapshot behind.
    temporary_path = path.with_suffix(".tmp")
    temporary_path.write_text(text, encoding="utf-8")
    temporary_path.replace(path)


class CaptureStore:
    """Writes each unique capture once and logs every time it is observed.

    The observation log is what tells later stages when a course was last opened,
    even if its data did not change.
    """

    def __init__(self, raw_dir: Path) -> None:
        self._snapshot_dir = raw_dir / "snapshots"
        self._observations_file = raw_dir / "observations.jsonl"

    def save(self, capture: dict) -> bool:
        """Store the capture; return True if its content was not seen before."""
        digest = compute_digest(capture)
        self._snapshot_dir.mkdir(parents=True, exist_ok=True)
        snapshot_path = self._snapshot_dir / f"{digest}.json"
        is_new = not snapshot_path.exists()
        if is_new:
            write_atomically(snapshot_path, json.dumps(capture, ensure_ascii=False))
        self._append_observation(digest, capture)
        return is_new

    def _append_observation(self, digest: str, capture: dict) -> None:
        observation = {
            "digest": digest,
            "url": capture["url"],
            "captured_at": capture["captured_at"],
            "received_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._observations_file.open("a", encoding="utf-8") as file:
            file.write(json.dumps(observation, ensure_ascii=False) + "\n")


class IngestHandler(BaseHTTPRequestHandler):
    """Accepts one capture per POST request."""

    server: IngestServer

    def do_POST(self) -> None:
        try:
            raw_body = self._read_body()
        except CaptureValidationError as error:
            logger.warning("Rejected request: %s", error)
            self._send_empty_response(HTTPStatus.BAD_REQUEST)
            return
        # The body is read before any check so the client always gets a clean reply.
        if self.path != INGEST_PATH:
            self._send_empty_response(HTTPStatus.NOT_FOUND)
        elif not self._has_valid_secret():
            logger.warning("Rejected request with a missing or wrong secret")
            self._send_empty_response(HTTPStatus.UNAUTHORIZED)
        else:
            self._ingest(raw_body)

    def log_message(self, message_format: str, *arguments: object) -> None:
        logger.debug(message_format, *arguments)

    def _ingest(self, raw_body: bytes) -> None:
        try:
            capture = parse_capture(raw_body)
        except CaptureValidationError as error:
            logger.warning("Rejected capture: %s", error)
            self._send_empty_response(HTTPStatus.BAD_REQUEST)
            return
        try:
            is_new = self.server.store.save(capture)
        except OSError:
            # A 5xx makes the extension keep the record queued, so nothing is lost.
            logger.exception("Cannot write capture for %s", describe_url(capture["url"]))
            self._send_empty_response(HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        logger.info("Stored capture (new=%s): %s", is_new, describe_url(capture["url"]))
        self._send_empty_response(HTTPStatus.OK)

    def _has_valid_secret(self) -> bool:
        received = self.headers.get(SECRET_HEADER, "").encode("utf-8")
        return hmac.compare_digest(received, self.server.secret.encode("utf-8"))

    def _read_body(self) -> bytes:
        declared_length = self.headers.get("Content-Length", "")
        if not declared_length.isdecimal():
            raise CaptureValidationError(
                f"Content-Length is missing or not a number: {declared_length!r}"
            )
        length = int(declared_length)
        if not 0 < length <= MAX_REQUEST_BYTES:
            raise CaptureValidationError(
                f"Content-Length {length} is outside 1..{MAX_REQUEST_BYTES}"
            )
        return self.rfile.read(length)

    def _send_empty_response(self, status: HTTPStatus) -> None:
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()


class IngestServer(HTTPServer):
    """HTTP server that hands the store and the shared secret to its request handler."""

    def __init__(self, address: tuple[str, int], store: CaptureStore, secret: str) -> None:
        super().__init__(address, IngestHandler)
        self.store = store
        self.secret = secret


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    try:
        config = load_config(os.environ)
        server = IngestServer((HOST, PORT), CaptureStore(config.raw_dir), config.secret)
    except ConfigError as error:
        logger.error("%s", error)
        return 1
    except OSError:
        logger.exception("Cannot listen on %s:%d (is another receiver running?)", HOST, PORT)
        return 1
    logger.info("Listening on http://%s:%d%s", HOST, PORT, INGEST_PATH)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Stopped by user")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
