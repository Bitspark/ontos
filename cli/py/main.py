#!/usr/bin/env python3
"""ontos CLI (py) — the `ontos` byte-first inspector (docs/spec/ontos-cli.md).

    ontos <command> [--format human|json] [--from-json <json|->]
                    [--json-profile total|readable] [<hex>]

Bytes in, evidence out: input is canonical ontos-codec-v1 bytes given as a hex
string (positional, or "-"/omitted to read hex from stdin), OR JSON text via
``--from-json <json|->`` — the one text-to-bytes path, mutually exclusive with a
positional ``<hex>``. ``--json-profile`` selects the JSON profile of that input
and of the ``--format json`` value rendering: ontos-total-json/1 by default
(``{"atom":"<hex>"} | {"tuple":[...]}``), or ontos-readable-json/1, read from
stdin only. The projection library (``projection/json/py``) reads and writes it;
the value is built, not decoded, so it is canonical by construction. All four
commands (decode/inspect/read/canon) accept either input source.

This is the FOURTH peer implementation (go/rs/ts/py — ontos-internal#60), built over its
own core. It registers as just another ``--impl`` on the differential conformance
runner: no protocol change, no new judgment, no reference status. The contract —
not any one binary — is the source of truth, and the ``--format json`` output is
BYTE-IDENTICAL across the peers: compact (no insignificant whitespace), fixed key
order, lowercase hex, one object per line ending in "\\n", carrying only the
stable fields. The ``--format human`` rendering is equally pinned (ontos-internal#46).
Python is a VALIDATION lane, not a published/substrate lane.

Python stdlib only (json, sys, pathlib), mirroring the dependency-free cores.
The model/codec/data and the JSON projections come from the sibling ``core/py`` /
``codec/py`` / ``data/py`` / ``projection/json/py`` lanes, resolved by path relative
to this file (the py lanes are not installed packages — they are repo-local source,
like the npm-workspace TS lanes).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import List, Optional, Tuple as PyTuple

# Resolve the sibling py lanes by path: <repo-root>/{core,codec,data,projection/json}/py.
# This file is <repo-root>/cli/py/main.py, so the root is two parents up.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
for _lane in ("core", "codec", "data", "projection/json"):
    _lane_dir = str(_REPO_ROOT / _lane / "py")
    if _lane_dir not in sys.path:
        sys.path.insert(0, _lane_dir)

from ontos_core import Atom, Value  # noqa: E402
from ontos_codec import DecodeError, decode, encode  # noqa: E402
from ontos_data import (  # noqa: E402
    DataError,
    read_bool,
    read_list,
    read_map,
    read_null,
    read_set,
    read_text,
    recognize_decimal,
    recognize_int,
)
from ontos_json import ProjectionError, readable, total  # noqa: E402

CODEC_ID = "ontos-codec-v1"
VERSION = "ontos 0.1.0"

USAGE = """ontos — byte-first inspector for ontos values

usage:
  ontos <command> [--format human|json] [--from-json <json|->]
                  [--json-profile total|readable] [<hex>]

commands:
  decode    decode ontos-codec-v1 bytes to the L0 value tree
  inspect   decode + report codec id, canonical?, value, recognized embeddings
  read      recognize registered embeddings (--all | --kind <k>)
  canon     report (--check) or emit (--emit) the canonical bytes

options:
  -f, --format human|json   output format (default human)
      --from-json <json|->  supply the value as json text instead of hex;
                            "-" reads the json from stdin (excludes <hex>)
      --json-profile total|readable
                            the json profile of --from-json and of json value
                            output (default total: {"atom":"<hex>"} |
                            {"tuple":[ ... ]}); readable input only from stdin
  -h, --help                print this help and exit
  -V, --version             print the version and exit

read options:
      --all                 try every embedding and report the matches
      --kind int|utf8-text|bool|list|map|set|decimal|null
                            test recognition of one embedding

canon options:
      --check               report whether the input is canonical (default)
      --emit                print the canonical bytes as hex

input is hex; if <hex> is "-" or omitted it is read from stdin.
with --from-json the value is read from json text instead of hex."""

# The registered embedding labels, in the fixed order the contract pins for the
# `recognized` array (inspect / read --all). A value matches AT MOST one label,
# by its kind; the array is this order filtered to the kinds that recognize it.
# The CLI keeps its own copy of the data module's LABELS by deliberate design
# (see ontos-internal#49); a cli-side parity test pins this copy against ontos_data.LABELS.
KINDS = ("int", "utf8-text", "bool", "list", "map", "set", "decimal", "null")

# Each kind's recognizer; matched iff it does NOT raise DataError. `int`/`decimal`
# use the structural recognize_int/recognize_decimal (NOT read_*): a canonical
# value beyond a binding's host integer width is still recognized — the
# materialization limit is not a recognition miss (ontos-data.md §5.1/§5.9), so
# all cores agree here. (Python's int is unbounded, so the distinction is moot in
# this binding — but using the structural surface keeps the four CLIs parallel.)
_RECOGNIZERS = {
    "int": recognize_int,
    "utf8-text": read_text,
    "bool": read_bool,
    "list": read_list,
    "map": read_map,
    "set": read_set,
    "decimal": recognize_decimal,
    "null": read_null,
}

# Exit codes per the contract: 0 success, 1 negative result, 2 usage error.
EXIT_OK = 0
EXIT_NEGATIVE = 1
EXIT_USAGE = 2


def _write_out(text: str) -> None:
    """Write to stdout with EXACT bytes: "\\n" only, never platform "\\r\\n".

    The JSON Lines protocol and the pinned human rendering are byte-compared by
    the differential harness, so the newline must be the literal 0x0a on every
    platform (Python text mode would translate it on Windows).
    """
    sys.stdout.buffer.write(text.encode("utf-8"))
    sys.stdout.buffer.flush()


def _write_err(text: str) -> None:
    sys.stderr.write(text)
    sys.stderr.flush()


def _emit_line(obj: object) -> None:
    """Emit a compact JSON line (single line, "\\n"-terminated) to stdout.

    json.dumps with separators=(",", ":") is the compact form; dict insertion
    order fixes the contract key order; hex strings are already lowercase.
    """
    _write_out(json.dumps(obj, separators=(",", ":")) + "\n")


def _emit_error(command: str, code: str) -> None:
    _emit_line({"ok": False, "command": command, "error": code})


def _die_usage(message: str) -> int:
    _write_err(f"ontos: {message}\n")
    _write_err(USAGE + "\n")
    return EXIT_USAGE


# --- values as text ---------------------------------------------------------------


def _render(value: Value, atom_text, tuple_open: str, separator: str, tuple_close: str) -> str:
    """Render a Value with an explicit stack, so a value of any depth renders (a
    recursive walk exceeds Python's recursion limit near depth 1000). Each atom
    becomes atom_text(atom); each tuple becomes tuple_open, its children joined by
    separator, then tuple_close."""
    out: List[str] = []
    # Each entry is a value still to render, or the literal text to write next.
    pending: List[object] = [value]
    while pending:
        item = pending.pop()
        if isinstance(item, str):
            out.append(item)
        elif isinstance(item, Atom):
            out.append(atom_text(item))
        else:
            out.append(tuple_open)
            pending.append(tuple_close)
            children = item.items()
            for i in range(len(children) - 1, -1, -1):
                pending.append(children[i])
                if i:
                    pending.append(separator)
    return "".join(out)


def _human_value(value: Value) -> str:
    """The core's display form, str(value) — Tuple(Atom(0x..), ...) — rendered here
    because core/py's recursive __str__ exceeds Python's recursion limit on a
    1024-deep value. The text is the same; only the walk differs."""
    return _render(value, str, "Tuple(", ", ", ")")


# --- JSON values through the projection library -----------------------------------
#
# --json-profile selects the profile, the same way in all four CLIs (ontos-cli.md
# "Value input" and "JSON profiles"):
#   - total (the default) is ontos-total-json/1, through ontos_json.total. The
#     --from-json text comes from an argument or from stdin. Bytes that are not UTF-8
#     are read as U+FFFD before the library sees them (_total_text): that step is the
#     CLI's total transport, because Node decodes argv that way before ts sees it. The
#     library's reader is strict and never repairs text.
#   - readable is ontos-readable-json/1, through ontos_json.readable. Its input is read
#     from stdin only, as the exact bytes, with no lossy step: a replaced byte inside
#     a string would read as a different value (ontos-readable-json.md §10.1).
# A library refusal maps onto the CLI's codes: a limit is limit_exceeded (exit 1), and
# any other refusal is invalid_json (exit 2). The same profile renders the value of
# --format json output.

_PROFILES = {"total": total, "readable": readable}


def _total_text(data: bytes) -> bytes:
    """The total transport: invalid UTF-8 becomes U+FFFD. U+FFFD is never hex and
    never part of `atom` or `tuple`, so such a text is always refused, and the outcome
    never depends on how many U+FFFD replace a bad sequence."""
    return data.decode("utf-8", "replace").encode("utf-8")


def _value_from_json_source(source: str, profile: str) -> Value:
    """Read the --from-json text under the profile; "-" reads it from stdin. Nothing
    is trimmed: the reader allows only RFC 8259 whitespace. A refusal raises
    ProjectionError. os.fsencode recovers an argument's bytes from the
    surrogateescape decoding Python applied to it. (Readable text from an argument is
    refused before this, in _resolve_value.)"""
    data = sys.stdin.buffer.read() if source == "-" else os.fsencode(source)
    if profile == "readable":
        return readable.parse_utf8(data)
    return total.parse_utf8(_total_text(data))


def _json_failure(err: ProjectionError) -> PyTuple[str, int]:
    """Map a library refusal onto the CLI's codes: a limit is limit_exceeded, exit 1,
    as a decode limit; anything else is invalid_json, exit 2."""
    if err.code == "limit_exceeded":
        return "limit_exceeded", EXIT_NEGATIVE
    return "invalid_json", EXIT_USAGE


def _render_json_value(command: str, value: Value, profile: str) -> Optional[str]:
    """The value of a --format json result, in the profile's preferred spelling. Under
    the defaults the total writer accepts every value the CLI can hold (none is deeper
    than 1024), and the readable writer refuses only an integer of more than 4300
    digits: that refusal is emitted as the command's error line (limit_exceeded), and
    the result is None."""
    try:
        return _PROFILES[profile].render_utf8(value).decode("utf-8")
    except ProjectionError as err:
        code, _ = _json_failure(err)
        _emit_error(command, code)
        _write_err(f"ontos: cannot render the value: {err}\n")
        return None


# --- input resolution -----------------------------------------------------------


def _parse_hex(text: str) -> Optional[bytes]:
    """Parse a hex string to bytes; None on odd length or any non-hex char.

    Accepts uppercase A-F (matching Go's hex.DecodeString and the TS nibble
    parser); rejects internal whitespace explicitly (bytes.fromhex would
    otherwise tolerate it, which go/rs/ts do not).
    """
    if len(text) % 2 != 0:
        return None
    for ch in text:
        if not ("0" <= ch <= "9" or "a" <= ch <= "f" or "A" <= ch <= "F"):
            return None
    return bytes.fromhex(text)


# The whitespace stripped around hex input: space, tab, LF and CR (RFC 8259's set,
# as --from-json allows), and nothing else (ontos-cli.md "Synopsis"). str.strip()
# with no argument would also strip U+001C-U+001F, NBSP and every Unicode space.
_HEX_INPUT_SPACE = " \t\n\r"


def _read_input(arg: Optional[str]) -> str:
    """The hex input: the argument when present and not "-", otherwise the whole
    of stdin, with surrounding space/tab/LF/CR stripped. Bytes that are not UTF-8
    are read as U+FFFD (stdin as bytes, an argument through os.fsencode), so they
    fail as invalid_hex like any other non-hex."""
    if arg is not None and arg != "-":
        text = os.fsencode(arg).decode("utf-8", "replace")
    else:
        text = sys.stdin.buffer.read().decode("utf-8", "replace")
    return text.strip(_HEX_INPUT_SPACE)


class _Resolved:
    """The command's one Value plus the input bytes it was obtained from."""

    __slots__ = ("value", "raw")

    def __init__(self, value: Value, raw: bytes) -> None:
        self.value = value
        self.raw = raw


def _resolve_value(
    command: str,
    fmt: str,
    from_json: Optional[str],
    positional: Optional[str],
    profile: str = "total",
) -> PyTuple[Optional[_Resolved], int]:
    """Obtain the command's single Value from exactly one source — the
    positional <hex>/stdin (default) or --from-json — emitting the shared
    usage_error / invalid_hex / invalid_json (all exit 2) and DecodeError
    (exit 1) results for the given command. Returns (resolved, 0) on success,
    (None, exit_code) on failure.

    For the hex path the returned raw bytes are the input bytes (so inspect can
    compare them against the re-encoding). For the --from-json path the value is
    read by the projection library in the selected profile and is canonical by
    construction, so raw is its encoding.
    """
    # Mutual exclusion: --from-json together with a positional <hex> is a
    # usage_error. A "-" positional is the stdin sentinel, not a hex value, but
    # it still names the bytes source, so combining it with --from-json (its own
    # source) is equally ambiguous and rejected (ontos-cli.md "Value input").
    if from_json is not None and positional is not None:
        if fmt == "json":
            _emit_error(command, "usage_error")
        else:
            _write_err("ontos: --from-json cannot be combined with a positional <hex>\n")
        return None, EXIT_USAGE

    if from_json is not None:
        # Readable input is read from stdin only: an argument may have been decoded
        # lossily on its way in (Node's argv is), and a replaced byte inside a string
        # would read as another value (ontos-readable-json.md §10.1).
        if profile == "readable" and from_json != "-":
            if fmt == "json":
                _emit_error(command, "usage_error")
            else:
                _write_err("ontos: --json-profile readable reads --from-json from stdin only (--from-json -)\n")
            return None, EXIT_USAGE
        try:
            value = _value_from_json_source(from_json, profile)
        except ProjectionError as err:
            # A limit is limit_exceeded (exit 1), exactly as a decode limit; any other
            # refusal is the stable invalid_json usage error (exit 2). The library's
            # reason goes to stderr (human only).
            code, exit_code = _json_failure(err)
            if fmt == "json":
                _emit_error(command, code)
            else:
                _write_err(f"ontos: json input: {err}\n")
            return None, exit_code
        # Built, not decoded: canonical by construction. An L0 Value has exactly
        # one ontos-codec-v1 encoding, so its encoding is the canonical bytes.
        return _Resolved(value, encode(value)), 0

    hex_text = _read_input(positional)
    raw = _parse_hex(hex_text)
    if raw is None:
        if fmt == "json":
            _emit_error(command, "invalid_hex")
        else:
            _write_err("ontos: invalid hex input\n")
        return None, EXIT_USAGE

    try:
        return _Resolved(decode(raw), raw), 0
    except DecodeError as err:
        if fmt == "json":
            _emit_error(command, err.code)
        else:
            _write_err(f"ontos: decode error: {err.code}\n")
        return None, EXIT_NEGATIVE


# --- recognition ----------------------------------------------------------------


def _recognizes(value: Value, kind: str) -> bool:
    """Whether the top-level value is a well-formed instance of `kind`."""
    try:
        _RECOGNIZERS[kind](value)
        return True
    except DataError:
        return False


def _recognized_kinds(value: Value) -> List[str]:
    """The recognized labels in the fixed contract order, filtered to matches."""
    return [kind for kind in KINDS if _recognizes(value, kind)]


def _human_labels(labels: List[str]) -> str:
    """The canonical human rendering of the recognized labels, shared by
    `inspect` and `read --all`: the labels joined by ", " (comma-space), or
    "none" when empty — the tri-core human-output contract (ontos-internal#46),
    enforced byte-for-byte across go/rs/ts/py by --human-roundtrip."""
    return ", ".join(labels) if labels else "none"


def _yes_no(b: bool) -> str:
    return "yes" if b else "no"


def _is_canonical(value: Value, raw: bytes) -> bool:
    """Canonical iff re-encoding the decoded value reproduces the input bytes."""
    return encode(value) == raw


# --- commands -------------------------------------------------------------------


def _run_decode(fmt: str, from_json: Optional[str], positional: Optional[str], profile: str = "total") -> int:
    resolved, exit_code = _resolve_value("decode", fmt, from_json, positional, profile)
    if resolved is None:
        return exit_code

    if fmt == "json":
        rendered = _render_json_value("decode", resolved.value, profile)
        if rendered is None:
            return EXIT_NEGATIVE
        # Contract key order: ok, command, codec, value.
        _write_out('{"ok":true,"command":"decode","codec":"' + CODEC_ID + '","value":' + rendered + "}\n")
    else:
        _write_out(_human_value(resolved.value) + "\n")
    return EXIT_OK


def _run_inspect(fmt: str, from_json: Optional[str], positional: Optional[str], profile: str = "total") -> int:
    resolved, exit_code = _resolve_value("inspect", fmt, from_json, positional, profile)
    if resolved is None:
        return exit_code

    canonical = _is_canonical(resolved.value, resolved.raw)
    recognized = _recognized_kinds(resolved.value)

    if fmt == "json":
        rendered = _render_json_value("inspect", resolved.value, profile)
        if rendered is None:
            return EXIT_NEGATIVE
        # Contract key order: ok, command, codec, canonical, value, recognized.
        # The value is spliced in as the library wrote it: json.dumps would escape
        # every non-ASCII character of a readable string.
        head = json.dumps(
            {"ok": True, "command": "inspect", "codec": CODEC_ID, "canonical": canonical},
            separators=(",", ":"),
        )
        tail = json.dumps(recognized, separators=(",", ":"))
        _write_out(head[:-1] + ',"value":' + rendered + ',"recognized":' + tail + "}\n")
    else:
        _write_out(_human_value(resolved.value) + "\n")
        _write_out(f"canonical: {_yes_no(canonical)}\n")
        _write_out(f"recognized: {_human_labels(recognized)}\n")
    return EXIT_OK


def _run_read(
    fmt: str,
    from_json: Optional[str],
    positional: Optional[str],
    all_flag: bool,
    kind: Optional[str],
    profile: str = "total",
) -> int:
    resolved, exit_code = _resolve_value("read", fmt, from_json, positional, profile)
    if resolved is None:
        return exit_code

    if all_flag:
        recognized = _recognized_kinds(resolved.value)
        if fmt == "json":
            _emit_line({"ok": True, "command": "read", "recognized": recognized})
        else:
            # The "recognized: " prefix is present on BOTH inspect and read --all
            # (the tri-core human contract, ontos-internal#46).
            _write_out(f"recognized: {_human_labels(recognized)}\n")
        return EXIT_OK

    # Single --kind probe: exit 0 if recognized, else 1.
    assert kind is not None  # parse guarantees exactly one of --all/--kind
    ok = _recognizes(resolved.value, kind)
    if fmt == "json":
        _emit_line({"ok": True, "command": "read", "kind": kind, "recognized": ok})
    else:
        # Canonical human form: `<kind>: yes|no` (ontos-cli.md "Human format").
        _write_out(f"{kind}: {_yes_no(ok)}\n")
    return EXIT_OK if ok else EXIT_NEGATIVE


def _run_canon(
    fmt: str,
    from_json: Optional[str],
    positional: Optional[str],
    emit_mode: bool,
    profile: str = "total",
) -> int:
    resolved, exit_code = _resolve_value("canon", fmt, from_json, positional, profile)
    if resolved is None:
        return exit_code

    if emit_mode:
        hex_str = encode(resolved.value).hex()
        if fmt == "json":
            _emit_line({"ok": True, "command": "canon", "hex": hex_str})
        else:
            _write_out(hex_str + "\n")
        return EXIT_OK

    # --check (or default): decode succeeded, so canonical is always true on the
    # hex path (decode only accepts canonical bytes) and on the from-json path
    # (built, not decoded). The comparison keeps the definition honest.
    canonical = _is_canonical(resolved.value, resolved.raw)
    if fmt == "json":
        _emit_line({"ok": True, "command": "canon", "canonical": canonical})
    else:
        _write_out(f"canonical: {_yes_no(canonical)}\n")
    return EXIT_OK


# --- argument parsing -----------------------------------------------------------


class _UsageError(Exception):
    """A bad command line: reported on stderr with the usage text, exit 2."""


class _Args:
    """The shared argument surface: --format, --from-json, --json-profile, one positional."""

    __slots__ = ("fmt", "from_json", "profile", "positional")

    def __init__(self) -> None:
        self.fmt = "human"
        self.from_json: Optional[str] = None
        self.profile = "total"
        self.positional: Optional[str] = None


def _parse_format(text: str) -> str:
    if text in ("human", "json"):
        return text
    raise _UsageError(f'unknown format "{text}" (want human|json)')


def _parse_profile(text: str) -> str:
    if text in _PROFILES:
        return text
    raise _UsageError(f'unknown json profile "{text}" (want total|readable)')


def _parse_kind(text: str) -> str:
    if text in KINDS:
        return text
    raise _UsageError(f'unknown kind "{text}" (want int|utf8-text|bool|list|map|set|decimal)')


def _set_from_json(args: _Args, value: str) -> None:
    if args.from_json is not None:
        raise _UsageError("--from-json given more than once")
    args.from_json = value


def _set_positional(args: _Args, value: str) -> None:
    if args.positional is not None:
        raise _UsageError("more than one input argument")
    args.positional = value


def _consume_common_arg(tokens: List[str], i: int, args: _Args) -> int:
    """Handle the arguments shared by every command — --format/-f, --from-json
    and --json-profile (each with a separate-token or name=value form), the
    at-most-one positional hex (or the "-" stdin sentinel), and rejection of
    any other flag. Returns the index of the next unconsumed token. Mutual
    exclusion between --from-json and a positional is enforced later by
    _resolve_value, so argument order does not matter."""
    arg = tokens[i]
    if arg in ("-f", "--format"):
        if i + 1 >= len(tokens):
            raise _UsageError("--format requires an argument (human|json)")
        args.fmt = _parse_format(tokens[i + 1])
        return i + 2
    if arg.startswith("--format="):
        args.fmt = _parse_format(arg[len("--format="):])
        return i + 1
    if arg == "--from-json":
        if i + 1 >= len(tokens):
            raise _UsageError("--from-json requires an argument (json|-)")
        _set_from_json(args, tokens[i + 1])
        return i + 2
    if arg.startswith("--from-json="):
        _set_from_json(args, arg[len("--from-json="):])
        return i + 1
    if arg == "--json-profile":
        if i + 1 >= len(tokens):
            raise _UsageError("--json-profile requires an argument (total|readable)")
        args.profile = _parse_profile(tokens[i + 1])
        return i + 2
    if arg.startswith("--json-profile="):
        args.profile = _parse_profile(arg[len("--json-profile="):])
        return i + 1
    if arg != "-" and arg.startswith("--"):
        raise _UsageError(f'unknown flag "{arg}"')
    if arg != "-" and len(arg) > 1 and arg.startswith("-"):
        # A leading-dash token that is neither "-" (stdin) nor a known flag.
        raise _UsageError(f'unknown flag "{arg}"')
    # "-" (stdin sentinel) or a bare hex string is the positional.
    _set_positional(args, arg)
    return i + 1


def _parse_common(tokens: List[str]) -> _Args:
    """Post-command arguments for decode/inspect: every argument is shared."""
    args = _Args()
    i = 0
    while i < len(tokens):
        i = _consume_common_arg(tokens, i, args)
    return args


def _parse_read(tokens: List[str]) -> PyTuple[_Args, bool, Optional[str]]:
    """Post-command arguments for read: shared args plus exactly one of --all /
    --kind <kind>. Missing both, giving both, or an unknown kind is a usage error."""
    args = _Args()
    all_flag = False
    kind: Optional[str] = None
    i = 0
    while i < len(tokens):
        arg = tokens[i]
        if arg == "--all":
            all_flag = True
            i += 1
        elif arg == "--kind":
            if i + 1 >= len(tokens):
                raise _UsageError("--kind requires an argument (int|utf8-text|bool|list|map|set|decimal)")
            kind = _parse_kind(tokens[i + 1])
            i += 2
        elif arg.startswith("--kind="):
            kind = _parse_kind(arg[len("--kind="):])
            i += 1
        else:
            i = _consume_common_arg(tokens, i, args)
    if all_flag and kind is not None:
        raise _UsageError("read takes --all or --kind, not both")
    if not all_flag and kind is None:
        raise _UsageError("read requires --all or --kind <kind>")
    return args, all_flag, kind


def _parse_canon(tokens: List[str]) -> PyTuple[_Args, bool]:
    """Post-command arguments for canon: shared args plus at most one of
    --check / --emit (neither defaults to --check). Giving both is a usage error."""
    args = _Args()
    check = False
    emit_mode = False
    i = 0
    while i < len(tokens):
        arg = tokens[i]
        if arg == "--check":
            check = True
            i += 1
        elif arg == "--emit":
            emit_mode = True
            i += 1
        else:
            i = _consume_common_arg(tokens, i, args)
    if check and emit_mode:
        raise _UsageError("canon takes --check or --emit, not both")
    return args, emit_mode


# --- main -----------------------------------------------------------------------


def main(argv: List[str]) -> int:
    """The CLI's testable core: returns the process exit code."""
    # --help / --version are recognized before anything else, in any position.
    for arg in argv:
        if arg in ("-h", "--help"):
            _write_out(USAGE + "\n")
            return EXIT_OK
        if arg in ("-V", "--version"):
            _write_out(VERSION + "\n")
            return EXIT_OK

    if not argv:
        _write_err("ontos: missing command\n")
        _write_err(USAGE + "\n")
        return EXIT_USAGE

    command = argv[0]
    rest = argv[1:]

    try:
        if command == "decode":
            args = _parse_common(rest)
            return _run_decode(args.fmt, args.from_json, args.positional, args.profile)
        if command == "inspect":
            args = _parse_common(rest)
            return _run_inspect(args.fmt, args.from_json, args.positional, args.profile)
        if command == "read":
            args, all_flag, kind = _parse_read(rest)
            return _run_read(args.fmt, args.from_json, args.positional, all_flag, kind, args.profile)
        if command == "canon":
            args, emit_mode = _parse_canon(rest)
            return _run_canon(args.fmt, args.from_json, args.positional, emit_mode, args.profile)
    except _UsageError as err:
        return _die_usage(str(err))

    _write_err(f'ontos: unknown command "{command}"\n')
    _write_err(USAGE + "\n")
    return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
