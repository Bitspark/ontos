"""Text-key map convenience API: existing bytes, unchanged arbitrary children."""
import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
for _lane in ("core", "codec", "data"):
    sys.path.insert(0, str(_ROOT / _lane / "py"))

from ontos_core import atom, tuple_  # noqa: E402
from ontos_codec import encode  # noqa: E402
from ontos_data import DataError, encode_map, encode_text, encode_text_map, read_text_map  # noqa: E402


class TextMapTests(unittest.TestCase):
    def test_existing_bytes_and_codec_order(self):
        first, second = atom(b"\xff"), tuple_([])
        entries = [("aa", second), ("b", first)]
        value = encode_text_map(entries)
        self.assertEqual(encode(value).hex(),
            "010300036d6170010201020009757466382d746578740001620001ff010201020009757466382d74657874000261610100")
        read = read_text_map(value)
        self.assertEqual([key for key, _ in read], ["b", "aa"])
        self.assertIs(read[0][1], first)
        self.assertIs(read[1][1], second)
        self.assertEqual(value, encode_text_map(list(reversed(entries))))
        self.assertEqual(read_text_map(encode_text_map([])), [])

    def test_unicode_and_arbitrary_children(self):
        opaque = tuple_([atom(b"int"), atom(b"\xff")])
        keys = ["", "__proto__", "constructor", "\0", "é", "e\u0301", "😀", "\U0010ffff"]
        read = read_text_map(encode_text_map([(key, opaque) for key in keys]))
        self.assertEqual(len(read), len(keys))
        self.assertEqual({key for key, _ in read}, set(keys))
        for _, child in read:
            self.assertIs(child, opaque)

    def test_invalid_native_inputs(self):
        child = tuple_([])
        with self.assertRaises(DataError) as ctx:
            encode_text_map([("x", child), ("x", child)])
        self.assertEqual(ctx.exception.code, "duplicate_key")
        for key in ["\ud800", "\udc00", "a\ud800z"]:
            with self.assertRaises(DataError) as ctx:
                encode_text_map([(key, child)])
            self.assertEqual(ctx.exception.code, "invalid_utf8")
        for malformed in [None, {}, "", b"", [None], [(1, child)], [("x",)], [("x", child, child)]]:
            with self.assertRaises(DataError) as ctx:
                encode_text_map(malformed)
            self.assertEqual(ctx.exception.code, "malformed_entry")

    def test_reader_rejects_without_repair(self):
        label, child = atom(b"map"), tuple_([])
        a, b = encode_text("a"), encode_text("b")
        malformed = [
            atom(b""), tuple_([]), tuple_([label, tuple_([a])]),
            tuple_([label, tuple_([b, child]), tuple_([a, child])]),
            tuple_([label, tuple_([a, child]), tuple_([a, child])]),
            encode_map([(atom(b""), child)]),
            encode_map([(tuple_([atom(b"utf8-text"), atom(b"\xff")]), child)]),
        ]
        for value in malformed:
            with self.assertRaises(DataError):
                read_text_map(value)


if __name__ == "__main__":
    unittest.main()
