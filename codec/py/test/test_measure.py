"""ontos/codec (py) — ``measure`` (ontos-codec.md §10, design record 0008).

Replays vectors/codec-measure.json with real sharing, and checks what the vectors cannot
state: bounds past 2^53 - 1 (Python takes any non-negative int), a doubling chain far past
k = 64, and a value deeper than the recursion limit.

Run: ``python3 codec/py/test/test_measure.py``
"""

import json
import sys
import threading
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
for _lane in ("core", "codec"):
    sys.path.insert(0, str(_REPO_ROOT / _lane / "py"))

import ontos_codec  # noqa: E402
from ontos_codec import (  # noqa: E402
    MEASURE_ENCODED_BYTES,
    MEASURE_HEIGHT,
    MEASURE_OCCURRENCES,
    MeasureError,
    Measures,
    encode,
    measure,
)
from ontos_core import atom, tuple_  # noqa: E402

_VECTORS = _REPO_ROOT / "vectors"
_MAX = 2**53 - 1
_UNBOUNDED = {"max_encoded_bytes": _MAX, "max_occurrences": _MAX, "max_height": _MAX}


def _build(table):
    """One object per table entry, so an index named twice is one shared node."""
    built = []
    for i, node in enumerate(table["nodes"]):
        if "atom" in node:
            built.append(atom(bytes.fromhex(node["atom"])))
        else:
            for ref in node["tuple"]:
                assert 0 <= ref < i, f"node {i} names {ref}, which is not an earlier node"
            built.append(tuple_([built[ref] for ref in node["tuple"]]))
    return built[table["root"]]


def _doubling_chain(k):
    """x0 = Atom(00), xk = Tuple(x(k-1), x(k-1)), as k + 1 objects."""
    v = atom(b"\x00")
    for _ in range(k):
        v = tuple_([v, v])
    return v


def _measure_within(value, seconds=30, **bounds):
    """Measure in a daemon thread, so a memo that stopped sharing fails the test instead of
    hanging it: an expanded walk of these chains would not finish."""
    box = {}

    def run():
        try:
            box["result"] = measure(value, **bounds)
        except BaseException as err:  # handed back to the test below
            box["error"] = err

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(seconds)
    if worker.is_alive():
        raise AssertionError("measure did not finish: it is expanding shared subtrees")
    if "error" in box:
        raise box["error"]
    return box["result"]


class MeasureVectorTests(unittest.TestCase):
    def test_every_case_gives_its_measures_or_names_what_it_exceeds(self):
        doc = json.loads((_VECTORS / "codec-measure.json").read_text(encoding="utf-8"))
        self.assertTrue(doc["cases"])
        self.assertEqual(len(doc["cases"]), doc["count"])
        for case in doc["cases"]:
            with self.subTest(case=case["name"]):
                value = _build(case["value"])
                bounds = case["bounds"]
                kwargs = {
                    "max_encoded_bytes": bounds["encoded_bytes"],
                    "max_occurrences": bounds["occurrences"],
                    "max_height": bounds["height"],
                }
                expect = case["expect"]
                if "measures" in expect:
                    want = expect["measures"]
                    self.assertEqual(
                        _measure_within(value, **kwargs),
                        Measures(want["encoded_bytes"], want["occurrences"], want["height"]),
                    )
                else:
                    self.assertTrue(expect["exceeded"])
                    with self.assertRaises(MeasureError) as caught:
                        _measure_within(value, **kwargs)
                    self.assertEqual(list(caught.exception.exceeded), expect["exceeded"])


class MeasureTests(unittest.TestCase):
    # Expected numbers are the closed forms of record 0008: 5·2^k − 2 bytes, 2^(k+1) − 1
    # occurrences, height k.
    def test_doubling_chain_at_k_64_is_exact_under_bounds_past_2_64(self):
        big = 2**70
        got = _measure_within(_doubling_chain(64), max_encoded_bytes=big, max_occurrences=big, max_height=big)
        self.assertEqual(got, Measures(5 * 2**64 - 2, 2**65 - 1, 64))

    def test_doubling_chain_at_the_u64_ceiling(self):
        u64 = 2**64 - 1
        with self.assertRaises(MeasureError) as caught:
            _measure_within(_doubling_chain(64), max_encoded_bytes=u64, max_occurrences=u64, max_height=64)
        self.assertEqual(caught.exception.exceeded, (MEASURE_ENCODED_BYTES, MEASURE_OCCURRENCES))
        # k = 63: 2^64 - 1 occurrences sits exactly at the bound, so only the bytes are over.
        with self.assertRaises(MeasureError) as caught:
            _measure_within(_doubling_chain(63), max_encoded_bytes=u64, max_occurrences=u64, max_height=63)
        self.assertEqual(caught.exception.exceeded, (MEASURE_ENCODED_BYTES,))

    def test_doubling_chain_far_past_64(self):
        k = 100_000
        far = _doubling_chain(k)
        with self.assertRaises(MeasureError) as caught:
            _measure_within(far, max_encoded_bytes=_MAX, max_occurrences=_MAX, max_height=k)
        self.assertEqual(caught.exception.exceeded, (MEASURE_ENCODED_BYTES, MEASURE_OCCURRENCES))
        with self.assertRaises(MeasureError) as caught:
            _measure_within(far, max_encoded_bytes=_MAX, max_occurrences=_MAX, max_height=k - 1)
        self.assertEqual(caught.exception.exceeded, (MEASURE_ENCODED_BYTES, MEASURE_HEIGHT, MEASURE_OCCURRENCES))

    def test_a_value_far_deeper_than_the_recursion_limit(self):
        # Each level is a tag and an arity of 1 (2 bytes), around Atom(61) (3 bytes).
        deep = 300_000
        self.assertGreater(deep, sys.getrecursionlimit())
        v = atom(b"a")
        for _ in range(deep):
            v = tuple_([v])
        self.assertEqual(measure(v, **_UNBOUNDED), Measures(2 * deep + 3, deep + 1, deep))
        with self.assertRaises(MeasureError) as caught:
            measure(v, max_encoded_bytes=_MAX, max_occurrences=_MAX, max_height=1024)
        self.assertEqual(caught.exception.exceeded, (MEASURE_HEIGHT,))

    def test_structurally_equal_tuples_built_apart(self):
        a = atom(b"abc")
        v = tuple_([tuple_([a]), tuple_([a]), tuple_([])])
        got = measure(v, **_UNBOUNDED)
        self.assertEqual(got, Measures(2 + 7 + 7 + 2, 1 + 2 + 2 + 1, 2))
        self.assertEqual(got.encoded_bytes, len(encode(v)))

    def test_every_bound_is_a_required_keyword_only_non_negative_int(self):
        v = tuple_([])
        for name in _UNBOUNDED:
            for bad, error in ((-1, ValueError), (1.0, TypeError), (True, TypeError), (None, TypeError)):
                with self.subTest(name=name, bad=bad), self.assertRaises(error):
                    measure(v, **{**_UNBOUNDED, name: bad})
            missing = {key: bound for key, bound in _UNBOUNDED.items() if key != name}
            with self.subTest(missing=name), self.assertRaises(TypeError):
                measure(v, **missing)
        with self.assertRaises(TypeError):
            measure(v, _MAX, _MAX, _MAX)  # type: ignore[misc]
        self.assertEqual(measure(v, max_encoded_bytes=2, max_occurrences=1, max_height=0), Measures(2, 1, 0))

    def test_measure_error_names_the_exceeded_measures(self):
        with self.assertRaises(MeasureError) as caught:
            measure(atom(b""), max_encoded_bytes=0, max_occurrences=0, max_height=0)
        self.assertEqual(caught.exception.exceeded, (MEASURE_ENCODED_BYTES, MEASURE_OCCURRENCES))
        self.assertEqual(str(caught.exception), "over limit: encoded_bytes, occurrences")

    def test_the_names_are_exported(self):
        names = ("measure", "Measures", "MeasureError", "MEASURE_ENCODED_BYTES", "MEASURE_HEIGHT", "MEASURE_OCCURRENCES")
        for name in names:
            self.assertIn(name, ontos_codec.__all__)


if __name__ == "__main__":
    unittest.main()
