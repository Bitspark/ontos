"""ontos/codec (py) — operational limit reporting (ontos-codec.md §4.2, ontos-internal#352).

Every decoder-produced ``limit_exceeded`` names the bound that stopped it in
``limit_kind``. Replays vectors/codec-limits.json, and pins that Python, having no
native width ceiling, never reports ``native_width``.

Run: ``python3 codec/py/test/test_limits.py``
"""

import json
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
for _lane in ("core", "codec"):
    sys.path.insert(0, str(_REPO_ROOT / _lane / "py"))

import ontos_codec  # noqa: E402
from ontos_codec import (  # noqa: E402
    LIMIT_ATOM_BYTES,
    LIMIT_DECODE_DEPTH,
    LIMIT_NATIVE_WIDTH,
    LIMIT_TUPLE_ARITY,
    DecodeError,
    decode,
    encode_uvarint,
)

_VECTORS = _REPO_ROOT / "vectors"

# The vector file's limit names, mapped to decode()'s keyword arguments.
_LIMIT_ARGS = {"maxDepth": "max_depth", "maxAtomBytes": "max_atom_bytes", "maxTupleArity": "max_tuple_arity"}


def _read_vectors(name):
    return json.loads((_VECTORS / name).read_text(encoding="utf-8"))


def _decode_error(data, **limits):
    try:
        decode(data, **limits)
    except DecodeError as err:
        return err
    raise AssertionError(f"decode of {data.hex()} did not raise")


def _atom_of_length(length):
    """An atom tag followed by a declared byte length and no bytes."""
    return bytes([0x00]) + encode_uvarint(length)


class CodecLimitVectorTests(unittest.TestCase):
    def test_every_case_accepts_or_names_its_bound(self):
        cases = _read_vectors("codec-limits.json")["cases"]
        self.assertTrue(cases)
        for case in cases:
            with self.subTest(case=case["name"]):
                limits = {_LIMIT_ARGS[key]: bound for key, bound in case["limits"].items()}
                data = bytes.fromhex(case["hex"])
                if case["expect"] == "accept":
                    decode(data, **limits)
                    continue
                err = _decode_error(data, **limits)
                self.assertEqual(
                    (err.code, err.limit_kind), (case["expect"]["code"], case["expect"]["limitKind"])
                )

    def test_byte_contract_rejects_carry_no_limit_kind(self):
        for case in _read_vectors("codec.json")["reject"]:
            with self.subTest(case=case["name"]):
                self.assertIsNone(_decode_error(bytes.fromhex(case["hex"])).limit_kind)


class NativeWidthTests(unittest.TestCase):
    def test_python_never_reports_native_width(self):
        # Lengths past every other face's ceiling (TS 2^53 - 1, Go 2^63 - 1) and the u64
        # maximum all fail as truncation here, never as a limit.
        for length in ((1 << 53), (1 << 63), (1 << 64) - 1):
            with self.subTest(length=length):
                err = _decode_error(_atom_of_length(length))
                self.assertEqual((err.code, err.limit_kind), ("unexpected_eof", None))

    def test_the_worked_collision_is_atom_bytes_here(self):
        # ontos-codec.md §4.2: with an atom bound of 10, a 2^60-byte atom is atom_bytes on
        # a face whose length type holds 2^60, and native_width in TS.
        err = _decode_error(_atom_of_length(1 << 60), max_atom_bytes=10)
        self.assertEqual((err.code, err.limit_kind), ("limit_exceeded", LIMIT_ATOM_BYTES))


class CompatibilityTests(unittest.TestCase):
    def test_the_two_argument_constructor_and_the_parent_code_are_unchanged(self):
        built = DecodeError("limit_exceeded", "from a caller")
        self.assertEqual((built.code, built.args[0], built.limit_kind), ("limit_exceeded", "from a caller", None))

        err = _decode_error(bytes.fromhex("01010000"), max_depth=0)
        self.assertIsInstance(err, DecodeError)
        self.assertEqual(err.code, "limit_exceeded")
        self.assertEqual(err.args[0], "maximum decode depth exceeded: 0")
        self.assertEqual(err.limit_kind, LIMIT_DECODE_DEPTH)

    def test_the_kind_is_keyword_only(self):
        with self.assertRaises(TypeError):
            DecodeError("limit_exceeded", "positional kind", LIMIT_TUPLE_ARITY)  # type: ignore[misc]

    def test_an_unrecognized_kind_is_still_a_limit_exceeded(self):
        later = DecodeError("limit_exceeded", "from a later version", limit_kind="from_a_later_version")
        self.assertEqual(later.code, "limit_exceeded")
        known = {LIMIT_DECODE_DEPTH, LIMIT_ATOM_BYTES, LIMIT_TUPLE_ARITY, LIMIT_NATIVE_WIDTH}
        self.assertNotIn(later.limit_kind, known)

    def test_the_kind_names_are_exported(self):
        for name in ("LIMIT_DECODE_DEPTH", "LIMIT_ATOM_BYTES", "LIMIT_TUPLE_ARITY", "LIMIT_NATIVE_WIDTH"):
            self.assertIn(name, ontos_codec.__all__)


if __name__ == "__main__":
    unittest.main()
