"""Find a keyword in a HAR export and save sanitized response samples (stage 0)."""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import logging
import re
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlparse

MAX_SLUG_LENGTH = 80
FILENAME_UNSAFE_CHARACTERS = re.compile(r"[^a-zA-Z0-9]+")

logger = logging.getLogger("har_sampler")


class HarFormatError(ValueError):
    """The file is not a HAR export this tool can read."""


@dataclass(frozen=True)
class SanitizedEntry:
    """One HAR entry without headers, cookies or query strings: those carry tokens."""

    method: str
    host: str
    path: str
    status: int
    request_body: str | None
    body: str


def decode_response_body(response: dict, position: int) -> str:
    content = response.get("content", {})
    text = content.get("text") or ""
    if content.get("encoding") != "base64":
        return text
    try:
        return base64.b64decode(text).decode("utf-8", errors="replace")
    except binascii.Error as error:
        raise HarFormatError(f"Entry #{position}: response body is not valid base64") from error


def parse_entry(raw_entry: dict, position: int) -> SanitizedEntry:
    """Keep only what is useful for mapping data sources and safe to store."""
    try:
        request = raw_entry["request"]
        response = raw_entry["response"]
        url = urlparse(request["url"])
        return SanitizedEntry(
            method=request["method"],
            host=url.netloc,
            path=url.path,
            status=response["status"],
            request_body=request.get("postData", {}).get("text"),
            body=decode_response_body(response, position),
        )
    except KeyError as error:
        raise HarFormatError(f"Entry #{position}: missing field {error}") from error


def load_entries(har_path: Path) -> list[SanitizedEntry]:
    """Read a HAR file and return its entries in sanitized form."""
    try:
        har = json.loads(har_path.read_text(encoding="utf-8"))
        raw_entries = har["log"]["entries"]
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HarFormatError(f"{har_path} is not valid JSON: {error}") from error
    except (KeyError, TypeError) as error:
        raise HarFormatError(f"{har_path} has no log.entries section") from error
    return [parse_entry(raw_entry, position) for position, raw_entry in enumerate(raw_entries)]


def build_sample_filename(position: int, entry: SanitizedEntry) -> str:
    slug = FILENAME_UNSAFE_CHARACTERS.sub("_", entry.host + entry.path)[:MAX_SLUG_LENGTH]
    return f"{position:03d}_{slug}.json"


def save_sample(entry: SanitizedEntry, position: int, output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    sample_path = output_dir / build_sample_filename(position, entry)
    sample_path.write_text(
        json.dumps(asdict(entry), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return sample_path


def run_search(entries: list[SanitizedEntry], keyword: str, save_dir: Path | None) -> int:
    """Log every entry whose response contains the keyword; return how many matched."""
    match_count = 0
    for position, entry in enumerate(entries):
        if keyword.casefold() not in entry.body.casefold():
            continue
        match_count += 1
        logger.info(
            "%s %s %s%s (%d chars)",
            entry.method,
            entry.status,
            entry.host,
            entry.path,
            len(entry.body),
        )
        if save_dir is not None:
            save_sample(entry, position, save_dir)
    return match_count


def parse_arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("har_file", type=Path)
    parser.add_argument("keyword", help="text to look for in response bodies")
    parser.add_argument("--save-dir", type=Path, help="folder for sanitized samples")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    # Results go through the logger on stdout, so one mechanism serves every message.
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    arguments = parse_arguments(argv)
    try:
        entries = load_entries(arguments.har_file)
    except (HarFormatError, OSError) as error:
        logger.error("Cannot read the HAR file: %s", error)
        return 1
    match_count = run_search(entries, arguments.keyword, arguments.save_dir)
    logger.info("Matching entries: %d", match_count)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
