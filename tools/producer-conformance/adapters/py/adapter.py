"""producer-conformance adapter — Python. See ../../PROTOCOL.md.

    adapter.py <kind> <arg>   ->  one JSON line on stdout

Builds the host value NATIVELY from the recipe, runs the blessed producer, and
reports canonical bytes or a classified rejection. Positional args, not JSON: ontos
is a zero-dependency repo, and four hand-rolled JSON parsers would have bugs
indistinguishable from producer bugs.
"""

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent.parent
for _lane in ("core", "codec", "data"):
    sys.path.insert(0, str(_REPO_ROOT / _lane / "py"))

from ontos_codec import encode  # noqa: E402
from ontos_data import DataError, encode_bool, encode_int, encode_text  # noqa: E402


class Unsupported(Exception):
    """The host value is unconstructible in this language — not a failure."""


def build_and_encode(kind, arg):
    if kind == "int":
        return encode_int(int(arg))  # a Python int is unbounded; the decimal maps exactly
    if kind == "bool":
        return encode_bool({"true": True, "false": False}[arg])
    if kind == "text":
        # Unicode scalar values -> a native str.
        return encode_text("".join(chr(int(c)) for c in arg.split(",") if c))
    if kind == "utf16":
        # Python has no UTF-16 string; a surrogate is simply its code point, which is
        # what makes the lone-surrogate case constructible here at all.
        return encode_text("".join(chr(int(u)) for u in arg.split(",") if u))
    if kind == "bytes":
        raise Unsupported("a Python str cannot carry arbitrary non-UTF-8 bytes")
    raise Unsupported(f"unknown kind {kind!r}")


def main(argv):
    if len(argv) != 3:
        print(json.dumps({"status": "error", "code": "adapter_usage"}))
        return 2
    try:
        value = build_and_encode(argv[1], argv[2])
    except Unsupported as exc:
        print(json.dumps({"status": "unsupported", "reason": str(exc)}))
        return 0
    except DataError as exc:
        print(json.dumps({"status": "error", "code": exc.code}))
        return 0
    except Exception as exc:  # noqa: BLE001
        # A producer letting a non-DataError escape is a §4.1 law-3 violation. Report
        # it verbatim so the harness SEES the leak instead of normalizing it away.
        print(json.dumps({"status": "error", "code": f"UNCLASSIFIED:{type(exc).__name__}"}))
        return 0
    print(json.dumps({"status": "ok", "hex": encode(value).hex()}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
