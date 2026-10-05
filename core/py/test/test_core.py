"""ontos/core (py) tests — identity vectors + the Value API contract.

Replays the shared L0 conformance vectors (vectors/identity.json) against the
Python core, then pins the binding's own API surface (construction, equality,
immutability, hashing-consistent-with-equality, and the diagnostic rendering the
CLI's human format reuses). Mirrors core/{go,rs,ts}'s test depth.

Run: ``python3 core/py/test/test_core.py``
"""

import json
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
sys.path.insert(0, str(_REPO_ROOT / "core" / "py"))

from ontos_core import Atom, Tuple, Value, atom, equals, is_value, tuple_  # noqa: E402

_VECTORS = _REPO_ROOT / "vectors"


def _value_from_json(node):
    """The vectors' authoring notation ({atom:hex}|{tuple:[...]}) -> Value."""
    if isinstance(node, dict) and isinstance(node.get("atom"), str):
        return atom(bytes.fromhex(node["atom"]))
    if isinstance(node, dict) and isinstance(node.get("tuple"), list):
        return tuple_([_value_from_json(child) for child in node["tuple"]])
    raise ValueError(f"value must be {{atom}} or {{tuple}}: {node!r}")


class IdentityVectorTests(unittest.TestCase):
    def test_identity_vectors(self):
        doc = json.loads((_VECTORS / "identity.json").read_text(encoding="utf-8"))
        self.assertGreater(len(doc["cases"]), 0, "no identity cases")
        for case in doc["cases"]:
            left = _value_from_json(case["left"])
            right = _value_from_json(case["right"])
            self.assertEqual(
                equals(left, right), case["equal"], f"identity case {case['name']}"
            )
            # The == operator is the same relation, both directions.
            self.assertEqual(left == right, case["equal"], f"== {case['name']}")
            self.assertEqual(right == left, case["equal"], f"reflected == {case['name']}")


class ApiTests(unittest.TestCase):
    def test_construction_and_access(self):
        a = atom(b"\x61")
        self.assertEqual(a.bytes(), b"\x61")
        self.assertEqual(len(a), 1)
        self.assertTrue(a.is_atom)
        self.assertFalse(a.is_tuple)

        t = tuple_([atom(b"\x61"), atom(b"\x62")])
        self.assertEqual(len(t), 2)
        self.assertTrue(t.is_tuple)
        self.assertFalse(t.is_atom)
        self.assertEqual(t.at(0), atom(b"\x61"))
        self.assertEqual(t.at(1), atom(b"\x62"))
        self.assertEqual(list(t.items()), [atom(b"\x61"), atom(b"\x62")])

    def test_empty_defaults(self):
        self.assertEqual(atom(), Atom())
        self.assertEqual(len(atom()), 0)
        self.assertEqual(tuple_(), Tuple())
        self.assertEqual(len(tuple_()), 0)
        # Atom("") != Tuple() — neither is "null" (ontos-core §3).
        self.assertNotEqual(atom(), tuple_())

    def test_atom_accepts_byte_iterables(self):
        self.assertEqual(atom([0x61, 0x62]), atom(b"ab"))
        self.assertEqual(atom(bytearray(b"ab")), atom(b"ab"))
        with self.assertRaises(ValueError):
            atom([256])  # out of octet range
        with self.assertRaises((TypeError, ValueError)):
            atom(["x"])  # not ints

    def test_tuple_rejects_non_values(self):
        with self.assertRaises(TypeError):
            tuple_([b"raw bytes"])  # bytes are not a Value; wrap in Atom
        with self.assertRaises(TypeError):
            tuple_([None])

    def test_is_value(self):
        self.assertTrue(is_value(atom()))
        self.assertTrue(is_value(tuple_()))
        self.assertFalse(is_value(b"bytes"))
        self.assertFalse(is_value(None))
        self.assertFalse(is_value("Atom(0x)"))

    def test_immutability(self):
        a = atom(b"a")
        t = tuple_([a])
        with self.assertRaises(AttributeError):
            a._bytes = b"b"
        with self.assertRaises(AttributeError):
            t._items = ()
        # items() returns an immutable builtin tuple — no aliasing mutation path.
        self.assertIsInstance(t.items(), tuple)

    def test_constructor_copies_input(self):
        # Mutating the source after construction must not change the value.
        source = bytearray(b"ab")
        a = atom(source)
        source[0] = 0x7A
        self.assertEqual(a.bytes(), b"ab")

        items = [atom(b"a")]
        t = tuple_(items)
        items.append(atom(b"b"))
        self.assertEqual(len(t), 1)

    def test_hash_consistent_with_structural_equality(self):
        # Equal values hash equal (hashability is a binding convenience; it
        # confers no new identity).
        self.assertEqual(hash(atom(b"a")), hash(atom(b"a")))
        self.assertEqual(
            hash(tuple_([atom(b"a"), tuple_()])), hash(tuple_([atom(b"a"), tuple_()]))
        )
        # Structurally distinct values may collide in principle, but the
        # tagged-hash scheme keeps the obvious confusables apart in practice.
        self.assertNotEqual(hash(atom()), hash(tuple_()))

    def test_str_rendering_matches_the_cross_core_display_form(self):
        # The CLI human format reuses this rendering, and the conformance
        # harness compares it byte-for-byte across go/rs/ts/py (ontos-internal#46).
        self.assertEqual(str(atom()), "Atom(0x)")
        self.assertEqual(str(atom(b"\x61")), "Atom(0x61)")
        self.assertEqual(str(tuple_()), "Tuple()")
        self.assertEqual(
            str(tuple_([atom(b"\x6d\x61\x70"), atom(b"\x61")])),
            "Tuple(Atom(0x6d6170), Atom(0x61))",
        )
        self.assertEqual(
            str(tuple_([atom(b"\x70"), tuple_([atom(b"\x71")])])),
            "Tuple(Atom(0x70), Tuple(Atom(0x71)))",
        )

    def test_equality_is_structural_not_representational(self):
        # Same structure, different construction paths: equal.
        shared = atom(b"x")
        left = tuple_([shared, shared])
        right = tuple_([atom(b"x"), atom(b"x")])
        self.assertEqual(left, right)
        # Arity, order, multiplicity, nesting, and byte length all distinguish.
        a, b = atom(b"a"), atom(b"b")
        self.assertNotEqual(tuple_([a, b]), tuple_([b, a]))
        self.assertNotEqual(tuple_([a]), tuple_([a, a]))
        self.assertNotEqual(tuple_([a]), a)
        self.assertNotEqual(tuple_([tuple_([a, b])]), tuple_([a, b]))
        self.assertNotEqual(atom(b"\x01"), atom(b"\x00\x01"))
        self.assertNotEqual(tuple_([atom()]), tuple_([tuple_()]))

    def test_equality_against_foreign_types(self):
        # A non-Value comparand is plain inequality, never a crash.
        self.assertFalse(atom(b"a") == b"a")
        self.assertFalse(tuple_() == ())
        self.assertTrue(atom(b"a") != "Atom(0x61)")

    def test_value_is_the_closed_base(self):
        self.assertIsInstance(atom(), Value)
        self.assertIsInstance(tuple_(), Value)


if __name__ == "__main__":
    unittest.main()
