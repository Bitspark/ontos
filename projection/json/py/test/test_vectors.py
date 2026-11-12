"""ontos_json (py) conformance: replays every case of projection/json/vectors/{total,readable}.json.

For each case, under the case's limits (the profile's defaults overridden by ``limits``), as
projection/json/vectors/README.md, "How a face replays a case", says:

1. a refused input refuses with exactly that code, path, span and kind;
2. an accepted input reads to a value whose ontos-codec-v1 encoding is ``value_hex``, and the
   origins reader gives exactly the case's ``origins``;
3. the value of ``value_hex`` writes exactly ``output``, or refuses with ``render_refusal``;
4. the laws: ``output`` reads back to ``value_hex``, and that value writes ``output`` again.

Every case must exercise at least one of these, and the per-file counts are printed.

``ONTOS_JSON_PROJECTION_VECTORS`` names another directory of ``total.json`` and ``readable.json``
in the same format, which is how ``scripts/check.sh fuzz`` replays a fresh generated corpus
(tools/json-projection/README.md).

Run: ``python3 projection/json/py/test/test_vectors.py``
"""

import json
import os
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[4]
for _lane in ("core/py", "codec/py", "data/py", "projection/json/py"):
    sys.path.insert(0, str(_REPO_ROOT / _lane))

from ontos_codec import decode, encode  # noqa: E402
from ontos_json import ProjectionError, readable, total  # noqa: E402

_VECTORS = Path(
    os.environ.get("ONTOS_JSON_PROJECTION_VECTORS") or _REPO_ROOT / "projection" / "json" / "vectors"
)

# The README's limit names, which are exactly the Limits fields.
_LIMIT_NAMES = {
    "max_text_bytes",
    "max_json_depth",
    "max_value_depth",
    "max_atom_bytes",
    "max_tuple_arity",
    "max_integer_digits",
}

# Field names of a case (README, "What a case pins"); a new field fails the run until this
# replay knows what it pins.
_CASE_FIELDS = {
    "name",
    "group",
    "note",
    "provenance",
    "input",
    "input_hex",
    "input_parts",
    "limits",
    "value",
    "value_hex",
    "output",
    "refusal",
    "render_refusal",
    "origins",
}


def _expand(field):
    """A field written as runs (README, "Runs") expanded; any other field as it is."""
    if isinstance(field, dict) and set(field) == {"runs"}:
        pieces = field["runs"]
        if all(isinstance(piece, str) for piece, _count in pieces):
            return "".join(piece * count for piece, count in pieces)
        out = []
        for piece, count in pieces:
            for _ in range(count):
                out.extend(piece)
        return out
    return field


def _load(name):
    return json.loads((_VECTORS / name).read_text(encoding="utf-8"))


def _limits(module, case):
    overrides = case.get("limits", {})
    unknown = set(overrides) - _LIMIT_NAMES
    if unknown:
        raise AssertionError(f"{case['name']}: unknown limit names {sorted(unknown)}")
    return module.DEFAULT_LIMITS.replace(**overrides)


def _origins_list(origins):
    return [[list(vpath), list(origin.path), [origin.span.start, origin.span.end]] for vpath, origin in origins.items()]


class _Replay:
    """Replays one vector file against one profile module."""

    module = None
    file = None
    counts = {}

    def _replay(self, case):
        module = self.module
        unknown = set(case) - _CASE_FIELDS
        self.assertFalse(unknown, f"unknown case fields {sorted(unknown)}")
        limits = _limits(module, case)
        checks = 0

        input_hex = _expand(case.get("input_hex"))
        if "input" in case and input_hex is not None:
            # The informative input agrees with the normative bytes.
            self.assertEqual(_expand(case["input"]).encode("utf-8").hex(), input_hex)

        if "refusal" in case:
            want = case["refusal"]
            data = bytes.fromhex(input_hex)
            with self.assertRaises(ProjectionError) as caught:
                module.parse_utf8(data, limits=limits)
            err = caught.exception
            got = {
                "code": err.code,
                "path": list(err.path),
                "span": [err.span.start, err.span.end],
            }
            expected = {"code": want["code"], "path": _expand(want["path"]), "span": want["span"]}
            if "kind" in want or err.kind is not None:
                got["kind"] = err.kind
                expected["kind"] = want.get("kind")
            self.assertEqual(got, expected)
            self.assertEqual(err.profile, module.PROFILE)
            # Typed paths: indexes are ints and member names strs, never one for the other.
            for got_seg, want_seg in zip(err.path, _expand(want["path"])):
                self.assertIs(type(got_seg), type(want_seg))
            if "input" in case:
                with self.assertRaises(ProjectionError) as caught_str:
                    module.parse_str(_expand(case["input"]), limits=limits)
                self.assertEqual(
                    (caught_str.exception.code, caught_str.exception.path, caught_str.exception.span),
                    (err.code, err.path, err.span),
                )
            checks += 1

        value_hex = _expand(case.get("value_hex"))
        if input_hex is not None and value_hex is not None and "refusal" not in case:
            data = bytes.fromhex(input_hex)
            value = module.parse_utf8(data, limits=limits)
            self.assertEqual(encode(value).hex(), value_hex)
            if "input" in case:
                self.assertEqual(encode(module.parse_str(_expand(case["input"]), limits=limits)).hex(), value_hex)
            checks += 1
            if module is readable:
                parsed = readable.parse_utf8_with_origins(data, limits=limits)
                self.assertEqual(encode(parsed.value).hex(), value_hex)
                listed = _origins_list(parsed.origins)
                self.assertEqual(len(listed), len(parsed.origins))
                for vpath, jpath, span in listed:
                    origin = parsed.origins[vpath]
                    self.assertEqual([list(origin.path), [origin.span.start, origin.span.end]], [jpath, span])
                if "origins" in case:
                    self.assertEqual(listed, case["origins"])
                    checks += 1

        if "output" in case:
            output = _expand(case["output"]).encode("utf-8")
            value = decode(bytes.fromhex(value_hex), max_depth=1 << 30)
            self.assertEqual(module.render_utf8(value, limits=limits), output)
            # The laws: the output reads back to the value, which writes the output again.
            again = module.parse_utf8(output, limits=limits)
            self.assertEqual(encode(again).hex(), value_hex)
            self.assertEqual(module.render_utf8(again, limits=limits), output)
            checks += 1

        if "render_refusal" in case:
            want = case["render_refusal"]
            value = decode(bytes.fromhex(value_hex), max_depth=1 << 30)
            with self.assertRaises(ProjectionError) as caught:
                module.render_utf8(value, limits=limits)
            err = caught.exception
            self.assertEqual((err.code, err.kind, err.span), (want["code"], want.get("kind"), None))
            self.assertEqual(err.profile, module.PROFILE)
            checks += 1

        self.assertGreater(checks, 0, "the case pins nothing this replay checks")

    def test_every_case(self):
        doc = _load(self.file)
        self.assertEqual(doc["profile"], self.module.PROFILE)
        self.assertEqual(doc["codec"], "ontos-codec-v1")
        cases = doc["cases"]
        self.assertEqual(len({case["name"] for case in cases}), len(cases), "case names are unique")
        passed = 0
        failed = []
        for case in cases:
            with self.subTest(case=case["name"]):
                try:
                    self._replay(case)
                except Exception:
                    failed.append(case["name"])
                    raise
                passed += 1
        print(f"\n{_VECTORS / self.file}: {passed}/{len(cases)} cases passed", file=sys.stderr)
        self.assertEqual(failed, [])
        self.assertEqual(passed, len(cases))


class TotalVectors(_Replay, unittest.TestCase):
    module = total
    file = "total.json"


class ReadableVectors(_Replay, unittest.TestCase):
    module = readable
    file = "readable.json"


if __name__ == "__main__":
    unittest.main()
