"""ontos/data (py) tests — vectors + recognition negatives + round-trips.

Replays the shared ontos/data (L2) conformance vectors (vectors/data.json)
against the Python embeddings — encode, read, round-trip, and the FULL byte
chain (datum -> Value -> ontos-codec-v1 bytes equals the pinned hex) — then the
shared reject vectors, plus the authored per-kind negatives and beyond-vector
round-trips the other lanes carry. Mirrors data/{go,rs,ts}'s test depth.

Run: ``python3 data/py/test/test_data.py``
"""

import json
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
for _lane in ("core", "codec", "data"):
    sys.path.insert(0, str(_REPO_ROOT / _lane / "py"))

from ontos_core import Atom, Tuple, atom, equals, tuple_  # noqa: E402
from ontos_codec import encode  # noqa: E402
from ontos_data import (  # noqa: E402
    LABELS,
    DataError,
    encode_bool,
    encode_decimal,
    encode_int,
    encode_list,
    encode_map,
    encode_set,
    encode_text,
    read_bool,
    read_decimal,
    read_int,
    read_list,
    read_map,
    read_null,
    read_set,
    read_text,
    recognize_decimal,
    recognize_int,
    recognize_null,
    encode_null,
)

_VECTORS = _REPO_ROOT / "vectors"


def _read_vectors(name):
    return json.loads((_VECTORS / name).read_text(encoding="utf-8"))


def _value_from_json(node):
    if isinstance(node, dict) and isinstance(node.get("atom"), str):
        return atom(bytes.fromhex(node["atom"]))
    if isinstance(node, dict) and isinstance(node.get("tuple"), list):
        return tuple_([_value_from_json(child) for child in node["tuple"]])
    raise ValueError(f"value must be {{atom}} or {{tuple}}: {node!r}")


def _label_of(v):
    """The label string of an embedding value (child 0 of a non-empty Tuple)."""
    assert isinstance(v, Tuple) and len(v) >= 1
    child0 = v.at(0)
    assert isinstance(child0, Atom)
    return child0.bytes().decode("utf-8")


def _label_atom(s):
    return atom(s.encode("ascii"))


_READERS = {
    "int": read_int,
    "bool": read_bool,
    "utf8-text": read_text,
    "list": read_list,
    "map": read_map,
    "set": read_set,
    "decimal": read_decimal,
    "null": read_null,
}


class VectorTests(unittest.TestCase):
    def test_encode_vectors_full_chain(self):
        """Per-kind encode/read/round-trip + the full datum->Value->bytes chain."""
        doc = _read_vectors("data.json")
        self.assertGreater(len(doc["encode"]), 0, "no data cases")
        processed = 0

        for case in doc["encode"]:
            name = case["name"]
            v = _value_from_json(case["value"])
            label = _label_of(v)

            if label == "int":
                datum = int(case["datum"])
                self.assertTrue(equals(encode_int(datum), v), f"int encode {name}")
                self.assertEqual(read_int(v), datum, f"int read {name}")
                recognize_int(v)  # structural recognition accepts every vector int
            elif label == "bool":
                self.assertIn(case["datum"], ("true", "false"), f"bool datum {name}")
                datum = case["datum"] == "true"
                self.assertTrue(equals(encode_bool(datum), v), f"bool encode {name}")
                self.assertEqual(read_bool(v), datum, f"bool read {name}")
            elif label == "utf8-text":
                datum = read_text(v)  # derive structurally (case.datum is display-only)
                self.assertTrue(equals(encode_text(datum), v), f"text encode {name}")
            elif label == "list":
                datum = read_list(v)
                self.assertTrue(equals(encode_list(datum), v), f"list round-trip {name}")
            elif label == "map":
                entries = read_map(v)
                # encode_map must reproduce the canonical value from the entries...
                self.assertTrue(equals(encode_map(entries), v), f"map encode {name}")
                # ...AND from the entries REVERSED — proving encode_map SORTS.
                self.assertTrue(
                    equals(encode_map(list(reversed(entries))), v),
                    f"map encode (reversed input) {name}",
                )
            elif label == "set":
                elements = read_set(v)
                self.assertTrue(equals(encode_set(elements), v), f"set encode {name}")
                self.assertTrue(
                    equals(encode_set(list(reversed(elements))), v),
                    f"set encode (reversed input) {name}",
                )
            elif label == "decimal":
                mantissa, exponent = read_decimal(v)
                self.assertTrue(
                    equals(encode_decimal(mantissa, exponent), v), f"decimal round-trip {name}"
                )
                recognize_decimal(v)  # structural recognition accepts every vector decimal
            elif label == "null":
                # null is the single inhabitant; encode_null() reproduces V, and
                # recognize/read both accept it.
                self.assertTrue(equals(encode_null(), v), f"null encode {name}")
                recognize_null(v)
                read_null(v)
            else:
                # EXHAUSTIVENESS guard: a future vector with a new label forces an update.
                self.fail(f'unrecognized data label "{label}" in case {name}')

            # FULL byte chain: datum -> Value -> bytes equals the pinned hex.
            self.assertEqual(encode(v).hex(), case["hex"], f"data full byte chain {name}")
            processed += 1

        self.assertGreater(processed, 0, "processed zero data cases")

    def test_reject_vectors(self):
        """The shared reject array pins the cross-language RECOGNITION decision:
        each value is valid at L0 but NOT a well-formed embedding of its kind, so
        read_<kind> must reject it. (The specific DataError code is impl-local.)"""
        doc = _read_vectors("data.json")
        self.assertGreater(len(doc["reject"]), 0, "no data reject cases")
        for case in doc["reject"]:
            reader = _READERS.get(case["kind"])
            self.assertIsNotNone(reader, f'unrecognized reject kind "{case["kind"]}"')
            with self.assertRaises(DataError, msg=f"reject {case['name']}"):
                reader(_value_from_json(case["value"]))


class IntTests(unittest.TestCase):
    def test_read_int_rejects_malformed_and_cross_kind(self):
        cases = [
            ("non-tuple", atom(b"\x00")),
            ("wrong arity", tuple_([_label_atom("int"), atom(b"\x00"), atom(b"\x00")])),
            ("non-atom label", tuple_([tuple_(), atom(b"\x00")])),
            ("non-atom payload", tuple_([_label_atom("int"), tuple_()])),
            ("wrong label (bool)", encode_bool(True)),
            ("on list value", encode_list([atom(b"\x61")])),
            ("empty payload", tuple_([_label_atom("int"), atom()])),
            ("sign 0x02", tuple_([_label_atom("int"), atom(b"\x02\x01")])),
            ("negative zero", tuple_([_label_atom("int"), atom(b"\x01")])),
            ("leading-zero magnitude", tuple_([_label_atom("int"), atom(b"\x00\x00\x01")])),
        ]
        for name, value in cases:
            with self.assertRaises(DataError, msg=f"int {name}"):
                read_int(value)
            with self.assertRaises(DataError, msg=f"recognize_int {name}"):
                recognize_int(value)

    def test_int_roundtrips_including_large_values(self):
        for n in [0, 1, -1, 255, 256, -256, 65535, 123456789012345678901234567890, -(2**200)]:
            v = encode_int(n)
            self.assertEqual(read_int(v), n, f"int round-trip {n}")
            self.assertTrue(equals(encode_int(read_int(v)), v), f"int re-encode {n}")
        # Canonical zero payload: Tuple(Atom("int"), Atom(0x00)).
        self.assertTrue(equals(encode_int(0), tuple_([_label_atom("int"), atom(b"\x00")])))

    def test_recognize_int_is_structural_and_this_binding_is_unbounded(self):
        # 2^128: sign 0x00, magnitude 0x01 then sixteen 0x00 (the int_2pow128 vector).
        two_pow_128 = tuple_([_label_atom("int"), atom(bytes([0x00, 0x01]) + bytes(16))])
        recognize_int(two_pow_128)  # recognized structurally (no raise)
        # ...and this unbounded (Python int) binding also materializes it
        # (Rust's i128 would report a resource limit instead).
        self.assertEqual(read_int(two_pow_128), 2**128)


class BoolTests(unittest.TestCase):
    def test_read_bool_rejects_malformed(self):
        for name, value in [
            ("wrong label (int)", encode_int(1)),
            ("empty payload", tuple_([_label_atom("bool"), atom()])),
            ("payload 0x02", tuple_([_label_atom("bool"), atom(b"\x02")])),
            ("2-byte payload", tuple_([_label_atom("bool"), atom(b"\x00\x01")])),
        ]:
            with self.assertRaises(DataError, msg=f"bool {name}"):
                read_bool(value)

    def test_bool_roundtrips(self):
        for b in (False, True):
            v = encode_bool(b)
            self.assertEqual(read_bool(v), b)
            self.assertTrue(equals(encode_bool(read_bool(v)), v))


class TextTests(unittest.TestCase):
    def test_read_text_rejects_wrong_label_and_invalid_utf8(self):
        with self.assertRaises(DataError):
            read_text(encode_bool(False))
        with self.assertRaises(DataError) as ctx:
            read_text(tuple_([_label_atom("utf8-text"), atom(b"\xff")]))
        self.assertEqual(ctx.exception.code, "invalid_utf8")
        with self.assertRaises(DataError):
            read_text(tuple_([_label_atom("utf8-text"), atom(b"\x80")]))  # lone continuation
        # ACCEPTS the empty string.
        self.assertEqual(read_text(tuple_([_label_atom("utf8-text"), atom()])), "")

    def test_text_roundtrips_including_non_ascii(self):
        for s in ["", "hi", "hello, world", "héllo", "日本語", "emoji 😀 mix"]:
            v = encode_text(s)
            self.assertEqual(read_text(v), s, f"text round-trip {s!r}")
            self.assertTrue(equals(encode_text(read_text(v)), v))

    def test_text_is_byte_verbatim_no_unicode_normalization(self):
        # NFC "é" (U+00E9) and NFD "e"+combining-acute are byte-distinct, hence
        # distinct utf8-text values (ontos-data.md §5.2).
        self.assertFalse(equals(encode_text("é"), encode_text("é")))


class ListTests(unittest.TestCase):
    def test_read_list_rejects_bare_and_non_tuple(self):
        with self.assertRaises(DataError):
            read_list(tuple_([atom(b"\x61"), atom(b"\x62")]))  # bare unlabeled
        with self.assertRaises(DataError):
            read_list(atom(b"\x61"))
        with self.assertRaises(DataError):
            read_list(tuple_())  # arity 0 — no label child
        # ACCEPTS the empty list.
        self.assertEqual(read_list(tuple_([_label_atom("list")])), [])

    def test_list_roundtrips_and_identity(self):
        hetero = encode_list([atom(b"\x61"), encode_int(1), encode_text("hi")])
        self.assertEqual(len(read_list(hetero)), 3)
        self.assertTrue(equals(encode_list(read_list(hetero)), hetero))

        nested = encode_list([encode_list([]), encode_list([atom(b"\x61")])])
        elems = read_list(nested)
        self.assertEqual(len(read_list(elems[0])), 0)
        self.assertEqual(len(read_list(elems[1])), 1)

        # Order and multiplicity are identity (never sorted or deduplicated).
        a, b = atom(b"\x61"), atom(b"\x62")
        self.assertFalse(equals(encode_list([a, a]), encode_list([a])))
        self.assertFalse(equals(encode_list([a, b]), encode_list([b, a])))


class MapTests(unittest.TestCase):
    def test_read_map_rejects_malformed_forms(self):
        ml = _label_atom("map")
        cases = [
            ("unsorted", tuple_([ml, tuple_([atom(b"\x62"), atom(b"\x00")]), tuple_([atom(b"\x61"), atom(b"\x00")])])),
            ("duplicate key", tuple_([ml, tuple_([atom(b"\x61"), atom(b"\x00")]), tuple_([atom(b"\x61"), atom(b"\x01")])])),
            ("entry arity 3", tuple_([ml, tuple_([atom(b"\x61"), atom(b"\x00"), atom(b"\x01")])])),
            ("entry arity 1", tuple_([ml, tuple_([atom(b"\x61")])])),
            ("flat interleaved", tuple_([ml, atom(b"\x61"), atom(b"\x00")])),
            ("unlabeled", tuple_([tuple_([atom(b"\x61"), atom(b"\x00")])])),
            ("empty tuple", tuple_()),
            ("non-tuple", atom(b"map")),
            ("cross-kind (list)", encode_list([atom(b"\x61")])),
        ]
        for name, value in cases:
            with self.assertRaises(DataError, msg=f"map {name}"):
                read_map(value)

    def test_encode_map_sorts_and_rejects_duplicates(self):
        # Empty map: distinct from the empty list.
        empty = encode_map([])
        self.assertEqual(read_map(empty), [])
        self.assertTrue(equals(empty, tuple_([_label_atom("map")])))
        self.assertFalse(equals(empty, encode_list([])))

        # Heterogeneous keys handed OUT of order; encode_map sorts by codec key
        # bytes: bare atom 0x61 < int(1) < utf8-text("a") (map_mixed_keys order).
        unsorted = [
            (encode_text("a"), encode_int(256)),
            (encode_int(1), encode_bool(False)),
            (atom(b"\x61"), encode_bool(True)),
        ]
        m = encode_map(unsorted)
        entries = read_map(m)
        self.assertTrue(equals(entries[0][0], atom(b"\x61")))
        self.assertTrue(equals(entries[1][0], encode_int(1)))
        self.assertTrue(equals(entries[2][0], encode_text("a")))
        self.assertTrue(equals(encode_map(list(reversed(unsorted))), m))

        # Duplicate keys are the producer's problem: encode_map raises.
        with self.assertRaises(DataError) as ctx:
            encode_map([(atom(b"\x61"), encode_int(1)), (atom(b"\x61"), encode_int(2))])
        self.assertEqual(ctx.exception.code, "duplicate_key")

    def test_map_accepts_noncanonical_int_key_no_recursion(self):
        # int(000001) has a leading-zero magnitude (read_int rejects it), but it
        # is a perfectly good map KEY: a valid L0 value with a unique encoding.
        noncanonical = tuple_([_label_atom("int"), atom(b"\x00\x00\x01")])
        with self.assertRaises(DataError):
            read_int(noncanonical)  # sanity: really non-canonical
        m = encode_map([(noncanonical, atom(b"\x00"))])
        entries = read_map(m)
        self.assertTrue(equals(entries[0][0], noncanonical))


class SetTests(unittest.TestCase):
    def test_read_set_rejects_malformed_forms(self):
        sl = _label_atom("set")
        cases = [
            ("unsorted", tuple_([sl, atom(b"\x62"), atom(b"\x61")])),
            ("duplicate", tuple_([sl, atom(b"\x61"), atom(b"\x61")])),
            ("unlabeled", tuple_([atom(b"\x61"), atom(b"\x62")])),
            ("empty tuple", tuple_()),
            ("non-tuple", atom(b"set")),
            ("cross-kind (list)", encode_list([atom(b"\x61")])),
        ]
        for name, value in cases:
            with self.assertRaises(DataError, msg=f"set {name}"):
                read_set(value)

    def test_encode_set_sorts_and_rejects_duplicates(self):
        empty = encode_set([])
        self.assertEqual(read_set(empty), [])
        self.assertTrue(equals(empty, tuple_([_label_atom("set")])))
        self.assertFalse(equals(empty, encode_list([])))
        self.assertFalse(equals(empty, encode_map([])))

        unsorted = [encode_text("a"), encode_int(1), atom(b"\x61")]
        s = encode_set(unsorted)
        elems = read_set(s)
        self.assertTrue(equals(elems[0], atom(b"\x61")))
        self.assertTrue(equals(elems[1], encode_int(1)))
        self.assertTrue(equals(elems[2], encode_text("a")))
        self.assertTrue(equals(encode_set(list(reversed(unsorted))), s))

        with self.assertRaises(DataError) as ctx:
            encode_set([atom(b"\x61"), atom(b"\x61")])
        self.assertEqual(ctx.exception.code, "duplicate_element")
        with self.assertRaises(DataError):
            encode_set([encode_int(1), encode_int(1)])

    def test_set_accepts_noncanonical_int_element_no_recursion(self):
        noncanonical = tuple_([_label_atom("int"), atom(b"\x00\x00\x01")])
        s = encode_set([noncanonical])
        self.assertTrue(equals(read_set(s)[0], noncanonical))


class DecimalTests(unittest.TestCase):
    def test_encode_decimal_normalizes(self):
        # Producer normalization (§5.9): trailing base-10 zeros move to the
        # exponent; zero is pinned to decimal(int 0, int 0).
        self.assertTrue(equals(encode_decimal(100, 0), encode_decimal(1, 2)))
        self.assertTrue(equals(encode_decimal(0, 5), encode_decimal(0, 0)))
        self.assertTrue(equals(encode_decimal(-500, -3), encode_decimal(-5, -1)))
        self.assertEqual(read_decimal(encode_decimal(314, -2)), (314, -2))
        self.assertEqual(read_decimal(encode_decimal(3140, -3)), (314, -2))

    def test_read_decimal_rejects_malformed_forms(self):
        dl = _label_atom("decimal")
        cases = [
            # Trailing-zero mantissa (10 is divisible by 10).
            ("trailing-zero mantissa", tuple_([dl, encode_int(10), encode_int(0)])),
            # Zero mantissa with non-zero exponent.
            ("zero with non-zero exponent", tuple_([dl, encode_int(0), encode_int(5)])),
            # Non-canonical int mantissa — decimal RECURSES into its children (§5.9).
            (
                "non-canonical int mantissa",
                tuple_([dl, tuple_([_label_atom("int"), atom(b"\x00\x00\x01")]), encode_int(0)]),
            ),
            ("mantissa not an int", tuple_([dl, atom(b"\x01"), encode_int(0)])),
            ("wrong arity 2", tuple_([dl, encode_int(1)])),
            ("non-tuple", atom(b"decimal")),
            ("cross-kind (int)", encode_int(1)),
        ]
        for name, value in cases:
            with self.assertRaises(DataError, msg=f"decimal {name}"):
                read_decimal(value)
            with self.assertRaises(DataError, msg=f"recognize_decimal {name}"):
                recognize_decimal(value)

    def test_decimal_beyond_i128_recognized_and_materialized_here(self):
        # The decimal_2pow128_mantissa analog: recognized by every core,
        # materialized by the unbounded (Go/TS/py) bindings.
        v = encode_decimal(2**128, 0)
        recognize_decimal(v)
        mantissa, exponent = read_decimal(v)
        self.assertEqual((mantissa, exponent), (2**128, 0))

    def test_decimal_distinct_from_int_of_same_number(self):
        # decimal(1, 2) (the decimal 100) and int(100) are different L0 values.
        self.assertFalse(equals(encode_decimal(1, 2), encode_int(100)))


class NullTests(unittest.TestCase):
    def test_null_is_the_unique_nullary_compound(self):
        v = encode_null()
        # Exact canonical structure: Tuple(Atom("null")), arity exactly 1.
        self.assertTrue(equals(v, tuple_([_label_atom("null")])))
        # Frozen byte form: 01 01 00 04 6e 75 6c 6c (spec §5.10).
        self.assertEqual(encode(v).hex(), "010100046e756c6c")
        recognize_null(v)  # must not raise
        read_null(v)  # must not raise
        # Re-encoding is a fixpoint — null has no value to vary.
        self.assertTrue(equals(encode_null(), v))

    def test_read_null_rejects_payload_label_and_cross_kind(self):
        nl = _label_atom("null")
        cases = [
            # arity 2: a "null" with a payload child — present-but-no-value forbids payload.
            ("null_with_payload", tuple_([nl, atom(b"\x61")])),
            # arity 3: more payload, still rejected.
            ("null_with_two_payloads", tuple_([nl, atom(b"\x61"), atom(b"\x62")])),
            # arity 0: the bare empty tuple is not the null.
            ("empty_tuple", tuple_()),
            # a bare atom (even the bytes of "null") is not a null.
            ("bare_atom", atom(b"null")),
            # near-miss label.
            ("wrong_label", tuple_([_label_atom("nul")])),
            # cross-kind: a well-formed empty list is not a null.
            ("cross_kind_list", encode_list([])),
            # cross-kind: a well-formed bool is not a null.
            ("cross_kind_bool", encode_bool(False)),
        ]
        for name, value in cases:
            with self.assertRaises(DataError, msg=f"read_null {name}"):
                read_null(value)
            with self.assertRaises(DataError, msg=f"recognize_null {name}"):
                recognize_null(value)

    def test_null_recognized_only_as_null(self):
        v = encode_null()
        for reader in (read_list, read_set, read_map, read_bool):
            with self.assertRaises(DataError):
                reader(v)


class LabelsTests(unittest.TestCase):
    def test_labels_is_the_registered_set_in_recognition_order(self):
        self.assertEqual(
            list(LABELS), ["int", "utf8-text", "bool", "list", "map", "set", "decimal", "null"]
        )
        # One canonical embedding per kind, in LABELS order; each must be
        # recognized by exactly its own label's recognizer.
        recognizers = {
            "int": recognize_int,
            "utf8-text": read_text,
            "bool": read_bool,
            "list": read_list,
            "map": read_map,
            "set": read_set,
            "decimal": recognize_decimal,
            "null": recognize_null,
        }
        samples = [
            encode_int(1),
            encode_text("x"),
            encode_bool(True),
            encode_list([]),
            encode_map([]),
            encode_set([]),
            encode_decimal(1, 0),
            encode_null(),
        ]
        for label, sample in zip(LABELS, samples):
            recognizers[label](sample)  # must not raise

    def test_read_never_raises_anything_but_dataerror(self):
        """Deterministic sweep (the non-Go fuzz ceiling): every recognizer either
        succeeds or raises DataError on arbitrary decoded structure — never an
        unhandled exception."""
        import random

        sys.path.insert(0, str(_REPO_ROOT / "codec" / "py"))
        from ontos_codec import DecodeError, decode  # local import for the sweep

        readers = list(_READERS.values()) + [recognize_int, recognize_decimal, recognize_null]
        rng = random.Random(0x62)
        for _ in range(1000):
            data = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 48)))
            try:
                value = decode(data)
            except DecodeError:
                continue
            for reader in readers:
                try:
                    reader(value)
                except DataError:
                    pass  # the expected negative outcome


if __name__ == "__main__":
    unittest.main()
