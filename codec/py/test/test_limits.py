"""ontos/codec (py) — operational limit reporting (ontos-codec.md §4.2, ontos-internal#352).

Every decoder-produced ``limit_exceeded`` names the bound that stopped it in
``limit_kind``. Replays vectors/codec-limits.json, and pins that Python, having no
native width ceiling, never reports ``native_width``.

``LimitPolicyTests`` replay the generated corpus vectors/codec-limits.generated.json
(Bitspark/ontos#13, docs/design/0009): its agreement-zone differential cases, and its
values for the metamorphic relation. ``ONTOS_LIMIT_POLICY_CORPUS`` names another corpus
from tools/limit-policy/gen.mjs instead, which is how ``scripts/check.sh fuzz`` replays a
fresh seed.

Run: ``python3 codec/py/test/test_limits.py`` (``-k LimitPolicy`` for those two alone)
"""

import json
import os
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
    encode,
    encode_uvarint,
)
from ontos_core import Atom  # noqa: E402

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


def _limits_of(case):
    """A case's limits as decode()'s keyword arguments; an unknown key fails."""
    return {_LIMIT_ARGS[key]: bound for key, bound in case["limits"].items()}


def _judge(test, name, data, limits, expect):
    """Decodes ``data`` under ``limits`` and requires ``expect``.

    ``expect`` is "accept", which needs a value that re-encodes to the same bytes, or
    ``{"code", "limitKind"}``, which needs a DecodeError with exactly that code and kind.
    Anything else (another exception, a missing kind, a different datum) fails. Returns
    the outcome's label, "accept" or the kind.
    """
    if expect == "accept":
        try:
            value = decode(data, **limits)
        except DecodeError as err:
            test.fail(f"{name}: expected accept, got {err.code} ({err.limit_kind}): {err}")
        test.assertEqual(encode(value), data, f"{name}: accepted a different datum")
        return "accept"
    try:
        decode(data, **limits)
    except DecodeError as err:
        test.assertEqual((err.code, err.limit_kind), (expect["code"], expect["limitKind"]), name)
        return expect["limitKind"]
    test.fail(f"{name}: expected {expect['limitKind']}, got accept")


class CodecLimitVectorTests(unittest.TestCase):
    def test_every_case_accepts_or_names_its_bound(self):
        cases = _read_vectors("codec-limits.json")["cases"]
        self.assertTrue(cases)
        for case in cases:
            with self.subTest(case=case["name"]):
                _judge(self, case["name"], bytes.fromhex(case["hex"]), _limits_of(case), case["expect"])

    def test_byte_contract_rejects_carry_no_limit_kind(self):
        for case in _read_vectors("codec.json")["reject"]:
            with self.subTest(case=case["name"]):
                self.assertIsNone(_decode_error(bytes.fromhex(case["hex"])).limit_kind)


# ----- the generated limit-policy tests (Bitspark/ontos#13) -----

# The zone's three bounds: (decode() keyword, the need it is set against, its kind).
_POLICY_BOUNDS = (
    ("max_depth", "depth", LIMIT_DECODE_DEPTH),
    ("max_atom_bytes", "atom", LIMIT_ATOM_BYTES),
    ("max_tuple_arity", "arity", LIMIT_TUPLE_ARITY),
)


def _read_policy_corpus():
    path = os.environ.get("ONTOS_LIMIT_POLICY_CORPUS") or str(_VECTORS / "codec-limits.generated.json")
    return path, json.loads(Path(path).read_text(encoding="utf-8"))


def _needs_of(value):
    """What a decoded value needs from each bound, walked with an explicit stack."""
    needs = {"depth": 0, "atom": 0, "arity": 0}
    stack = [(value, 0)]
    while stack:
        v, depth = stack.pop()
        needs["depth"] = max(needs["depth"], depth)
        if isinstance(v, Atom):
            needs["atom"] = max(needs["atom"], len(v))
        else:
            items = v.items()
            needs["arity"] = max(needs["arity"], len(items))
            stack.extend((item, depth + 1) for item in items)
    return needs


def _tally():
    """Every outcome at zero, so an outcome never seen still shows."""
    return {"accept": 0, LIMIT_DECODE_DEPTH: 0, LIMIT_ATOM_BYTES: 0, LIMIT_TUPLE_ARITY: 0}


def _show(seen):
    return ", ".join(f"{k} {n}" for k, n in seen.items())


class LimitPolicyTests(unittest.TestCase):
    def test_differential_every_zone_case_produces_its_one_expectation(self):
        path, doc = _read_policy_corpus()
        cases = doc["differential"]
        self.assertEqual(len(cases), doc["counts"]["differential"], "the corpus's differential count")
        seen = _tally()
        for case in cases:
            seen[_judge(self, case["name"], bytes.fromhex(case["hex"]), _limits_of(case), case["expect"])] += 1
        for outcome, n in seen.items():
            self.assertGreater(n, 0, f"no differential case expects {outcome}")
        print(f"py differential: {len(cases)} cases judged ({_show(seen)}); {path} seed {doc['seed']}")

    def test_metamorphic_one_bound_below_an_accepted_values_need_names_that_bound(self):
        path, doc = _read_policy_corpus()
        values = doc["metamorphic"]
        self.assertEqual(len(values), doc["counts"]["metamorphic"], "the corpus's metamorphic count")
        seen = _tally()
        for entry in values:
            name, data = entry["name"], bytes.fromhex(entry["hex"])
            # The precondition, observed here rather than assumed: the defaults accept it.
            seen[_judge(self, f"{name} under the defaults", data, {}, "accept")] += 1
            needs = _needs_of(decode(data))
            tight = {arg: needs[need] for arg, need, _ in _POLICY_BOUNDS}
            seen[_judge(self, f"{name} at its needs", data, tight, "accept")] += 1
            for arg, need_key, kind in _POLICY_BOUNDS:
                need = needs[need_key]
                if need == 0:
                    continue  # nothing to lower below
                for lowered in sorted({need - 1, 0}, reverse=True):
                    for label, base in (("defaults", {}), ("needs", tight)):
                        limits = {**base, arg: lowered}
                        expect = {"code": "limit_exceeded", "limitKind": kind}
                        case = f"{name}: {arg}={lowered} < {need}, others at {label}"
                        seen[_judge(self, case, data, limits, expect)] += 1
        for outcome, n in seen.items():
            self.assertGreater(n, 0, f"the metamorphic relation never produced {outcome}")
        print(
            f"py metamorphic: {len(values)} values, {sum(seen.values())} decodes judged ({_show(seen)}); "
            f"{path} seed {doc['seed']}"
        )


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
