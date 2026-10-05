#!/usr/bin/env python3
"""ontos CLI (py) — the `ontos` byte-first inspector (docs/spec/ontos-cli.md).

    ontos <command> [--format human|json] [--from-json <json|->] [<hex>]

Bytes in, evidence out: input is canonical ontos-codec-v1 bytes given as a hex
string (positional, or "-"/omitted to read hex from stdin), OR the authoring
notation via ``--from-json <json|->`` (the inverse of ``--format json`` value
rendering) — the one text-to-bytes path, mutually exclusive with a positional
``<hex>``. The from-json value is built directly with the core constructors, so
it is canonical by construction (no bytes are decoded). All four commands
(decode/inspect/read/canon) accept either input source.

This is the FOURTH peer implementation (go/rs/ts/py — ontos-internal#60), built over its
own core. It registers as just another ``--impl`` on the differential conformance
runner: no protocol change, no new judgment, no reference status. The contract —
not any one binary — is the source of truth, and the ``--format json`` output is
BYTE-IDENTICAL across the peers: compact (no insignificant whitespace), fixed key
order, lowercase hex, one object per line ending in "\\n", carrying only the
stable fields. The ``--format human`` rendering is equally pinned (ontos-internal#46).
Python is a VALIDATION lane, not a published/substrate lane.

Python stdlib only (json, sys, pathlib), mirroring the dependency-free cores.
The model/codec/data come from the sibling ``core/py`` / ``codec/py`` /
``data/py`` lanes, resolved by path relative to this file (the py lanes are not
installed packages — they are repo-local source, like the npm-workspace TS lanes).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import List, Optional, Tuple as PyTuple

# Resolve the sibling py lanes by path: <repo-root>/{core,codec,data}/py. This
# file is <repo-root>/cli/py/main.py, so the root is two parents up.
_REPO_ROOT = Path(__file__).resolve().parent.parent.parent
for _lane in ("core", "codec", "data"):
    _lane_dir = str(_REPO_ROOT / _lane / "py")
    if _lane_dir not in sys.path:
        sys.path.insert(0, _lane_dir)

from ontos_core import Atom, Tuple, Value, atom, tuple_  # noqa: E402
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

CODEC_ID = "ontos-codec-v1"
VERSION = "ontos 0.1.0"

USAGE = """ontos — byte-first inspector for ontos values

usage:
  ontos <command> [--format human|json] [--from-json <json|->] [<hex>]

commands:
  decode    decode ontos-codec-v1 bytes to the L0 value tree
  inspect   decode + report codec id, canonical?, value, recognized embeddings
  read      recognize registered embeddings (--all | --kind <k>)
  canon     report (--check) or emit (--emit) the canonical bytes

options:
  -f, --format human|json   output format (default human)
      --from-json <json|->  supply the value as authoring notation
                            ({"atom":"<hex>"} | {"tuple":[ ... ]}) instead of hex;
                            "-" reads the json from stdin (excludes <hex>)
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
with --from-json the value is parsed from authoring json instead of hex."""

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


# --- authoring notation ---------------------------------------------------------


def _to_authoring(value: Value) -> object:
    """Render a Value as the authoring notation: {"atom":hex} | {"tuple":[...]}."""
    if isinstance(value, Atom):
        return {"atom": value.bytes().hex()}
    return {"tuple": [_to_authoring(item) for item in value.items()]}


class _AuthoringError(Exception):
    """A malformed --from-json input: not parseable JSON, or parseable but not
    the {atom:hex}|{tuple:[...]} authoring shape. Both collapse to the single
    stable `invalid_json` error code, so the four CLIs agree on output even if
    their raw-JSON tokenizers differ on exotic syntax (ontos-cli.md "Value input").
    """


def _from_authoring(node: object) -> Value:
    """Parse the authoring notation into a core Value — the exact inverse of
    _to_authoring (and of the --format json value rendering). A value is a JSON
    object with EXACTLY ONE of "atom" (even-length lowercase hex, "" = empty
    atom) or "tuple" (a JSON array of values), and no extra keys. Anything else
    raises _AuthoringError -> the stable `invalid_json` code.

    Validation mirrors the go/rs/ts CLIs and tools/vector/gen.mjs parseAuthoring:
    the post-parse structural check is identical across the cores, so any
    malformed input yields the same result regardless of each language's JSON
    tokenizer.
    """
    if not isinstance(node, dict):
        raise _AuthoringError("value must be an object")
    has_atom = "atom" in node
    has_tuple = "tuple" in node
    if has_atom == has_tuple:
        raise _AuthoringError('value must have exactly one of "atom" or "tuple"')
    if len(node) != 1:
        raise _AuthoringError("value object has extra keys")
    if has_atom:
        return atom(_authoring_atom_bytes(node["atom"]))
    arr = node["tuple"]
    if not isinstance(arr, list):
        raise _AuthoringError('"tuple" must be an array')
    return tuple_([_from_authoring(child) for child in arr])


def _authoring_atom_bytes(hex_str: object) -> bytes:
    """Decode an authoring atom string: even-length LOWERCASE hex ("" allowed)."""
    if not isinstance(hex_str, str):
        raise _AuthoringError('"atom" must be a string')
    if len(hex_str) % 2 != 0:
        raise _AuthoringError('"atom" must be even-length hex')
    for ch in hex_str:
        if not ("0" <= ch <= "9" or "a" <= ch <= "f"):
            raise _AuthoringError('"atom" must be lowercase hex')
    return bytes.fromhex(hex_str)


def _value_from_json_source(source: str) -> Value:
    """Build a Value from the --from-json source: json parse, then the SAME
    structural validation as every core. "-" reads the JSON from stdin
    (mirroring how hex does). Any malformed input raises _AuthoringError.
    """
    text = sys.stdin.read() if source == "-" else source
    try:
        parsed = json.loads(text)
    except ValueError:
        raise _AuthoringError("malformed JSON") from None
    return _from_authoring(parsed)


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


def _read_input(arg: Optional[str]) -> str:
    """The textual input (hex or json): the argument when present and not "-",
    otherwise the whole of stdin. Surrounding whitespace stripped either way."""
    if arg is not None and arg != "-":
        return arg.strip()
    return sys.stdin.read().strip()


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
) -> PyTuple[Optional[_Resolved], int]:
    """Obtain the command's single Value from exactly one source — the
    positional <hex>/stdin (default) or --from-json — emitting the shared
    usage_error / invalid_hex / invalid_json (all exit 2) and DecodeError
    (exit 1) results for the given command. Returns (resolved, 0) on success,
    (None, exit_code) on failure.

    For the hex path the returned raw bytes are the input bytes (so inspect can
    compare them against the re-encoding). For the --from-json path the value is
    built directly and is canonical by construction, so raw is its encoding.
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
        try:
            value = _value_from_json_source(from_json)
        except _AuthoringError as err:
            # Any malformed JSON or non-authoring shape is the stable invalid_json
            # usage error (exit 2). The specific reason goes to stderr (human only).
            if fmt == "json":
                _emit_error(command, "invalid_json")
            else:
                _write_err(f"ontos: invalid json input: {err}\n")
            return None, EXIT_USAGE
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


def _run_decode(fmt: str, from_json: Optional[str], positional: Optional[str]) -> int:
    resolved, exit_code = _resolve_value("decode", fmt, from_json, positional)
    if resolved is None:
        return exit_code

    if fmt == "json":
        # Contract key order: ok, command, codec, value.
        _emit_line(
            {"ok": True, "command": "decode", "codec": CODEC_ID, "value": _to_authoring(resolved.value)}
        )
    else:
        _write_out(str(resolved.value) + "\n")
    return EXIT_OK


def _run_inspect(fmt: str, from_json: Optional[str], positional: Optional[str]) -> int:
    resolved, exit_code = _resolve_value("inspect", fmt, from_json, positional)
    if resolved is None:
        return exit_code

    canonical = _is_canonical(resolved.value, resolved.raw)
    recognized = _recognized_kinds(resolved.value)

    if fmt == "json":
        # Contract key order: ok, command, codec, canonical, value, recognized.
        _emit_line(
            {
                "ok": True,
                "command": "inspect",
                "codec": CODEC_ID,
                "canonical": canonical,
                "value": _to_authoring(resolved.value),
                "recognized": recognized,
            }
        )
    else:
        _write_out(str(resolved.value) + "\n")
        _write_out(f"canonical: {_yes_no(canonical)}\n")
        _write_out(f"recognized: {_human_labels(recognized)}\n")
    return EXIT_OK


def _run_read(
    fmt: str,
    from_json: Optional[str],
    positional: Optional[str],
    all_flag: bool,
    kind: Optional[str],
) -> int:
    resolved, exit_code = _resolve_value("read", fmt, from_json, positional)
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
) -> int:
    resolved, exit_code = _resolve_value("canon", fmt, from_json, positional)
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
    """The shared argument surface: --format, --from-json, one positional."""

    __slots__ = ("fmt", "from_json", "positional")

    def __init__(self) -> None:
        self.fmt = "human"
        self.from_json: Optional[str] = None
        self.positional: Optional[str] = None


def _parse_format(text: str) -> str:
    if text in ("human", "json"):
        return text
    raise _UsageError(f'unknown format "{text}" (want human|json)')


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
    """Handle the arguments shared by every command — --format/-f and
    --from-json (each with a separate-token or name=value form), the
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
            return _run_decode(args.fmt, args.from_json, args.positional)
        if command == "inspect":
            args = _parse_common(rest)
            return _run_inspect(args.fmt, args.from_json, args.positional)
        if command == "read":
            args, all_flag, kind = _parse_read(rest)
            return _run_read(args.fmt, args.from_json, args.positional, all_flag, kind)
        if command == "canon":
            args, emit_mode = _parse_canon(rest)
            return _run_canon(args.fmt, args.from_json, args.positional, emit_mode)
    except _UsageError as err:
        return _die_usage(str(err))

    _write_err(f'ontos: unknown command "{command}"\n')
    _write_err(USAGE + "\n")
    return EXIT_USAGE


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
