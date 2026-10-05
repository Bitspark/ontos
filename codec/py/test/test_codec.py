"""ontos/codec (py) tests — vectors + impl-local boundary and property tests.

Replays the shared conformance vectors (vectors/codec.json uvarint/encode/reject
and vectors/data.json encode) against the Python codec, then adds the
implementation-local u64-domain boundary tests and the deterministic
never-crash / round-trip property sweeps that the other lanes carry (the
fixed-iteration property tests are the fuzz ceiling for the non-Go lanes).

Run: ``python3 codec/py/test/test_codec.py``
"""

import json
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
for _lane in ("core", "codec"):
    sys.path.insert(0, str(_REPO_ROOT / _lane / "py"))

from ontos_core import atom, equals, tuple_  # noqa: E402
from ontos_codec import DecodeError, decode, encode, encode_uvarint  # noqa: E402

_VECTORS = _REPO_ROOT / "vectors"


def _read_vectors(name):
    return json.loads((_VECTORS / name).read_text(encoding="utf-8"))


def _value_from_json(node):
    if isinstance(node, dict) and isinstance(node.get("atom"), str):
        return atom(bytes.fromhex(node["atom"]))
    if isinstance(node, dict) and isinstance(node.get("tuple"), list):
        return tuple_([_value_from_json(child) for child in node["tuple"]])
    raise ValueError(f"value must be {{atom}} or {{tuple}}: {node!r}")


class VectorTests(unittest.TestCase):
    def test_uvarint_vectors(self):
        doc = _read_vectors("codec.json")
        for case in doc["uvarint"]:
            self.assertEqual(
                encode_uvarint(case["n"]).hex(), case["hex"], f"uvarint({case['n']})"
            )

    def test_codec_encode_and_roundtrip_vectors(self):
        doc = _read_vectors("codec.json")
        for case in doc["encode"]:
            value = _value_from_json(case["value"])
            self.assertEqual(encode(value).hex(), case["hex"], f"encode {case['name']}")
            self.assertTrue(
                equals(decode(bytes.fromhex(case["hex"])), value),
                f"roundtrip {case['name']}",
            )

    def test_data_embedding_vectors(self):
        # ontos/data (L2) embeddings pinned as full ontos-codec-v1 encodings —
        # the same encode+roundtrip contract as codec.json's encode cases.
        doc = _read_vectors("data.json")
        self.assertGreater(len(doc["encode"]), 0, "no data cases")
        for case in doc["encode"]:
            value = _value_from_json(case["value"])
            self.assertEqual(encode(value).hex(), case["hex"], f"data encode {case['name']}")
            self.assertTrue(
                equals(decode(bytes.fromhex(case["hex"])), value),
                f"data roundtrip {case['name']}",
            )

    def test_codec_reject_vectors(self):
        doc = _read_vectors("codec.json")
        for case in doc["reject"]:
            with self.assertRaises(DecodeError, msg=f"reject {case['name']}") as ctx:
                decode(bytes.fromhex(case["hex"]))
            self.assertEqual(ctx.exception.code, case["code"], f"reject code {case['name']}")


def _decode_code(uvarint_hex):
    """The DecodeError code for an atom-length uvarint, or "OK" if it decodes.

    Each uvarint is placed behind a 0x00 (Atom) tag and run through the public
    decode() path, mirroring the other lanes' boundary tests.
    """
    try:
        decode(bytes.fromhex("00" + uvarint_hex))
        return "OK"
    except DecodeError as err:
        return err.code


class UvarintBoundaryTests(unittest.TestCase):
    """Implementation-local u64-domain boundary behavior (ontos-codec.md §3.1).

    Python's int is arbitrary precision, so this binding — like Go's — has no
    native materialization ceiling below 2^64: every valid u64 length
    materializes (and then usually fails unexpected_eof on the absent body,
    proving the uvarint itself was accepted). The >= 2^64 family is the
    cross-core uvarint_overflow contract.
    """

    def test_u64_max_materializes(self):
        # 2^64 - 1, canonical 10-byte ff..ff 01: a valid u64, accepted as a
        # length; the absent atom body then reports unexpected_eof.
        self.assertEqual(_decode_code("ffffffffffffffffff01"), "unexpected_eof")

    def test_2pow64_is_uvarint_overflow(self):
        # 2^64 is outside the u64 domain; minimal LEB128 needs an 11th byte.
        self.assertEqual(_decode_code("8080808080808080808002"), "uvarint_overflow")

    def test_10th_byte_over_ceiling_is_uvarint_overflow(self):
        # ff*9 03: the terminating 10th byte pushes the value past 2^64.
        self.assertEqual(_decode_code("ffffffffffffffffff03"), "uvarint_overflow")

    def test_eof_and_non_canonical_preserved(self):
        self.assertEqual(_decode_code("80"), "unexpected_eof")
        self.assertEqual(_decode_code("8000"), "non_canonical_uvarint")

    def test_encode_uvarint_domain(self):
        with self.assertRaises(ValueError):
            encode_uvarint(-1)
        with self.assertRaises(ValueError):
            encode_uvarint(1 << 64)
        self.assertEqual(encode_uvarint((1 << 64) - 1).hex(), "ffffffffffffffffff01")


class LimitTests(unittest.TestCase):
    """Optional resource limits fail safely as limit_exceeded (§4/§5)."""

    def test_max_depth(self):
        # Tuple(Tuple(Tuple(Atom()))) is depth 3 below the root.
        deep = atom()
        for _ in range(5):
            deep = tuple_([deep])
        raw = encode(deep)
        self.assertTrue(equals(decode(raw), deep))  # default limit is generous
        with self.assertRaises(DecodeError) as ctx:
            decode(raw, max_depth=2)
        self.assertEqual(ctx.exception.code, "limit_exceeded")

    def test_max_atom_bytes(self):
        raw = encode(atom(b"abcdef"))
        with self.assertRaises(DecodeError) as ctx:
            decode(raw, max_atom_bytes=3)
        self.assertEqual(ctx.exception.code, "limit_exceeded")
        self.assertTrue(equals(decode(raw, max_atom_bytes=6), atom(b"abcdef")))

    def test_max_tuple_arity(self):
        raw = encode(tuple_([atom(), atom(), atom()]))
        with self.assertRaises(DecodeError) as ctx:
            decode(raw, max_tuple_arity=2)
        self.assertEqual(ctx.exception.code, "limit_exceeded")


def _nested_bytes(depth):
    """The frozen byte form of ``depth`` one-element tuples around the atom "a", by hand:
    each tuple level is TAG_TUPLE 01 and arity 01; the atom is 00 (tag), 01 (length), 61."""
    return bytes.fromhex("0101") * depth + bytes.fromhex("000161")


def _nested_value(depth):
    v = atom(b"a")
    for _ in range(depth):
        v = tuple_([v])
    return v


def _levels(v):
    """Count the one-element tuple levels without recursing (ontos_core's equals does)."""
    n = 0
    while v.is_tuple:
        assert len(v) == 1
        v = v.at(0)
        n += 1
    assert v.bytes() == b"a"
    return n


class DepthTests(unittest.TestCase):
    """ontos-internal#347: encode and decode walk with an explicit stack, so depth is never bounded by
    Python's recursion limit (1000). ontos-codec.md §4.1 invariant 1: a 1024-deep value is
    accepted by every core and a 1025-deep one is limit_exceeded in every core.

    NEGATIVE WITNESS: the recursive walk raised RecursionError at depths 1000, 1024 and 1025."""

    def test_default_depth_1024_decodes(self):
        v = decode(_nested_bytes(1024))
        self.assertEqual(_levels(v), 1024)
        self.assertEqual(encode(v), _nested_bytes(1024))

    def test_depth_1025_is_limit_exceeded_not_recursion_error(self):
        with self.assertRaises(DecodeError) as ctx:
            decode(_nested_bytes(1025))
        self.assertEqual(ctx.exception.code, "limit_exceeded")

    def test_deep_value_encodes_byte_for_byte(self):
        self.assertEqual(encode(_nested_value(100_000)), _nested_bytes(100_000))

    def test_deep_value_decodes_when_the_limit_allows_it(self):
        raw = _nested_bytes(100_000)
        v = decode(raw, max_depth=100_000)
        self.assertEqual(_levels(v), 100_000)
        self.assertEqual(encode(v), raw)


class PropertyTests(unittest.TestCase):
    """Deterministic fixed-iteration property sweeps (the non-Go fuzz ceiling):
    decode never raises anything but DecodeError, and decode(encode(v)) == v."""

    def test_decode_never_crashes_on_arbitrary_bytes(self):
        import random

        rng = random.Random(0x60)  # deterministic — this is a property test, not fuzzing
        for trial in range(2000):
            data = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 64)))
            try:
                value = decode(data)
            except DecodeError:
                continue  # rejection is the expected negative outcome
            # Anything that decodes must be canonical: re-encoding reproduces it.
            self.assertEqual(encode(value), data, f"canonical idempotence trial {trial}")

    def test_roundtrip_on_generated_values(self):
        import random

        rng = random.Random(0x61)

        def gen(depth):
            if depth >= 4 or rng.random() < 0.5:
                return atom(bytes(rng.randrange(256) for _ in range(rng.randrange(0, 8))))
            return tuple_([gen(depth + 1) for _ in range(rng.randrange(0, 4))])

        for trial in range(500):
            value = gen(0)
            raw = encode(value)
            self.assertTrue(equals(decode(raw), value), f"roundtrip trial {trial}")


if __name__ == "__main__":
    unittest.main()
