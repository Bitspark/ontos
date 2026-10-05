"""Pins the producer-admission laws (ontos-data.md §4.1) for this core.

Python's two findings are different in kind from the other cores', and the tests
below keep that distinction visible:

* ``encode_text`` already REJECTED surrogates — ``str.encode("utf-8")`` refuses
  them. But it raised ``UnicodeEncodeError``, a stdlib ``ValueError`` outside this
  package's error type, so a caller correctly handling ``DataError`` still crashed.
  That is a law-3 (rejection completeness) defect: an interface bug, not a
  correctness one.

* ``encode_int`` ACCEPTED ``True`` and encoded it as the integer 1 — byte-identical
  to ``encode_int(1)``. That is a law-2 (fidelity) defect, and it is the only one of
  the four cores' findings that the host type system actively hides: ``bool`` is an
  ``int`` subclass, so the annotation admits it and a type checker stays silent.
"""

import sys
import unittest
from pathlib import Path

# Self-bootstrapping, exactly like test_data.py: CI runs these files DIRECTLY
# (`python3 <file>`) and sets no PYTHONPATH, so a test relying on the ambient
# environment passes locally and ImportErrors in CI.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
for _lane in ("core", "codec", "data"):
    sys.path.insert(0, str(_REPO_ROOT / _lane / "py"))

from ontos_data import (  # noqa: E402
    DataError,
    encode_bool,
    encode_int,
    encode_text,
    read_int,
    read_text,
)
from ontos_core import atom, tuple_  # noqa: E402

_LABEL_TEXT = b"utf8-text"

# Strings outside utf8-text's admissible domain. A lone surrogate is representable
# as a Python str but is not a Unicode scalar value and has no UTF-8 encoding.
_INVALID = {
    "lone high surrogate": "\ud800",
    "lone low surrogate": "\udc00",
    "surrogate after text": "ok\ud800",
    "surrogate before text": "\ud800ok",
    "surrogateescape byte": b"\x80".decode("utf-8", "surrogateescape"),
}


class TestTextProducerAdmission(unittest.TestCase):
    def test_law3_rejects_through_the_packages_own_error_channel(self):
        for name, s in _INVALID.items():
            with self.subTest(name):
                # Control: confirm the case really is inadmissible, so a corpus that
                # silently became valid cannot make this test vacuous.
                with self.assertRaises(UnicodeEncodeError):
                    s.encode("utf-8")

                with self.assertRaises(DataError) as ctx:
                    encode_text(s)
                self.assertEqual(ctx.exception.code, "invalid_utf8")

    def test_law3_does_not_leak_the_stdlib_exception(self):
        # The precise defect: a caller handling DataError must not ALSO have to catch
        # UnicodeEncodeError. Since UnicodeEncodeError is a ValueError and DataError
        # is not, catching DataError alone must now suffice.
        self.assertFalse(issubclass(DataError, ValueError))
        try:
            encode_text("\ud800")
        except DataError:
            pass  # required
        except UnicodeEncodeError:  # pragma: no cover - the bug this test pins
            self.fail("stdlib UnicodeEncodeError leaked out of encode_text (§4.1 law 3)")

        # ...and the original cause is preserved for diagnosis rather than discarded.
        with self.assertRaises(DataError) as ctx:
            encode_text("\ud800")
        self.assertIsInstance(ctx.exception.__cause__, UnicodeEncodeError)

    def test_law1_successful_output_is_always_readable(self):
        admissible = [
            "",
            "hi",
            "ünïcødé",
            "日本語",
            "\U0001f600",  # astral
            "a\U0010ffffz",  # max scalar value
            "\x00",  # NUL is a scalar value and is admissible
            "é",  # e + COMBINING ACUTE - never normalized (§5.2)
        ]
        for s in admissible:
            with self.subTest(s):
                v = encode_text(s)
                self.assertEqual(read_text(v), s)

    def test_does_not_substitute_a_replacement_char(self):
        # Reject, never repair. A producer that substituted U+FFFD (the TypeScript
        # core's former behavior) would still round-trip and still be recognized -
        # so pin that the substituted value is well-formed, which is exactly why
        # substitution would be undetectable downstream.
        substituted = tuple_([atom(_LABEL_TEXT), atom("�".encode("utf-8"))])
        self.assertEqual(read_text(substituted), "�")
        with self.assertRaises(DataError):
            encode_text("\ud800")


class TestIntProducerAdmission(unittest.TestCase):
    def test_law2_bool_is_not_an_int(self):
        # The defect, stated as the equality that used to hold.
        for b in (True, False):
            with self.subTest(b):
                with self.assertRaises(DataError) as ctx:
                    encode_int(b)
                self.assertEqual(ctx.exception.code, "wrong_host_type")

    def test_law2_control_bool_would_have_been_byte_identical_to_an_int(self):
        # Positive control for the test above: show the collision is real by
        # constructing what encode_int(True) used to return and confirming it is
        # byte-identical to encode_int(1) - and DIFFERENT from encode_bool(True).
        as_int_one = encode_int(1)
        as_bool_true = encode_bool(True)
        self.assertNotEqual(as_int_one, as_bool_true, "the two embeddings must differ")
        # int 1 reads back as 1; had the bool been admitted it would read as 1 too,
        # which is the silent datum change.
        self.assertEqual(read_int(as_int_one), 1)

    def test_bool_is_still_an_int_subclass_so_isinstance_alone_would_not_catch_it(self):
        # Documents WHY the guard is an explicit bool test rather than an isinstance
        # gate. If this ever fails, Python changed and the guard can be simplified.
        self.assertTrue(isinstance(True, int))
        self.assertIsNot(type(True), int)

    def test_int_subclasses_that_denote_integers_stay_admissible(self):
        # An int subclass with no competing embedding is an ordinary exact integer.
        # Rejecting it would be over-strict: the rule is "does this denote a datum of
        # a DIFFERENT embedding", and nothing else claims these.
        import enum

        class Scale(enum.IntEnum):
            NANO = 9

        v = encode_int(Scale.NANO)
        self.assertEqual(read_int(v), 9)
        self.assertEqual(v, encode_int(9), "must encode identically to the plain int")

    def test_non_integers_are_rejected(self):
        for bad in ("1", 1.0, None, [1]):
            with self.subTest(repr(bad)):
                with self.assertRaises(DataError) as ctx:
                    encode_int(bad)
                self.assertEqual(ctx.exception.code, "wrong_host_type")


if __name__ == "__main__":
    unittest.main()
