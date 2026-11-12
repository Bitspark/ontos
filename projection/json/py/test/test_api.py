"""ontos_json (py): the API of §10 of both pages, beyond what the vectors pin.

Limits and their validation, the error record, byte and host-string readers, origins lookups,
integer conversion that no interpreter setting can refuse (readable §4.5), and depth reached
without native recursion (total §9.2).

Run: ``python3 projection/json/py/test/test_api.py``
"""

import random
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[4]
for _lane in ("core/py", "codec/py", "data/py", "projection/json/py"):
    sys.path.insert(0, str(_REPO_ROOT / _lane))

from ontos_codec import encode  # noqa: E402
from ontos_core import Atom, Tuple  # noqa: E402
from ontos_data import encode_decimal, encode_int, encode_list, encode_map, encode_text  # noqa: E402

import ontos_json  # noqa: E402
from ontos_json import Limits, ProjectionError, Span, readable, total  # noqa: E402
from ontos_json import readable as readable_module  # noqa: E402


def _refusal(test, fn, *args, **kwargs):
    with test.assertRaises(ProjectionError) as caught:
        fn(*args, **kwargs)
    return caught.exception


class _DigitLimit:
    """Run a block under CPython's lowest int/str digit limit (``PYTHONINTMAXSTRDIGITS=640``)."""

    def __enter__(self):
        self.saved = sys.get_int_max_str_digits()
        sys.set_int_max_str_digits(640)

    def __exit__(self, *exc):
        sys.set_int_max_str_digits(self.saved)


class _RecursionLimit:
    """Run a block with a recursion limit far below any depth the tests reach."""

    def __init__(self, limit):
        self.limit = limit

    def __enter__(self):
        self.saved = sys.getrecursionlimit()
        sys.setrecursionlimit(self.limit)

    def __exit__(self, *exc):
        sys.setrecursionlimit(self.saved)


class LimitsTests(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(
            total.DEFAULT_LIMITS,
            Limits(
                max_text_bytes=None,
                max_json_depth=None,
                max_value_depth=1024,
                max_atom_bytes=None,
                max_tuple_arity=None,
                max_integer_digits=None,
            ),
        )
        self.assertEqual(readable.DEFAULT_LIMITS, total.DEFAULT_LIMITS.replace(max_integer_digits=4300))
        self.assertEqual(total.json_depth_bound(total.DEFAULT_LIMITS), 2050)
        self.assertEqual(readable.json_depth_bound(readable.DEFAULT_LIMITS), 3076)

    def test_derived_and_set_json_depth(self):
        self.assertEqual(total.json_depth_bound(total.DEFAULT_LIMITS.replace(max_value_depth=10)), 22)
        self.assertEqual(readable.json_depth_bound(readable.DEFAULT_LIMITS.replace(max_value_depth=10)), 34)
        self.assertEqual(total.json_depth_bound(total.DEFAULT_LIMITS.replace(max_json_depth=5)), 5)
        self.assertIsNone(readable.json_depth_bound(readable.DEFAULT_LIMITS.replace(max_value_depth=None)))

    def test_every_field_is_required(self):
        with self.assertRaises(TypeError):
            Limits(max_value_depth=3)  # type: ignore[call-arg]

    def test_bounds_are_validated(self):
        for bad, error in ((-1, ValueError), (True, TypeError), (1.0, TypeError), ("1", TypeError)):
            with self.subTest(bad=bad):
                with self.assertRaises(error):
                    total.DEFAULT_LIMITS.replace(max_atom_bytes=bad)
        with self.assertRaises(TypeError):
            total.parse_utf8(b"{}", limits={"max_value_depth": 1})  # type: ignore[arg-type]

    def test_frozen(self):
        with self.assertRaises(Exception):
            total.DEFAULT_LIMITS.max_value_depth = 1  # type: ignore[misc]


class ErrorTests(unittest.TestCase):
    def test_reader_refusal_record(self):
        err = _refusal(self, readable.parse_utf8, b'{"0":[1.5]}')
        self.assertEqual(err.profile, "ontos-readable-json/1")
        self.assertEqual(err.code, "invalid_number")
        self.assertEqual(err.path, ("0", 0))
        self.assertIs(type(err.path[0]), str)
        self.assertIs(type(err.path[1]), int)
        self.assertEqual(err.span, Span(6, 9))
        self.assertIsNone(err.kind)
        self.assertTrue(err.message)

    def test_shared_stages_use_the_profile_that_reads(self):
        for module in (total, readable):
            err = _refusal(self, module.parse_utf8, b"[1,]")
            self.assertEqual((err.profile, err.code, err.path, err.span), (module.PROFILE, "invalid_json", (1,), Span(3, 4)))

    def test_raw_refusals_carry_the_readable_profile(self):
        err = _refusal(self, readable.parse_utf8, b'{"$ontos":["raw",{"atom":"0"}]}')
        self.assertEqual((err.profile, err.code, err.path), (readable.PROFILE, "invalid_hex", ("$ontos", 1, "atom")))

    def test_writer_refusal_has_no_span_and_an_informative_path(self):
        value = encode_list([encode_list([encode_list([])])])
        err = _refusal(self, readable.render_utf8, value, limits=readable.DEFAULT_LIMITS.replace(max_value_depth=1))
        self.assertEqual((err.code, err.kind, err.span), ("limit_exceeded", "decode_depth", None))
        self.assertEqual(err.path, (0,))
        err = _refusal(self, total.render_utf8, Tuple([Tuple([Atom(b"ab")])]), limits=total.DEFAULT_LIMITS.replace(max_atom_bytes=1))
        self.assertEqual((err.kind, err.path), ("atom_bytes", ("tuple", 0, "tuple", 0)))

    def test_package_exports(self):
        self.assertIs(ontos_json.Limits, Limits)
        self.assertIs(total.ProjectionError, readable.ProjectionError)
        self.assertIs(total.Limits, readable.Limits)


class ReaderInputTests(unittest.TestCase):
    def test_bytes_like_inputs(self):
        for data in (b'{"atom":"00"}', bytearray(b'{"atom":"00"}'), memoryview(b'{"atom":"00"}')):
            self.assertEqual(total.parse_utf8(data), Atom(b"\x00"))

    def test_str_is_a_caller_error_for_the_byte_reader(self):
        with self.assertRaises(TypeError):
            total.parse_utf8('{"atom":"00"}')  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            readable.parse_str(b"1")  # type: ignore[arg-type]

    def test_host_string_reads_its_utf8(self):
        self.assertEqual(readable.parse_str('"\u00e9"'), encode_text("\u00e9"))
        self.assertEqual(total.parse_str(' {"atom":"ff"} '), Atom(b"\xff"))

    def test_host_string_lone_surrogate(self):
        # The one-byte span at the UTF-8 length of the characters before it: '["' and U+00E9 are 4 bytes.
        for module in (total, readable):
            for surrogate in ("\ud800", "\udfff"):
                err = _refusal(self, module.parse_str, '["\u00e9' + surrogate + '"]')
                self.assertEqual((err.code, err.path, err.span), ("invalid_utf8", (), Span(4, 5)))
            # A Python str holds a surrogate pair as two code points: the first is refused.
            err = _refusal(self, module.parse_str, '"\ud83d\ude00"')
            self.assertEqual((err.code, err.span), ("invalid_utf8", Span(1, 2)))

    def test_host_string_size_is_its_utf8_size(self):
        limits = readable.DEFAULT_LIMITS.replace(max_text_bytes=3)
        err = _refusal(self, readable.parse_str, '"\u00e9"', limits=limits)
        self.assertEqual((err.code, err.kind, err.span), ("limit_exceeded", "text_bytes", Span(3, 4)))

    def test_byte_order_mark_in_a_host_string(self):
        err = _refusal(self, total.parse_str, '\ufeff{"atom":""}')
        self.assertEqual((err.code, err.span), ("byte_order_mark", Span(0, 3)))


class OriginsTests(unittest.TestCase):
    def test_lookup_and_enumeration(self):
        parsed = readable.parse_utf8_with_origins(b'{"aa":2,"b":[true]}')
        self.assertIsInstance(parsed, readable.Parsed)
        origins = parsed.origins
        self.assertEqual(len(origins), len(list(origins.items())))
        self.assertEqual(origins[()], readable.Origin((), Span(0, 19)))
        # "b" sorts first: entry 1 is the member b, and its value [true] is child 1 of the entry.
        self.assertEqual(origins[(1,)], readable.Origin(("b",), Span(8, 18)))
        self.assertEqual(origins[[1, 0, 1]], readable.Origin(("b",), Span(8, 11)))
        self.assertEqual(origins[(1, 1, 1)], readable.Origin(("b", 0), Span(13, 17)))
        self.assertEqual(origins[(2, 1, 1)], readable.Origin(("aa",), Span(6, 7)))
        self.assertIn((1, 1, 1, 0), origins)
        self.assertNotIn((3,), origins)
        self.assertNotIn((0, 0), origins)  # an atom has no children
        with self.assertRaises(KeyError):
            origins[(9,)]
        paths = list(origins)
        self.assertEqual(paths[:4], [(), (0,), (1,), (1, 0)])
        self.assertEqual(len(paths), len(set(paths)))

    def test_raw_contributes_nothing_itself(self):
        parsed = readable.parse_utf8_with_origins(b'{"$ontos":["raw",{"tuple":[{"atom":"00"}]}]}')
        self.assertEqual(encode(parsed.value), encode(Tuple([Atom(b"\x00")])))
        self.assertEqual(
            [(p, o.path, o.span) for p, o in parsed.origins.items()],
            [((), ("$ontos", 1), Span(17, 42)), ((0,), ("$ontos", 1, "tuple", 0), Span(27, 40))],
        )

    def test_origins_are_not_part_of_the_value(self):
        a = readable.parse_utf8_with_origins(b'{"a":1}')
        b = readable.parse_utf8_with_origins(b' { "a" : 1 } ')
        self.assertEqual(encode(a.value), encode(b.value))
        self.assertNotEqual(list(a.origins.items()), list(b.origins.items()))


class IntegerTests(unittest.TestCase):
    """Readable §4.5: conversion depends on the text alone, never on an interpreter setting."""

    def test_conversions_against_python(self):
        rng = random.Random(4300)
        saved = sys.get_int_max_str_digits()
        sys.set_int_max_str_digits(0)
        try:
            lengths = [1, 2, 511, 512, 513, 1023, 1024, 1025, 1536, 4300, 4301, 9000, 20000]
            for length in lengths:
                text = str(rng.randint(1, 9)) + "".join(rng.choice("0123456789") for _ in range(length - 1))
                n = int(text)
                with _DigitLimit():
                    self.assertEqual(readable_module._digits_to_int(text), n)
                    self.assertEqual(readable_module._int_to_digits(n), text)
                    self.assertEqual(readable_module._digit_count(n), length)
            for exponent in range(0, 5000, 7):
                for n in (10**exponent - 1, 10**exponent, 10**exponent + 1):
                    if n >= 0:
                        self.assertEqual(readable_module._digit_count(n), len(str(n)))
        finally:
            sys.set_int_max_str_digits(saved)

    def test_reading_and_writing_at_the_default_bound_under_the_lowest_setting(self):
        digits = "9" * 4300
        with _DigitLimit():
            for text in (digits, "-" + digits):
                data = ('{"$ontos":["int","%s"]}' % text).encode("ascii")
                value = readable.parse_utf8(data)
                self.assertEqual(readable.render_utf8(value), data)
            decimal = ('{"$ontos":["decimal","-%s","%s"]}' % (digits, digits)).encode("ascii")
            self.assertEqual(readable.render_utf8(readable.parse_utf8(decimal)), decimal)
            # One digit more refuses, in both directions, before any conversion.
            err = _refusal(self, readable.parse_utf8, ('{"$ontos":["int","%s"]}' % ("1" + digits)).encode("ascii"))
            self.assertEqual((err.code, err.kind), ("limit_exceeded", "integer_digits"))

    def test_raised_bound_reads_and_writes_large_integers(self):
        saved = sys.get_int_max_str_digits()
        sys.set_int_max_str_digits(0)
        try:
            n = 7**60000  # 50,704 digits
            reference = str(n)
        finally:
            sys.set_int_max_str_digits(saved)
        limits = readable.DEFAULT_LIMITS.replace(max_integer_digits=None)
        with _DigitLimit():
            value = encode_int(-n)
            data = readable.render_utf8(value, limits=limits)
            self.assertEqual(data, ('{"$ontos":["int","-%s"]}' % reference).encode("ascii"))
            self.assertEqual(encode(readable.parse_utf8(data, limits=limits)), encode(value))
            err = _refusal(self, readable.render_utf8, value)
            self.assertEqual((err.code, err.kind), ("limit_exceeded", "integer_digits"))

    def test_only_canonical_ascii_integer_text(self):
        for text in ("1_000", " 1", "1 ", "+1", "01", "-0", "", "1\u0662", "\u0661", "1\n", "\uff11", "1.0"):
            with self.subTest(text=text):
                data = ('{"$ontos":["int",%s]}' % _json_quote(text)).encode("utf-8")
                err = _refusal(self, readable.parse_utf8, data)
                self.assertEqual((err.code, err.path), ("invalid_integer", ("$ontos", 1)))
        err = _refusal(self, readable.parse_utf8, "[1\u0662]".encode("utf-8"))
        self.assertEqual((err.code, err.span), ("invalid_json", Span(2, 4)))

    def test_window(self):
        self.assertEqual(readable.render_utf8(encode_int(2**53 - 1)), b"9007199254740991")
        self.assertEqual(readable.render_utf8(encode_int(-(2**53 - 1))), b"-9007199254740991")
        self.assertEqual(readable.render_utf8(encode_int(2**53)), b'{"$ontos":["int","9007199254740992"]}')
        self.assertEqual(readable.render_utf8(encode_decimal(-5, -1000)), b'{"$ontos":["decimal","-5","-1000"]}')


def _json_quote(text):
    out = ['"']
    for ch in text:
        if ch in '"\\' or ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


class DepthTests(unittest.TestCase):
    """Total §9.2: depth is bounded by the limits alone, never by Python's recursion limit."""

    def test_default_depths_without_recursion(self):
        with _RecursionLimit(120):
            deep = b'{"tuple":[' * 1024 + b'{"tuple":[]}' + b"]}" * 1024
            value = total.parse_utf8(deep)
            self.assertEqual(total.render_utf8(value), deep)
            self.assertEqual(readable.render_utf8(value), b'{"$ontos":["raw",' + deep + b"]}")
            lists = b"[" * 1024 + b"]" * 1024
            self.assertEqual(readable.render_utf8(readable.parse_utf8(lists)), lists)
            err = _refusal(self, total.parse_utf8, b"[" * 100000)
            self.assertEqual((err.code, err.kind, err.span), ("limit_exceeded", "json_depth", Span(2050, 2051)))

    def test_unbounded_depth_without_recursion(self):
        limits = readable.DEFAULT_LIMITS.replace(max_value_depth=None)
        with _RecursionLimit(120):
            lists = b"[" * 50000 + b"]" * 50000
            parsed = readable.parse_utf8_with_origins(lists, limits=limits)
            self.assertEqual(readable.render_utf8(parsed.value, limits=limits), lists)
            self.assertEqual(len(parsed.origins), 100000)
            self.assertEqual(parsed.origins[(1,) * 49999 + (0,)].path, (0,) * 49999)
            # Each set checks its elements by their encodings, so a chain costs its length times
            # its depth: 1500 levels, past the default bound, keep this test quick.
            chain = b'{"$ontos":["set",[' * 1500 + b'{"$ontos":["set",[]]}' + b"]]}" * 1500
            value = readable.parse_utf8(chain, limits=limits)
            self.assertEqual(readable.render_utf8(value, limits=limits), chain)
            # The total form of the same value, read back, has the same encoding.
            spelled = total.render_utf8(value, limits=total.DEFAULT_LIMITS.replace(max_value_depth=None))
            self.assertEqual(encode(total.parse_utf8(spelled, limits=total.DEFAULT_LIMITS.replace(max_value_depth=None))), encode(value))


class WriterTests(unittest.TestCase):
    def test_string_escaping(self):
        text = "".join(chr(c) for c in range(0x20)) + '"\\/\x7f\u2028\u2029\u00e9\U0001f600'
        expected = (
            '"\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000b\\f\\r\\u000e\\u000f'
            "\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c"
            '\\u001d\\u001e\\u001f\\"\\\\/\x7f\u2028\u2029\u00e9\U0001f600"'
        ).encode("utf-8")
        self.assertEqual(readable.render_utf8(encode_text(text)), expected)
        self.assertEqual(readable.parse_utf8(expected), encode_text(text))

    def test_object_keys_in_codec_order(self):
        value = encode_map([(encode_text("a" * 129), encode_int(1)), (encode_text("b" * 256), encode_int(2)), (encode_text("Z"), encode_int(3))])
        out = readable.render_utf8(value)
        self.assertTrue(out.startswith(b'{"Z":3,"' + b"b" * 256 + b'":2,"' + b"a" * 129))

    def test_object_key_encoding_is_the_codec_encoding(self):
        for name in (b"", b"a", b"\xc3\xa9", b"k" * 127, b"k" * 128, b"k" * 300, b"k" * 20000):
            self.assertEqual(readable_module._text_encoding(name), encode(encode_text(name.decode("utf-8"))))

    def test_not_a_value(self):
        for module in (total, readable):
            with self.assertRaises(TypeError):
                module.render_utf8("x")  # type: ignore[arg-type]

    def test_output_reads_back_under_the_same_limits(self):
        limits = readable.DEFAULT_LIMITS.replace(max_value_depth=4, max_atom_bytes=9, max_text_bytes=200)
        value = encode_map([(encode_int(1), encode_list([encode_text("x")])), (encode_text("k"), Tuple([Atom(b"\xff"), Atom(b"")]))])
        out = readable.render_utf8(value, limits=limits)
        self.assertEqual(encode(readable.parse_utf8(out, limits=limits)), encode(value))


if __name__ == "__main__":
    unittest.main()
