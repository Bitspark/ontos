"""ontos-total-json/1: the total JSON form of ground values (docs/spec/ontos-total-json.md).

::

    Atom(b)              ->  {"atom":"<b as lowercase hex>"}
    Tuple(v0, ..., vn-1) ->  {"tuple":[<v0>,...,<vn-1>]}

``parse_utf8`` reads the source bytes in the four stages of §4.1 and returns the value, or
raises ``ProjectionError`` with the code, path, span and kind that §4 determines.
``render_utf8`` writes the preferred spelling of §2, checking the limits of §9 as the reader's
mirror (§9.3). Neither recurses on nesting, so the shipped depth of 1024 value levels (2050 JSON
levels) is reached on an explicit stack whatever Python's recursion limit is (§9.2).

The readable profile (``ontos_json.readable``) embeds this one in its ``raw`` arm and uses the
interpreter and writer below for it.
"""

from __future__ import annotations

import re
from typing import Callable, List, Optional, Tuple as PyTuple

from ontos_core import Atom, Tuple, Value

from . import _lexer
from ._lexer import ARRAY, OBJECT, STRING, Node
from ._shared import (
    KIND_ATOM_BYTES,
    KIND_DECODE_DEPTH,
    KIND_INTEGER_DIGITS,
    KIND_JSON_DEPTH,
    KIND_TEXT_BYTES,
    KIND_TUPLE_ARITY,
    Limits,
    ProjectionError,
    Span,
    path_tuple,
)

__all__ = [
    "PROFILE",
    "DEFAULT_LIMITS",
    "Limits",
    "ProjectionError",
    "Span",
    "json_depth_bound",
    "parse_utf8",
    "parse_str",
    "render_utf8",
]

PROFILE = "ontos-total-json/1"

# The shipped defaults of this profile (§9.2): value depth 1024, JSON depth derived from it
# (2 * 1024 + 2 = 2050), everything else unbounded. max_integer_digits belongs to the readable
# profile; this one never checks it.
DEFAULT_LIMITS = Limits(
    max_text_bytes=None,
    max_json_depth=None,
    max_value_depth=1024,
    max_atom_bytes=None,
    max_tuple_arity=None,
    max_integer_digits=None,
)


def json_depth_bound(limits: Limits) -> Optional[int]:
    """The effective ``max_json_depth`` under ``limits`` (§9.2): set, or derived as ``2v + 2``."""
    if limits.max_json_depth is not None:
        return limits.max_json_depth
    if limits.max_value_depth is None:
        return None
    return 2 * limits.max_value_depth + 2


def _require_limits(limits: object) -> Limits:
    if not isinstance(limits, Limits):
        raise TypeError(f"limits must be an ontos_json Limits, got {type(limits).__name__}")
    return limits


# --- reading ---------------------------------------------------------------------------------


def parse_utf8(data: bytes, *, limits: Limits = DEFAULT_LIMITS) -> Value:
    """Read ``data``, the exact bytes of a total-form text, as a value (§4).

    Raises ``ProjectionError`` (profile ``ontos-total-json/1``) for every refusal. A partial
    value is never returned.
    """
    _require_limits(limits)
    data = _lexer.as_input_bytes(data, "parse_utf8")
    root = _lexer.read_json(data, limits.max_text_bytes, json_depth_bound(limits), PROFILE)
    value, _ = interpret(root, 0, None, limits, PROFILE, False)
    return value


def parse_str(text: str, *, limits: Limits = DEFAULT_LIMITS) -> Value:
    """Read a host string as ``parse_utf8`` reads its generalized UTF-8 encoding (§10).

    A lone surrogate is refused with ``invalid_utf8``. The byte reader is the normative one: a
    string reader cannot know whether the string was decoded lossily before it arrived.
    """
    _require_limits(limits)
    return parse_utf8(_lexer.str_input_bytes(text, "parse_str"), limits=limits)


# An origin is (linked JSON path, start, end). An origin tree mirrors a value: (origin, None)
# when every node of the value's subtree has that origin, else (origin, [child trees]).
Origin = PyTuple[object, int, int]

_LOWER_HEX = re.compile(r"[0-9a-f]*")


def _at(profile: str, code: str, link: object, node: Node, kind: Optional[str] = None) -> ProjectionError:
    return ProjectionError(profile, code, path_tuple(link), Span(node.start, node.end), kind)


def interpret(root: Node, depth: int, link: object, limits: Limits, profile: str, origins: bool):
    """Stage 4 (§4.4): interpret a JSON node as a total-form value at ``depth`` and ``link``.

    Returns ``(value, origin tree)``, the tree being ``None`` unless ``origins`` is set. Each
    node is checked in the order of §4.4, before its elements, which are interpreted in order,
    each subtree completing before the next begins. Open tuples are kept on an explicit stack.
    """
    max_depth = limits.max_value_depth
    max_atom = limits.max_atom_bytes
    max_arity = limits.max_tuple_arity
    # Open tuples: [element nodes, link of the array, depth of the elements, values, trees, origin]
    stack: List[list] = []
    x, d, xlink = root, depth, link
    while True:
        if x.kind != OBJECT or len(x.value) != 1:
            raise _at(profile, "invalid_total_form", xlink, x)
        name, _name_start, _name_end, y = x.value[0]
        if name == "atom":
            if y.kind != STRING:
                raise _at(profile, "invalid_total_form", (xlink, "atom"), y)
            hex_text = y.value
            if len(hex_text) % 2 or _LOWER_HEX.fullmatch(hex_text) is None:
                raise _at(profile, "invalid_hex", (xlink, "atom"), y)
            if max_depth is not None and d > max_depth:
                raise _at(profile, "limit_exceeded", xlink, x, KIND_DECODE_DEPTH)
            if max_atom is not None and len(hex_text) // 2 > max_atom:
                raise _at(profile, "limit_exceeded", xlink, x, KIND_ATOM_BYTES)
            done: Value = Atom(bytes.fromhex(hex_text))
            tree = ((xlink, x.start, x.end), None) if origins else None
        elif name == "tuple":
            ylink = (xlink, "tuple")
            if y.kind != ARRAY:
                raise _at(profile, "invalid_total_form", ylink, y)
            elements = y.value
            if max_depth is not None and d > max_depth:
                raise _at(profile, "limit_exceeded", xlink, x, KIND_DECODE_DEPTH)
            if max_arity is not None and len(elements) > max_arity:
                raise _at(profile, "limit_exceeded", xlink, x, KIND_TUPLE_ARITY)
            origin = (xlink, x.start, x.end) if origins else None
            if elements:
                stack.append([elements, ylink, d + 1, [], [] if origins else None, origin])
                x, d, xlink = elements[0], d + 1, (ylink, 0)
                continue
            done = Tuple(())
            tree = (origin, []) if origins else None
        else:
            raise _at(profile, "invalid_total_form", xlink, x)

        while stack:
            frame = stack[-1]
            values = frame[3]
            values.append(done)
            if origins:
                frame[4].append(tree)
            i = len(values)
            if i < len(frame[0]):
                x, d, xlink = frame[0][i], frame[2], (frame[1], i)
                break
            stack.pop()
            done = Tuple(values)
            tree = (frame[5], frame[4]) if origins else None
        else:
            return done, tree


# --- writing ---------------------------------------------------------------------------------


class Writer:
    """The output of a writer, with the checks of §9.3 in the order of the bytes it emits.

    Work is a stack of operations ``(function, *arguments)``; each function receives the writer
    and the stack, emits what it can and pushes what follows it. Before the first byte of each
    node, ``check`` tests the node's contribution; ``open`` tests ``max_json_depth`` at each
    opening bracket; ``emit`` refuses at the first byte beyond ``max_text_bytes``.
    """

    __slots__ = ("out", "depth", "limits", "max_text", "max_json", "profile", "ops")

    def __init__(self, limits: Limits, max_json: Optional[int], profile: str) -> None:
        self.out = bytearray()
        self.depth = 0
        self.limits = limits
        self.max_text = limits.max_text_bytes
        self.max_json = max_json
        self.profile = profile
        self.ops: List[tuple] = []

    def refuse(self, kind: str, link: object) -> ProjectionError:
        return ProjectionError(self.profile, "limit_exceeded", path_tuple(link), None, kind)

    def emit(self, piece: bytes, link: object) -> None:
        self.out += piece
        if self.max_text is not None and len(self.out) > self.max_text:
            raise self.refuse(KIND_TEXT_BYTES, link)

    def open(self, piece: bytes, link: object) -> None:
        if self.max_json is not None and self.depth + 1 > self.max_json:
            raise self.refuse(KIND_JSON_DEPTH, link)
        self.depth += 1
        self.emit(piece, link)

    def check(
        self,
        link: object,
        depth: int,
        arity: Optional[int],
        digits: Optional[int],
        atom_bytes: Optional[int] | Callable[[], int],
    ) -> None:
        """Check a contribution: deepest node, widest tuple, longest integer, longest atom."""
        limits = self.limits
        if limits.max_value_depth is not None and depth > limits.max_value_depth:
            raise self.refuse(KIND_DECODE_DEPTH, link)
        if arity is not None and limits.max_tuple_arity is not None and arity > limits.max_tuple_arity:
            raise self.refuse(KIND_TUPLE_ARITY, link)
        if digits is not None and limits.max_integer_digits is not None and digits > limits.max_integer_digits:
            raise self.refuse(KIND_INTEGER_DIGITS, link)
        if atom_bytes is not None and limits.max_atom_bytes is not None:
            if callable(atom_bytes):
                atom_bytes = atom_bytes()
            if atom_bytes > limits.max_atom_bytes:
                raise self.refuse(KIND_ATOM_BYTES, link)

    def run(self) -> bytes:
        ops = self.ops
        while ops:
            op = ops.pop()
            op[0](self, *op[1:])
        return bytes(self.out)


def op_emit(w: Writer, piece: bytes, link: object) -> None:
    w.emit(piece, link)


def op_close(w: Writer, piece: bytes, link: object) -> None:
    w.depth -= 1
    w.emit(piece, link)


def push_sequence(w: Writer, op: Callable, children, depth: int, link: object, close: bytes, close_link: object) -> None:
    """Push ``children`` as comma-separated elements of an open array, then its closing bytes."""
    ops = w.ops
    ops.append((op_close, close, close_link))
    for i in range(len(children) - 1, -1, -1):
        ops.append((op, children[i], depth, (link, i)))
        if i:
            ops.append((op_emit, b",", link))


def write_total(w: Writer, value: Value, depth: int, link: object) -> None:
    """Write ``value`` at value depth ``depth`` in the preferred total spelling (§2, §5)."""
    if isinstance(value, Atom):
        data = value.bytes()
        w.check(link, depth, None, None, len(data))
        w.open(b"{", link)
        w.emit(b'"atom":"' + data.hex().encode("ascii") + b'"', (link, "atom"))
        op_close(w, b"}", link)
        return
    if not isinstance(value, Tuple):
        raise TypeError(f"expected an ontos Value, got {type(value).__name__}")
    items = value.items()
    w.check(link, depth, len(items), None, None)
    w.open(b"{", link)
    w.emit(b'"tuple":', link)
    ylink = (link, "tuple")
    w.open(b"[", ylink)
    w.ops.append((op_close, b"}", link))
    push_sequence(w, write_total, items, depth + 1, ylink, b"]", ylink)


def render_utf8(value: Value, *, limits: Limits = DEFAULT_LIMITS) -> bytes:
    """Write ``value`` in its preferred total spelling as UTF-8 bytes (§5).

    No byte order mark, no whitespace, no trailing newline. Under finite limits the writer
    refuses, as the reader would, with ``ProjectionError`` (code ``limit_exceeded``, a kind,
    no span, and an informative path in the output) (§9.3).
    """
    _require_limits(limits)
    w = Writer(limits, json_depth_bound(limits), PROFILE)
    w.ops.append((write_total, value, 0, None))
    return w.run()
