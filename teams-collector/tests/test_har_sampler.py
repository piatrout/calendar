import base64
import json
import logging
import tempfile
import unittest
from pathlib import Path

from har_sampler import HarFormatError, load_entries, main, parse_entry

SECRET_TOKEN = "super-secret-token"


def build_raw_entry(body: str = '{"title": "Kolokwium 1"}', encoding: str | None = None) -> dict:
    content = {"text": body}
    if encoding:
        content["encoding"] = encoding
    return {
        "request": {
            "method": "GET",
            "url": f"https://teams.example/api/assignments?token={SECRET_TOKEN}",
            "headers": [{"name": "Authorization", "value": f"Bearer {SECRET_TOKEN}"}],
            "cookies": [{"name": "session", "value": SECRET_TOKEN}],
        },
        "response": {"status": 200, "content": content},
    }


def write_har(directory: Path, raw_entries: list[dict]) -> Path:
    har_path = directory / "session.har"
    har_path.write_text(json.dumps({"log": {"entries": raw_entries}}), encoding="utf-8")
    return har_path


class ParseEntryTest(unittest.TestCase):
    def test_drops_query_string_headers_and_cookies(self) -> None:
        entry = parse_entry(build_raw_entry(), position=0)
        self.assertEqual(entry.path, "/api/assignments")
        self.assertNotIn(SECRET_TOKEN, json.dumps(entry.__dict__))

    def test_decodes_base64_bodies(self) -> None:
        encoded = base64.b64encode("Kolokwium żółć".encode()).decode()
        entry = parse_entry(build_raw_entry(body=encoded, encoding="base64"), position=0)
        self.assertEqual(entry.body, "Kolokwium żółć")

    def test_reports_the_position_of_a_broken_entry(self) -> None:
        with self.assertRaisesRegex(HarFormatError, "Entry #7"):
            parse_entry({"request": {}}, position=7)


class MainTest(unittest.TestCase):
    def setUp(self) -> None:
        temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(temporary_directory.cleanup)
        self.directory = Path(temporary_directory.name)

    def test_saves_only_entries_that_contain_the_keyword(self) -> None:
        har_path = write_har(
            self.directory, [build_raw_entry(), build_raw_entry(body='{"title": "Other"}')]
        )
        save_dir = self.directory / "samples"

        exit_code = main([str(har_path), "kolokwium", "--save-dir", str(save_dir)])

        self.assertEqual(exit_code, 0)
        saved_files = list(save_dir.glob("*.json"))
        self.assertEqual(len(saved_files), 1)
        self.assertNotIn(SECRET_TOKEN, saved_files[0].read_text())

    def test_returns_an_error_code_for_a_missing_file(self) -> None:
        with self.assertLogs("har_sampler", level=logging.ERROR):
            self.assertEqual(main([str(self.directory / "missing.har"), "x"]), 1)

    def test_returns_an_error_code_for_a_file_that_is_not_har(self) -> None:
        not_har = self.directory / "not.har"
        not_har.write_text("{}", encoding="utf-8")
        with self.assertLogs("har_sampler", level=logging.ERROR):
            self.assertEqual(main([str(not_har), "x"]), 1)

    def test_load_entries_rejects_invalid_json(self) -> None:
        broken = self.directory / "broken.har"
        broken.write_text("{oops", encoding="utf-8")
        with self.assertRaises(HarFormatError):
            load_entries(broken)


if __name__ == "__main__":
    unittest.main()
