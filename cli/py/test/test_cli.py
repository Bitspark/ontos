"""ontos CLI (py) tests — the out-of-process contract, in this lane's own suite.

Drives ``cli/py/main.py`` as a real subprocess (the same surface the
differential conformance harness exercises) and asserts the JSON Lines shapes,
the pinned human renderings, the exit codes, the --from-json author->bytes
round-trip over every vector encode case, the reject grammar (invalid_json),
and the --from-json/<hex> mutual exclusion (usage_error). Also pins the CLI's
KINDS copy against ontos_data.LABELS (the deliberate-copy parity check, ontos-internal#49).

Run: ``python3 cli/py/test/test_cli.py``
"""

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_MAIN = _REPO_ROOT / "cli" / "py" / "main.py"
_VECTORS = _REPO_ROOT / "vectors"

for _lane in ("core", "codec", "data"):
    sys.path.insert(0, str(_REPO_ROOT / _lane / "py"))


def _run(args, stdin=None):
    """Run the py CLI; returns (exit_code, stdout_bytes, stderr_text)."""
    proc = subprocess.run(
        [sys.executable, str(_MAIN), *args],
        input=stdin.encode("utf-8") if stdin is not None else None,
        capture_output=True,
    )
    return proc.returncode, proc.stdout, proc.stderr.decode("utf-8", "replace")


def _read_vectors(name):
    return json.loads((_VECTORS / name).read_text(encoding="utf-8"))


# A canonical int(1) hex from the vectors — handy across tests.
_INT1_HEX = "01020003696e7400020001"


class JsonOutputTests(unittest.TestCase):
    def test_decode_json_shape(self):
        code, out, _ = _run(["decode", "--format", "json", _INT1_HEX])
        self.assertEqual(code, 0)
        self.assertEqual(
            out,
            b'{"ok":true,"command":"decode","codec":"ontos-codec-v1",'
            b'"value":{"tuple":[{"atom":"696e74"},{"atom":"0001"}]}}\n',
        )

    def test_inspect_json_shape(self):
        code, out, _ = _run(["inspect", "--format", "json", _INT1_HEX])
        self.assertEqual(code, 0)
        self.assertEqual(
            out,
            b'{"ok":true,"command":"inspect","codec":"ontos-codec-v1","canonical":true,'
            b'"value":{"tuple":[{"atom":"696e74"},{"atom":"0001"}]},"recognized":["int"]}\n',
        )

    def test_read_all_json_shape(self):
        code, out, _ = _run(["read", "--all", "--format", "json", _INT1_HEX])
        self.assertEqual(code, 0)
        self.assertEqual(out, b'{"ok":true,"command":"read","recognized":["int"]}\n')

    def test_read_kind_json_hit_and_miss(self):
        code, out, _ = _run(["read", "--kind", "int", "--format", "json", _INT1_HEX])
        self.assertEqual(code, 0)
        self.assertEqual(out, b'{"ok":true,"command":"read","kind":"int","recognized":true}\n')
        # A miss is a positive-shaped result with recognized:false and exit 1.
        code, out, _ = _run(["read", "--kind", "bool", "--format", "json", _INT1_HEX])
        self.assertEqual(code, 1)
        self.assertEqual(out, b'{"ok":true,"command":"read","kind":"bool","recognized":false}\n')

    def test_canon_check_and_emit_json(self):
        code, out, _ = _run(["canon", "--check", "--format", "json", _INT1_HEX])
        self.assertEqual(code, 0)
        self.assertEqual(out, b'{"ok":true,"command":"canon","canonical":true}\n')
        code, out, _ = _run(["canon", "--emit", "--format", "json", _INT1_HEX])
        self.assertEqual(code, 0)
        self.assertEqual(out, b'{"ok":true,"command":"canon","hex":"' + _INT1_HEX.encode() + b'"}\n')

    def test_unrecognized_value_has_empty_recognized_array(self):
        code, out, _ = _run(["read", "--all", "--format", "json", "0000"])
        self.assertEqual(code, 0)
        self.assertEqual(out, b'{"ok":true,"command":"read","recognized":[]}\n')


class HumanOutputTests(unittest.TestCase):
    def test_decode_human_is_the_display_form(self):
        code, out, _ = _run(["decode", _INT1_HEX])
        self.assertEqual(code, 0)
        self.assertEqual(out, b"Tuple(Atom(0x696e74), Atom(0x0001))\n")

    def test_inspect_human_block(self):
        code, out, _ = _run(["inspect", _INT1_HEX])
        self.assertEqual(code, 0)
        self.assertEqual(
            out,
            b"Tuple(Atom(0x696e74), Atom(0x0001))\ncanonical: yes\nrecognized: int\n",
        )

    def test_read_all_human_none(self):
        code, out, _ = _run(["read", "--all", "0000"])
        self.assertEqual(code, 0)
        self.assertEqual(out, b"recognized: none\n")

    def test_read_kind_human_yes_no_and_exit_codes(self):
        code, out, _ = _run(["read", "--kind", "int", _INT1_HEX])
        self.assertEqual((code, out), (0, b"int: yes\n"))
        code, out, _ = _run(["read", "--kind", "set", _INT1_HEX])
        self.assertEqual((code, out), (1, b"set: no\n"))

    def test_canon_human(self):
        code, out, _ = _run(["canon", "--check", _INT1_HEX])
        self.assertEqual((code, out), (0, b"canonical: yes\n"))
        code, out, _ = _run(["canon", "--emit", _INT1_HEX])
        self.assertEqual((code, out), (0, _INT1_HEX.encode() + b"\n"))


class ErrorPathTests(unittest.TestCase):
    def test_invalid_hex_is_usage_class_exit_2(self):
        code, out, _ = _run(["decode", "--format", "json", "zz"])
        self.assertEqual(code, 2)
        self.assertEqual(out, b'{"ok":false,"command":"decode","error":"invalid_hex"}\n')
        # Odd-length hex is equally invalid.
        code, out, _ = _run(["decode", "--format", "json", "000"])
        self.assertEqual(code, 2)
        self.assertEqual(out, b'{"ok":false,"command":"decode","error":"invalid_hex"}\n')

    def test_hex_input_strips_only_space_tab_lf_cr(self):
        # ontos-cli.md "Synopsis": str.strip() with no argument also stripped
        # U+001C-U+001F, NBSP and every Unicode space.
        invalid = b'{"ok":false,"command":"canon","error":"invalid_hex"}\n'
        for text in ["\ufeff000100", "000100\u00a0", "000100\f", "\v000100", "000100\x1c", "00 0100"]:
            with self.subTest(text=text):
                self.assertEqual(_run(["canon", "--emit", "--format", "json", text])[:2], (2, invalid))
                self.assertEqual(_run(["canon", "--emit", "--format", "json"], stdin=text)[:2], (2, invalid))
        for text in [" \t\r\n000100\r\n", "000100\n"]:
            with self.subTest(text=text):
                self.assertEqual(_run(["canon", "--emit", text])[:2], (0, b"000100\n"))
                self.assertEqual(_run(["canon", "--emit"], stdin=text)[:2], (0, b"000100\n"))

    def test_hex_input_that_is_not_utf8_is_invalid_hex(self):
        # Strict stdin decoding, as under en_US.UTF-8, where reading stdin as text
        # crashed with UnicodeDecodeError (C.UTF-8 masks it with surrogateescape).
        invalid = b'{"ok":false,"command":"canon","error":"invalid_hex"}\n'
        strict = {**os.environ, "PYTHONIOENCODING": "utf-8:strict"}
        for raw in [b"\xff", b"000100\xff"]:
            proc = subprocess.run(
                [sys.executable, str(_MAIN), "canon", "--emit", "--format", "json"],
                input=raw,
                capture_output=True,
                env=strict,
            )
            self.assertEqual((proc.returncode, proc.stdout), (2, invalid))

    def test_decode_errors_carry_the_stable_code_exit_1(self):
        for hex_str, expected in [
            ("02", "unknown_tag"),
            ("0000ff", "trailing_bytes"),
            ("008000", "non_canonical_uvarint"),
            ("000561", "unexpected_eof"),
            ("008080808080808080808001", "uvarint_overflow"),
        ]:
            code, out, _ = _run(["decode", "--format", "json", hex_str])
            self.assertEqual(code, 1, hex_str)
            self.assertEqual(
                out,
                f'{{"ok":false,"command":"decode","error":"{expected}"}}\n'.encode(),
                hex_str,
            )

    def test_human_errors_go_to_stderr_only(self):
        code, out, err = _run(["decode", "02"])
        self.assertEqual(code, 1)
        self.assertEqual(out, b"")
        self.assertIn("unknown_tag", err)

    def test_usage_errors_exit_2(self):
        for args in [
            [],  # missing command
            ["frobnicate", "00"],  # unknown command
            ["decode", "--format", "yaml", "00"],  # bad format
            ["read", "0000"],  # read without --all/--kind
            ["read", "--all", "--kind", "int", "0000"],  # both
            ["read", "--kind", "float", "0000"],  # unknown kind
            ["canon", "--check", "--emit", "0000"],  # both canon modes
            ["decode", "--unknown-flag", "0000"],  # unknown flag
            ["decode", "0000", "0000"],  # two positionals
        ]:
            code, out, _ = _run(args)
            self.assertEqual(code, 2, f"args {args}")
            self.assertEqual(out, b"", f"args {args}: usage errors write stdout nothing")

    def test_stdin_input(self):
        code, out, _ = _run(["decode", "--format", "json"], stdin=f"  {_INT1_HEX}\n")
        self.assertEqual(code, 0)
        self.assertIn(b'"command":"decode"', out)
        code, out, _ = _run(["decode", "--format", "json", "-"], stdin=_INT1_HEX)
        self.assertEqual(code, 0)


class FromJsonTests(unittest.TestCase):
    def test_author_to_bytes_over_every_vector_case(self):
        """canon --emit --from-json over every encode case of both vector files:
        the emitted hex must equal the pinned hex (the harness's oracle property)."""
        for file in ("codec.json", "data.json"):
            doc = _read_vectors(file)
            for case in doc["encode"]:
                value_json = json.dumps(case["value"], separators=(",", ":"))
                code, out, _ = _run(["canon", "--emit", "--format", "json", "--from-json", value_json])
                self.assertEqual(code, 0, f"{file} {case['name']}")
                self.assertEqual(
                    out,
                    f'{{"ok":true,"command":"canon","hex":"{case["hex"]}"}}\n'.encode(),
                    f"{file} {case['name']}: emitted hex must equal pinned hex",
                )

    def test_from_json_works_with_every_command(self):
        value_json = '{"tuple":[{"atom":"696e74"},{"atom":"0001"}]}'
        code, out, _ = _run(["inspect", "--format", "json", "--from-json", value_json])
        self.assertEqual(code, 0)
        self.assertIn(b'"canonical":true', out)  # built, not decoded: always canonical
        self.assertIn(b'"recognized":["int"]', out)
        code, out, _ = _run(["read", "--kind", "int", "--format", "json", "--from-json", value_json])
        self.assertEqual(code, 0)

    def test_from_json_reads_stdin(self):
        code, out, _ = _run(
            ["canon", "--emit", "--from-json", "-"], stdin='{"atom":"61"}'
        )
        self.assertEqual((code, out), (0, b"000161\n"))

    def test_reject_grammar_is_invalid_json_exit_2(self):
        rejects = [
            ("malformed json", "{"),
            ("trailing data", '{"atom":"00"} x'),
            ("not an object", "[]"),
            ("a bare string", '"00"'),
            ("neither key", "{}"),
            ("both keys", '{"atom":"00","tuple":[]}'),
            ("extra keys", '{"atom":"00","x":1}'),
            ("non-string atom", '{"atom":7}'),
            ("odd-length hex", '{"atom":"0"}'),
            ("uppercase hex", '{"atom":"AB"}'),
            ("non-hex chars", '{"atom":"zz"}'),
            ("non-array tuple", '{"tuple":"00"}'),
            ("bad nested child", '{"tuple":[{"atom":"0"}]}'),
        ]
        for name, payload in rejects:
            code, out, _ = _run(["canon", "--emit", "--format", "json", "--from-json", payload])
            self.assertEqual(code, 2, name)
            self.assertEqual(
                out, b'{"ok":false,"command":"canon","error":"invalid_json"}\n', name
            )

    def test_reading_refuses_what_rfc_8259_and_the_total_form_refuse(self):
        # ontos-cli.md "Reading the text": a repeated member name (also spelled with
        # an escape), anything after the value, non-JSON whitespace, a lone
        # surrogate escape, NaN.
        invalid = b'{"ok":false,"command":"canon","error":"invalid_json"}\n'
        for text in [
            '{"atom":"00","atom":"01"}',
            '{"atom":"00","\\u0061tom":"00"}',
            '{"atom":"00"}]',
            '{"atom":"00"}}',
            '{"atom":"00"}\f',
            '\u00a0{"atom":"00"}',
            '{"atom":"\\ud800"}',
            "[NaN]",
        ]:
            with self.subTest(text=text):
                code, out, _ = _run(["canon", "--emit", "--format", "json", "--from-json", text])
                self.assertEqual((code, out), (2, invalid))
        code, out, _ = _run(["canon", "--emit", "--from-json", ' \t\r\n{ "atom" : "00" }\n'])
        self.assertEqual((code, out), (0, b"000100\n"))

    def test_reading_caps_nesting_at_1024_tuple_levels(self):
        def nested(n):
            return '{"tuple":[' * n + '{"atom":"00"}' + "]}" * n

        code, out, _ = _run(["canon", "--emit", "--from-json", "-"], stdin=nested(1024))
        self.assertEqual((code, out), (0, b"0101" * 1024 + b"000100\n"))
        too_deep = (1, b'{"ok":false,"command":"canon","error":"limit_exceeded"}\n')
        code, out, _ = _run(["canon", "--emit", "--format", "json", "--from-json", "-"], stdin=nested(1025))
        self.assertEqual((code, out), too_deep)
        # Far deeper is refused at the 2051st bracket, with no RecursionError.
        code, out, _ = _run(["canon", "--emit", "--format", "json", "--from-json", "-"], stdin=nested(100000))
        self.assertEqual((code, out), too_deep)

    def test_a_1024_deep_value_renders(self):
        # The human and json renderings walk with an explicit stack (core/py's
        # recursive __str__ exceeds the recursion limit at this depth).
        value = '{"tuple":[' * 1024 + '{"atom":"00"}' + "]}" * 1024
        code, out, _ = _run(["decode", "--from-json", "-"], stdin=value)
        self.assertEqual((code, out), (0, ("Tuple(" * 1024 + "Atom(0x00)" + ")" * 1024 + "\n").encode()))
        code, out, _ = _run(["decode", "--format", "json", "--from-json", "-"], stdin=value)
        self.assertEqual(code, 0)
        self.assertEqual(out, b'{"ok":true,"command":"decode","codec":"ontos-codec-v1","value":' + value.encode() + b"}\n")

    def test_invalid_json_is_emitted_per_command(self):
        for command, extra in [("decode", []), ("inspect", []), ("read", ["--all"]), ("canon", ["--emit"])]:
            code, out, _ = _run([command, *extra, "--format", "json", "--from-json", "{"])
            self.assertEqual(code, 2, command)
            self.assertEqual(
                out,
                f'{{"ok":false,"command":"{command}","error":"invalid_json"}}\n'.encode(),
                command,
            )

    def test_mutual_exclusion_with_positional_is_usage_error(self):
        # A real hex positional AND the `-` stdin sentinel are both bytes
        # sources, so each is rejected with --from-json (ontos-internal#45).
        for positional in ("0000", "-"):
            code, out, _ = _run(
                ["canon", "--emit", "--format", "json", "--from-json", '{"atom":"61"}', positional]
            )
            self.assertEqual(code, 2, positional)
            self.assertEqual(out, b'{"ok":false,"command":"canon","error":"usage_error"}\n', positional)
        # Human format: the error goes to stderr, stdout stays empty.
        code, out, err = _run(["canon", "--emit", "--from-json", '{"atom":"61"}', "0000"])
        self.assertEqual(code, 2)
        self.assertEqual(out, b"")
        self.assertIn("ontos:", err)


class KindsParityTests(unittest.TestCase):
    def test_kinds_matches_data_labels(self):
        """The CLI keeps its own copy of the registered label order by deliberate
        design (ontos-internal#49); this parity test pins the copy against the data
        module's LABELS, so drift is a CI-caught bug."""
        import importlib.util

        spec = importlib.util.spec_from_file_location("ontos_cli_main", _MAIN)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        from ontos_data import LABELS

        self.assertEqual(tuple(module.KINDS), tuple(LABELS))


if __name__ == "__main__":
    unittest.main()
