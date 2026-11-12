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


def _nested(depth):
    """``depth`` one-element tuples around Atom(0x61), built without recursion."""
    v = atom(b"\x61")
    for _ in range(depth):
        v = tuple_([v])
    return v


def _nested_text(depth):
    return "Tuple(" * depth + "Atom(0x61)" + ")" * depth


def _recursive_str(value):
    """The rendering as it was before it became iterative: the oracle for byte identity."""
    if isinstance(value, Tuple):
        return "Tuple(" + ", ".join(_recursive_str(item) for item in value.items()) + ")"
    return f"Atom(0x{value.bytes().hex()})"


class DeepRenderingTests(unittest.TestCase):
    """str() and repr() walk with an explicit stack, so depth is never bounded by Python's
    recursion limit (1000). The codec's default decoder accepts a 1024-deep value, and a
    caller that logs one must not crash; codec/py's test_codec covers the decoded path.

    NEGATIVE WITNESS: the recursive form raised RecursionError from 900 levels, so both
    depths below failed on str() and on repr()."""

    def test_the_default_decode_depth_renders(self):
        v = _nested(1024)
        self.assertEqual(str(v), _nested_text(1024))
        self.assertEqual(repr(v), _nested_text(1024))
        self.assertEqual(f"{v}", _nested_text(1024))

    def test_a_100000_deep_value_renders(self):
        v = _nested(100_000)
        self.assertEqual(str(v), _nested_text(100_000))
        self.assertEqual(repr(v), _nested_text(100_000))

    def test_a_deep_child_among_siblings_renders(self):
        # Separators and closers stay right when the walk returns from a deep child.
        v = tuple_([atom(b"\x01"), _nested(5_000), tuple_(), atom(b"\x02")])
        self.assertEqual(
            str(v), "Tuple(Atom(0x01), " + _nested_text(5_000) + ", Tuple(), Atom(0x02))"
        )

    def test_output_is_the_recursive_forms_byte_for_byte(self):
        import random

        rng = random.Random(0x62)  # deterministic: a property sweep, not fuzzing

        def gen(depth):
            if depth >= 6 or rng.random() < 0.4:
                return atom(bytes(rng.randrange(256) for _ in range(rng.randrange(0, 4))))
            return tuple_([gen(depth + 1) for _ in range(rng.randrange(0, 5))])

        for trial in range(500):
            v = gen(0)
            self.assertEqual(str(v), _recursive_str(v), f"trial {trial}")
            self.assertEqual(repr(v), _recursive_str(v), f"trial {trial}")

    def test_a_child_that_overrides_str_still_renders_through_it(self):
        # The recursive form called str() on every child, so a subclass's own rendering
        # showed inside its parent. The walk keeps that.
        class Point(Tuple):
            def __str__(self):
                return "Point"

        class Label(Atom):
            def __str__(self):
                return "Label"

        v = tuple_([Point([atom(b"\x01")]), tuple_([Label(b"\x02")]), atom(b"\x03")])
        self.assertEqual(str(v), "Tuple(Point, Tuple(Label), Atom(0x03))")
        self.assertEqual(repr(v), "Tuple(Point, Tuple(Label), Atom(0x03))")

        # A subclass that keeps Tuple's rendering is walked like a Tuple.
        class Plain(Tuple):
            pass

        self.assertEqual(str(tuple_([Plain([atom(b"\x04")])])), "Tuple(Tuple(Atom(0x04)))")


def _mirror(value):
    """The value as nested builtin tuples, ("atom", bytes) and ("tuple", (children...)):
    the recursive form's __hash__ was hash(("tuple", items)) at every level, so hash(value)
    must equal hash(_mirror(value)), and == must agree with the builtin tuples' ==. Built
    with an explicit stack; hashing it recurses in C, so keep it to modest depths."""
    built = {}
    pending = [(value, False)]
    while pending:
        node, ready = pending.pop()
        if isinstance(node, Atom):
            built[id(node)] = ("atom", node.bytes())
        elif ready:
            built[id(node)] = ("tuple", tuple(built[id(c)] for c in node.items()))
        else:
            pending.append((node, True))
            pending.extend((c, False) for c in node.items())
    return built[id(value)]


def _nested_on(leaf, depth):
    v = leaf
    for _ in range(depth):
        v = tuple_([v])
    return v


class DeepEqualityAndHashTests(unittest.TestCase):
    """== and hash() walk with an explicit stack, so depth is never bounded by Python's
    recursion limit (1000), and hash() returns the very number the recursive form did, so
    dicts and sets built before keep agreeing.

    NEGATIVE WITNESS: the recursive forms raised RecursionError from 1000 levels, so ==,
    !=, hash() and dict use failed at both depths below."""

    def _check_deep(self, depth):
        # Each line is a whole walk of the value; equals() is == by definition.
        a, b = _nested(depth), _nested(depth)
        self.assertTrue(a == b)
        self.assertFalse(a != b)
        # A dict lookup hashes both and compares them.
        self.assertEqual({a: "found"}[b], "found")
        # A difference at the very bottom, in arity, or in depth is still seen.
        self.assertTrue(a != _nested_on(atom(b"\x62"), depth))
        self.assertFalse(a == _nested_on(tuple_([atom(b"\x61"), atom()]), depth - 1))
        self.assertFalse(_nested(depth - 1) == a)

    def test_the_default_decode_depth_compares_and_hashes(self):
        self._check_deep(1024)
        # Still shallow enough for the C recursion of the builtin tuple hash.
        self.assertEqual(hash(_nested(1024)), hash(_mirror(_nested(1024))))

    def test_a_100000_deep_value_compares_and_hashes(self):
        self._check_deep(100_000)

    def test_hash_is_the_recursive_forms_number(self):
        import random

        rng = random.Random(0x65)  # deterministic: a property sweep, not fuzzing

        def gen(depth):
            if depth >= 6 or rng.random() < 0.4:
                return atom(bytes(rng.randrange(256) for _ in range(rng.randrange(0, 4))))
            return tuple_([gen(depth + 1) for _ in range(rng.randrange(0, 5))])

        for trial in range(500):
            v = gen(0)
            self.assertEqual(hash(v), hash(_mirror(v)), f"trial {trial}")

        # Shared subtrees: a doubling chain is hashed once per distinct tuple, to the same
        # number as its unshared mirror.
        chain = atom(b"\x61")
        for _ in range(12):
            chain = tuple_([chain, atom(b""), chain])
        self.assertEqual(hash(chain), hash(_mirror(chain)))

    def test_equality_is_the_recursive_forms_relation(self):
        import random

        rng = random.Random(0x66)

        def gen(depth):
            # A small space, so that many pairs are equal without being one object.
            if depth >= 3 or rng.random() < 0.4:
                return atom(bytes(rng.randrange(2) for _ in range(rng.randrange(0, 2))))
            return tuple_([gen(depth + 1) for _ in range(rng.randrange(0, 3))])

        values = [gen(0) for _ in range(80)]
        equal_pairs = 0
        for left in values:
            for right in values:
                want = _mirror(left) == _mirror(right)
                self.assertEqual(left == right, want)
                self.assertEqual(left != right, not want)
                if want:
                    equal_pairs += 1
                    self.assertEqual(hash(left), hash(right))
        self.assertGreater(equal_pairs, 2 * len(values), "the sweep must meet equal pairs")

    def test_a_child_that_overrides_eq_or_hash_is_still_asked(self):
        # The recursive forms called each child's own __eq__ and __hash__ (through the
        # builtin tuple's == and hash), so an override decided its own pair. The walk keeps
        # that, including Python's rule that a subclass on the right is asked first.
        class Loose(Tuple):
            def __eq__(self, other):
                return True

            __hash__ = Tuple.__hash__

        class Sub(Tuple):
            pass

        one, two = atom(b"\x01"), atom(b"\x02")
        self.assertTrue(tuple_([Loose([one])]) == tuple_([tuple_([two])]))
        self.assertTrue(tuple_([tuple_([two])]) == tuple_([Loose([one])]))
        # Sub keeps Tuple.__eq__, so the pair (Tuple, Sub) was compared by Sub's, right to
        # left: (Loose, one) asks Loose, which says equal; left to right, Atom would say no.
        self.assertTrue(tuple_([tuple_([one])]) == tuple_([Sub([Loose([])])]))
        self.assertFalse(tuple_([Sub([one])]) == tuple_([tuple_([Loose([])])]))

        class Seven(Tuple):
            def __hash__(self):
                return 7

        seven = Seven([one])
        self.assertEqual(hash(tuple_([seven, one])), hash(("tuple", (seven, one))))

        # Overriding __eq__ alone makes a class unhashable; its parent stays unhashable.
        class Unhashable(Tuple):
            def __eq__(self, other):
                return False

        with self.assertRaises(TypeError):
            hash(tuple_([Unhashable([])]))


if __name__ == "__main__":
    unittest.main()
