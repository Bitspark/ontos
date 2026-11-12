"""ontos-readable-json/1: the readable JSON form of ground values (docs/spec/ontos-readable-json.md).

The common ground values are spelled as ordinary JSON (``null``, ``true``, ``false``, strings,
integers within +-(2**53 - 1), arrays, text-keyed objects), and every other value goes through
the one reserved envelope ``{"$ontos":[tag, ...]}`` with the tags ``bytes``, ``int``,
``decimal``, ``map``, ``set``, ``compound`` and ``raw``. ``raw`` wraps the total form
(``ontos_json.total``), so this profile is total over L0 too.

``parse_utf8`` reads source bytes in the four stages of the total profile, stage 4 being §4 of
this page; ``parse_utf8_with_origins`` also returns where each node of the value came from
(§10.2). ``render_utf8`` writes the preferred spelling of §2, checking the limits as the
reader's mirror (§9). Nothing recurses on nesting: interpretation and writing keep explicit
stacks.

Integers are converted between decimal text and binary by this module itself, in chunks of at
most 512 digits, so the result never depends on CPython's process-wide limit on int/str
conversion (``PYTHONINTMAXSTRDIGITS``, as low as 640), and only ASCII digits are ever accepted
(§4.5).

Keys of a ``map`` tag and elements of a ``set`` tag are compared and sorted by their codec
encodings (§4.4, §4.8), and so are a canonical map's keys and a canonical set's elements when
the writer recognizes them (through ``ontos_data``). Each such container encodes its keys or
elements once, so a value costs at most its size times its nesting depth: bounded by the depth
limit, 1024 by default.
"""

from __future__ import annotations

import base64
import re
from collections.abc import Mapping
from typing import Iterator, List, NamedTuple, Optional, Sequence, Tuple as PyTuple

from ontos_codec import encode, encode_uvarint
from ontos_core import Atom, Tuple, Value
from ontos_data import (
    DataError,
    read_bool,
    read_map,
    read_set,
    read_text,
    recognize_decimal,
    recognize_int,
    recognize_null,
)

from . import _lexer, total
from ._lexer import ARRAY, FALSE, INTEGER, NULL, NUMBER, OBJECT, STRING, TRUE, Node, utf8_fault
from ._shared import (
    KIND_ATOM_BYTES,
    KIND_DECODE_DEPTH,
    KIND_INTEGER_DIGITS,
    KIND_TUPLE_ARITY,
    Limits,
    ProjectionError,
    Segment,
    Span,
    path_tuple,
)
from .total import Writer, op_close, op_emit, push_sequence, write_total

__all__ = [
    "PROFILE",
    "DEFAULT_LIMITS",
    "Limits",
    "ProjectionError",
    "Span",
    "Origin",
    "Origins",
    "Parsed",
    "json_depth_bound",
    "parse_utf8",
    "parse_str",
    "parse_utf8_with_origins",
    "render_utf8",
]

PROFILE = "ontos-readable-json/1"

# The shipped defaults of this profile (§9): value depth 1024, JSON depth derived from it
# (3 * 1024 + 4 = 3076), integers of at most 4300 digits, everything else unbounded.
DEFAULT_LIMITS = Limits(
    max_text_bytes=None,
    max_json_depth=None,
    max_value_depth=1024,
    max_atom_bytes=None,
    max_tuple_arity=None,
    max_integer_digits=4300,
)


def json_depth_bound(limits: Limits) -> Optional[int]:
    """The effective ``max_json_depth`` under ``limits`` (§9): set, or derived as ``3v + 4``."""
    if limits.max_json_depth is not None:
        return limits.max_json_depth
    if limits.max_value_depth is None:
        return None
    return 3 * limits.max_value_depth + 4


def _require_limits(limits: object) -> Limits:
    if not isinstance(limits, Limits):
        raise TypeError(f"limits must be an ontos_json Limits, got {type(limits).__name__}")
    return limits


# --- the ontos/data values this profile spells (ontos-data §5) -------------------------------

_LABEL_NULL = Atom(b"null")
_LABEL_BOOL = Atom(b"bool")
_LABEL_TEXT = Atom(b"utf8-text")
_LABEL_INT = Atom(b"int")
_LABEL_LIST = Atom(b"list")
_LABEL_MAP = Atom(b"map")
_LABEL_SET = Atom(b"set")
_LABEL_DECIMAL = Atom(b"decimal")

_NULL = Tuple((_LABEL_NULL,))
_TRUE = Tuple((_LABEL_BOOL, Atom(b"\x01")))
_FALSE = Tuple((_LABEL_BOOL, Atom(b"\x00")))
_EMPTY_LIST = Tuple((_LABEL_LIST,))
_EMPTY_MAP = Tuple((_LABEL_MAP,))
_EMPTY_SET = Tuple((_LABEL_SET,))


def _text(data: bytes) -> Value:
    return Tuple((_LABEL_TEXT, Atom(data)))


# The ontos-codec-v1 encoding of utf8-text(s) up to its payload length: Tuple of arity 2, then
# Atom("utf8-text"), then the payload atom's tag. An object key's encoding is this prefix,
# uvarint(len), and the UTF-8 bytes; it must equal encode(_text(data)), which a test pins.
_TEXT_PREFIX = b"\x01\x02\x00\x09utf8-text\x00"


def _text_encoding(data: bytes) -> bytes:
    return _TEXT_PREFIX + encode_uvarint(len(data)) + data


# --- integers (§4.5) ---------------------------------------------------------------------------

_MAX_SAFE = 9007199254740991  # 2**53 - 1
_SAFE_DIGITS = 16  # len(str(_MAX_SAFE))

# Canonical integer text: 0, or an optional - and a non-zero digit followed by digits. [0-9] is
# the ASCII range only, never a Unicode digit, and fullmatch admits no trailing newline.
_INT_TEXT = re.compile(r"0|-?[1-9][0-9]*")

# Every int/str conversion below handles at most _CHUNK digits at once, under the lowest limit
# CPython allows (640), so no interpreter setting can refuse it.
_CHUNK = 512
_CHUNK_SCALE = 10**_CHUNK
_LOG10_2 = 0.30102999566398120


def _digits_to_int(digits: str) -> int:
    """The value of a non-empty run of ASCII digits, independent of CPython's digit limit."""
    if len(digits) <= _CHUNK:
        return int(digits)
    digits = "0" * (-len(digits) % _CHUNK) + digits
    parts = [int(digits[i : i + _CHUNK]) for i in range(0, len(digits), _CHUNK)]
    width = _CHUNK
    while len(parts) > 1:
        if len(parts) % 2:
            parts.insert(0, 0)
        scale = 10**width
        parts = [parts[i] * scale + parts[i + 1] for i in range(0, len(parts), 2)]
        width *= 2
    return parts[0]


def _int_to_digits(magnitude: int) -> str:
    """The decimal digits of a non-negative int, independent of CPython's digit limit."""
    if magnitude < _CHUNK_SCALE:
        return str(magnitude)
    powers = [_CHUNK_SCALE]  # powers[k] = 10 ** (_CHUNK * 2**k)
    while powers[-1] * powers[-1] <= magnitude:
        powers.append(powers[-1] * powers[-1])
    parts = [magnitude]
    for power in reversed(powers):
        split: List[int] = []
        for part in parts:
            high, low = divmod(part, power)
            split.append(high)
            split.append(low)
        parts = split
    return "".join(str(part).zfill(_CHUNK) for part in parts).lstrip("0")


def _digit_count(magnitude: int) -> int:
    """The number of decimal digits of a non-negative int, without converting it to text."""
    if magnitude < 10:
        return 1
    count = int((magnitude.bit_length() - 1) * _LOG10_2)  # never above the true count
    while 10**count <= magnitude:
        count += 1
    return count


def _int_payload(n: int) -> bytes:
    """The sign-magnitude payload of ontos-data §5.1: a sign byte, then the minimal magnitude."""
    magnitude = -n if n < 0 else n
    body = magnitude.to_bytes((magnitude.bit_length() + 7) // 8, "big")
    return (b"\x01" if n < 0 else b"\x00") + body


def _text_to_int(text: str) -> int:
    """The int of canonical integer text (``_INT_TEXT``), at any magnitude."""
    if text[0] == "-":
        return -_digits_to_int(text[1:])
    return _digits_to_int(text)


def _int_to_text(payload: bytes) -> str:
    """Canonical integer text of a canonical int payload."""
    digits = _int_to_digits(int.from_bytes(payload[1:], "big"))
    return "-" + digits if payload[0] == 0x01 else digits


# --- base64 (§4.7) -----------------------------------------------------------------------------

_B64_BODY = re.compile(r"[A-Za-z0-9+/]*")
_B64_CHARS = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
_B64_Z4 = frozenset("AQgw")  # the last character before "==": its low four bits are zero
_B64_Z2 = frozenset("AEIMQUYcgkosw048")  # the last character before "=": its low two bits are zero


def _base64_decode(text: str) -> Optional[bytes]:
    """The bytes of canonical padded standard base64 (``b64-content``), or None."""
    n = len(text)
    if n % 4:
        return None
    if n == 0:
        return b""
    if _B64_BODY.fullmatch(text, 0, n - 4) is None:
        return None
    a, b, c, d = text[n - 4 :]
    if d != "=":
        ok = a in _B64_CHARS and b in _B64_CHARS and c in _B64_CHARS and d in _B64_CHARS
    elif c != "=":
        ok = a in _B64_CHARS and b in _B64_CHARS and c in _B64_Z2
    else:
        ok = a in _B64_CHARS and b in _B64_Z4
    if not ok:
        return None
    # The text is canonical by the grammar, so the decoder has nothing to forgive.
    return base64.b64decode(text, validate=True)


def _base64_encode(data: bytes) -> bytes:
    return base64.b64encode(data)


# --- origins (§10.2) ---------------------------------------------------------------------------


class Origin(NamedTuple):
    """Where a node of the value came from: the JSON path and the span of its source."""

    path: PyTuple[Segment, ...]
    span: Span


class Parsed(NamedTuple):
    """The result of ``parse_utf8_with_origins``: the value and its origins."""

    value: Value
    origins: "Origins"


def _origin(raw: tuple) -> Origin:
    link, start, end = raw
    return Origin(path_tuple(link), Span(start, end))


class Origins(Mapping):
    """The origin of every node of a value, keyed by value path (§10.2).

    A value path is a tuple of tuple-child indexes from the root: ``()`` is the root and
    ``(2, 1)`` is child 1 of child 2. It addresses the L0 tree, so after sorting a map entry's
    index is its position in codec order. ``origins[path]`` looks one up (``KeyError`` when the
    value has no such node), and iteration and ``items()`` enumerate the value in pre-order.
    Origins are metadata: they are not part of the value, its identity or its encoding.
    """

    __slots__ = ("_value", "_tree", "_size")

    def __init__(self, value: Value, tree: tuple) -> None:
        self._value = value
        self._tree = tree
        self._size: Optional[int] = None

    def __getitem__(self, value_path: Sequence[int]) -> Origin:
        value, tree = self._value, self._tree
        raw, children = tree
        for index in value_path:
            if isinstance(index, bool) or not isinstance(index, int):
                raise KeyError(tuple(value_path))
            if not isinstance(value, Tuple) or not 0 <= index < len(value):
                raise KeyError(tuple(value_path))
            value = value.at(index)
            if children is not None:
                raw, children = children[index]
        return _origin(raw)

    def _walk(self) -> Iterator[PyTuple[PyTuple[int, ...], tuple]]:
        stack = [((), self._value, self._tree[0], self._tree[1])]
        while stack:
            path, value, raw, children = stack.pop()
            yield path, raw
            if isinstance(value, Tuple):
                items = value.items()
                for i in range(len(items) - 1, -1, -1):
                    if children is None:
                        stack.append((path + (i,), items[i], raw, None))
                    else:
                        child_raw, child_children = children[i]
                        stack.append((path + (i,), items[i], child_raw, child_children))

    def __iter__(self) -> Iterator[PyTuple[int, ...]]:
        for path, _raw in self._walk():
            yield path

    def items(self) -> Iterator[PyTuple[PyTuple[int, ...], Origin]]:  # type: ignore[override]
        """``(value path, origin)`` for every node of the value, in pre-order."""
        for path, raw in self._walk():
            yield path, _origin(raw)

    def __len__(self) -> int:
        if self._size is None:
            self._size = sum(1 for _ in self._walk())
        return self._size

    def __contains__(self, value_path: object) -> bool:
        try:
            self[value_path]  # type: ignore[index]
        except (KeyError, TypeError):
            return False
        return True


# --- reading (§4) ------------------------------------------------------------------------------

_TAG_ARITY = {"bytes": 2, "int": 2, "decimal": 3, "map": 2, "set": 2, "compound": 3, "raw": 2}

# Containers whose children are interpreted in turn (§4.2, §4.4).
_LIST = 0  # an array: elements
_MEMBERS = 1  # an object: member values
_ENTRIES = 2  # a map tag: key, value, key, value, ...
_ELEMENTS = 3  # a set tag: elements
_ARGUMENTS = 4  # a compound tag: arguments


class _Frame:
    __slots__ = ("kind", "tasks", "values", "trees", "keys", "seen", "extra", "origin")

    def __init__(self, kind: int, tasks: list, origin: Optional[tuple], origins: bool, extra: object = None) -> None:
        self.kind = kind
        self.tasks = tasks  # (node, value depth, link) of each child, in document order
        self.values: List[Value] = []
        self.trees: Optional[list] = [] if origins else None
        self.keys: list = []  # codec encodings of keys or elements, for equality and order
        self.seen: set = set()
        self.extra = extra  # members: key info; entries: entry origins; arguments: label
        self.origin = origin


def _interpret(root: Node, limits: Limits, origins: bool):
    """Stage 4 (§4): interpret the JSON tree as a value, with its origin tree if asked."""
    max_depth = limits.max_value_depth
    max_arity = limits.max_tuple_arity
    max_digits = limits.max_integer_digits
    max_atom = limits.max_atom_bytes

    def refuse(code: str, node: Node, link: object, kind: Optional[str] = None) -> ProjectionError:
        return ProjectionError(PROFILE, code, path_tuple(link), Span(node.start, node.end), kind)

    def check(node: Node, link: object, depth: int, arity: Optional[int], digits: Optional[int]) -> None:
        """The first three limit checks of §4.9; the caller checks ``atom_bytes`` last."""
        if max_depth is not None and depth > max_depth:
            raise refuse("limit_exceeded", node, link, KIND_DECODE_DEPTH)
        if max_arity is not None and arity is not None and arity > max_arity:
            raise refuse("limit_exceeded", node, link, KIND_TUPLE_ARITY)
        if max_digits is not None and digits is not None and digits > max_digits:
            raise refuse("limit_exceeded", node, link, KIND_INTEGER_DIGITS)

    def check_atom(node: Node, link: object, atom_bytes: int) -> None:
        if max_atom is not None and atom_bytes > max_atom:
            raise refuse("limit_exceeded", node, link, KIND_ATOM_BYTES)

    stack: List[_Frame] = []
    x, d, link = root, 0, None
    while True:
        # Interpret node x at value depth d and path link: either the value is complete
        # (``done``, with its origin tree ``tree``), or a frame is pushed for its children.
        origin = (link, x.start, x.end) if origins else None
        tree = (origin, None)
        kind = x.kind
        frame: Optional[_Frame] = None
        if kind == STRING:
            data = x.value.encode("utf-8")
            check(x, link, d + 1, 2, None)
            check_atom(x, link, max(9, len(data)))
            done: Value = _text(data)
        elif kind == INTEGER:
            lexeme = x.value
            digits = lexeme[1:] if lexeme[0] == "-" else lexeme
            if len(digits) > _SAFE_DIGITS or int(digits) > _MAX_SAFE:
                raise refuse("unsafe_integer_literal", x, link)
            check(x, link, d + 1, 2, len(digits))
            n = -int(digits) if lexeme[0] == "-" else int(digits)
            payload = _int_payload(n)
            check_atom(x, link, max(3, len(payload)))
            done = Tuple((_LABEL_INT, Atom(payload)))
        elif kind == NUMBER:
            raise refuse("invalid_number", x, link)
        elif kind == TRUE or kind == FALSE:
            check(x, link, d + 1, 2, None)
            check_atom(x, link, 4)
            done = _TRUE if kind == TRUE else _FALSE
        elif kind == NULL:
            check(x, link, d + 1, 1, None)
            check_atom(x, link, 4)
            done = _NULL
        elif kind == ARRAY:
            elements = x.value
            check(x, link, d + 1, 1 + len(elements), None)
            check_atom(x, link, 4)
            if elements:
                tasks = [(element, d + 1, (link, i)) for i, element in enumerate(elements)]
                frame = _Frame(_LIST, tasks, origin, origins)
            else:
                done = _EMPTY_LIST
        elif kind == OBJECT and not any(member[0] == "$ontos" for member in x.value):
            members = x.value
            if members:
                names = [member[0].encode("utf-8") for member in members]
                check(x, link, d + 3, max(1 + len(members), 2), None)
                check_atom(x, link, max(9, max(len(name) for name in names)))
                info = []
                tasks = []
                for member, name in zip(members, names):
                    key = _text(name)
                    mlink = (link, member[0])
                    info.append(
                        (key, _text_encoding(name), (mlink, member[1], member[2]), (mlink, member[1], member[3].end))
                    )
                    tasks.append((member[3], d + 2, mlink))
                frame = _Frame(_MEMBERS, tasks, origin, origins, info)
            else:
                check(x, link, d + 1, 1, None)
                check_atom(x, link, 3)
                done = _EMPTY_MAP
        else:
            # An object with a member named $ontos: the envelope (§4.3), and nothing else.
            members = x.value
            if len(members) != 1:
                raise refuse("invalid_envelope", x, link)
            y = members[0][3]
            ylink = (link, "$ontos")
            if y.kind != ARRAY:
                raise refuse("invalid_envelope", y, ylink)
            items = y.value
            if not items:
                raise refuse("invalid_envelope", y, ylink)
            if items[0].kind != STRING:
                raise refuse("invalid_envelope", items[0], (ylink, 0))
            tag = items[0].value
            arity = _TAG_ARITY.get(tag)
            if arity is None:
                raise refuse("unknown_tag", items[0], (ylink, 0))
            if len(items) != arity:
                raise refuse("invalid_tag", y, ylink)

            if tag == "bytes":
                y1 = items[1]
                if y1.kind != STRING:
                    raise refuse("invalid_tag", y1, (ylink, 1))
                data = _base64_decode(y1.value)
                if data is None:
                    raise refuse("invalid_base64", y1, (ylink, 1))
                check(x, link, d, None, None)
                check_atom(x, link, len(data))
                done = Atom(data)
            elif tag == "int":
                y1 = items[1]
                if y1.kind != STRING:
                    raise refuse("invalid_tag", y1, (ylink, 1))
                text = y1.value
                if _INT_TEXT.fullmatch(text) is None:
                    raise refuse("invalid_integer", y1, (ylink, 1))
                check(x, link, d + 1, 2, len(text) - (text[0] == "-"))
                payload = _int_payload(_text_to_int(text))
                check_atom(x, link, max(3, len(payload)))
                done = Tuple((_LABEL_INT, Atom(payload)))
            elif tag == "decimal":
                for i in (1, 2):
                    yi = items[i]
                    if yi.kind != STRING:
                        raise refuse("invalid_tag", yi, (ylink, i))
                    if _INT_TEXT.fullmatch(yi.value) is None:
                        raise refuse("invalid_integer", yi, (ylink, i))
                mantissa, exponent = items[1].value, items[2].value
                if mantissa == "0":
                    if exponent != "0":
                        raise refuse("noncanonical_decimal", items[2], (ylink, 2))
                elif mantissa[-1] == "0":
                    raise refuse("noncanonical_decimal", items[1], (ylink, 1))
                digits = max(len(mantissa) - (mantissa[0] == "-"), len(exponent) - (exponent[0] == "-"))
                check(x, link, d + 2, 3, digits)
                m_payload = _int_payload(_text_to_int(mantissa))
                e_payload = _int_payload(_text_to_int(exponent))
                check_atom(x, link, max(7, len(m_payload), len(e_payload)))
                done = Tuple(
                    (
                        _LABEL_DECIMAL,
                        Tuple((_LABEL_INT, Atom(m_payload))),
                        Tuple((_LABEL_INT, Atom(e_payload))),
                    )
                )
            elif tag == "map":
                y1, link1 = items[1], (ylink, 1)
                if y1.kind != ARRAY:
                    raise refuse("invalid_tag", y1, link1)
                entries = y1.value
                for j, entry in enumerate(entries):
                    if entry.kind != ARRAY or len(entry.value) != 2:
                        raise refuse("invalid_tag", entry, (link1, j))
                if entries:
                    check(x, link, d + 1, max(1 + len(entries), 2), None)
                    check_atom(x, link, 3)
                    tasks = []
                    entry_origins = []
                    for j, entry in enumerate(entries):
                        elink = (link1, j)
                        tasks.append((entry.value[0], d + 2, (elink, 0)))
                        tasks.append((entry.value[1], d + 2, (elink, 1)))
                        entry_origins.append((elink, entry.start, entry.end))
                    frame = _Frame(_ENTRIES, tasks, origin, origins, entry_origins)
                else:
                    check(x, link, d + 1, 1, None)
                    check_atom(x, link, 3)
                    done = _EMPTY_MAP
            elif tag == "set":
                y1, link1 = items[1], (ylink, 1)
                if y1.kind != ARRAY:
                    raise refuse("invalid_tag", y1, link1)
                elements = y1.value
                check(x, link, d + 1, 1 + len(elements), None)
                check_atom(x, link, 3)
                if elements:
                    tasks = [(element, d + 1, (link1, j)) for j, element in enumerate(elements)]
                    frame = _Frame(_ELEMENTS, tasks, origin, origins)
                else:
                    done = _EMPTY_SET
            elif tag == "compound":
                y1, link1 = items[1], (ylink, 1)
                if y1.kind == STRING:
                    label = y1.value.encode("utf-8")
                else:
                    if y1.kind != ARRAY or len(y1.value) != 2:
                        raise refuse("invalid_tag", y1, link1)
                    l0, l1 = y1.value
                    if l0.kind != STRING or l0.value != "bytes":
                        raise refuse("invalid_tag", l0, (link1, 0))
                    if l1.kind != STRING:
                        raise refuse("invalid_tag", l1, (link1, 1))
                    decoded = _base64_decode(l1.value)
                    if decoded is None:
                        raise refuse("invalid_base64", l1, (link1, 1))
                    label = decoded
                y2, link2 = items[2], (ylink, 2)
                if y2.kind != ARRAY:
                    raise refuse("invalid_tag", y2, link2)
                arguments = y2.value
                check(x, link, d + 1, 1 + len(arguments), None)
                check_atom(x, link, len(label))
                if arguments:
                    tasks = [(argument, d + 1, (link2, i)) for i, argument in enumerate(arguments)]
                    frame = _Frame(_ARGUMENTS, tasks, origin, origins, Atom(label))
                else:
                    done = Tuple((Atom(label),))
            else:  # raw: the total form, at this value depth, with its own codes and limits
                done, tree = total.interpret(items[1], d, (ylink, 1), limits, PROFILE, origins)

        if frame is not None:
            stack.append(frame)
            x, d, link = frame.tasks[0]
            continue

        # ``done`` is complete: hand it to its container, finishing every container it fills.
        while stack:
            frame = stack[-1]
            values = frame.values
            i = len(values)
            if frame.kind == _ENTRIES:
                if i % 2 == 0:  # a key: refused if it equals an earlier key, before its value
                    key = encode(done)
                    if key in frame.seen:
                        node, _depth, klink = frame.tasks[i]
                        raise refuse("duplicate_map_key", node, klink)
                    frame.seen.add(key)
                    frame.keys.append(key)
            elif frame.kind == _ELEMENTS:
                element = encode(done)
                if element in frame.seen:
                    node, _depth, elink = frame.tasks[i]
                    raise refuse("duplicate_set_element", node, elink)
                frame.seen.add(element)
                frame.keys.append(element)
            values.append(done)
            if origins:
                frame.trees.append(tree)
            if i + 1 < len(frame.tasks):
                x, d, link = frame.tasks[i + 1]
                break
            stack.pop()
            done, tree = _finish(frame, origins)
        else:
            return done, tree


def _finish(frame: _Frame, origins: bool):
    """The value of a container whose children are all interpreted, and its origin tree."""
    values, trees, kind = frame.values, frame.trees, frame.kind
    head = (frame.origin, None)
    if kind == _LIST or kind == _ARGUMENTS:
        label = _LABEL_LIST if kind == _LIST else frame.extra
        value = Tuple((label, *values))
        return value, ((frame.origin, [head, *trees]) if origins else None)
    if kind == _MEMBERS:
        info = frame.extra
        order = sorted(range(len(values)), key=lambda i: info[i][1])
        value = Tuple((_LABEL_MAP, *(Tuple((info[i][0], values[i])) for i in order)))
        if not origins:
            return value, None
        kids = [head]
        for i in order:
            kids.append((info[i][3], [(info[i][2], None), trees[i]]))
        return value, (frame.origin, kids)
    if kind == _ENTRIES:
        keys = frame.keys
        order = sorted(range(len(keys)), key=keys.__getitem__)
        value = Tuple((_LABEL_MAP, *(Tuple((values[2 * j], values[2 * j + 1])) for j in order)))
        if not origins:
            return value, None
        entry_origins = frame.extra
        kids = [head]
        for j in order:
            kids.append((entry_origins[j], [trees[2 * j], trees[2 * j + 1]]))
        return value, (frame.origin, kids)
    # _ELEMENTS
    keys = frame.keys
    order = sorted(range(len(keys)), key=keys.__getitem__)
    value = Tuple((_LABEL_SET, *(values[j] for j in order)))
    if not origins:
        return value, None
    return value, (frame.origin, [head, *(trees[j] for j in order)])


def _read(data: object, limits: Limits, origins: bool, caller: str):
    _require_limits(limits)
    data = _lexer.as_input_bytes(data, caller)
    root = _lexer.read_json(data, limits.max_text_bytes, json_depth_bound(limits), PROFILE)
    return _interpret(root, limits, origins)


def parse_utf8(data: bytes, *, limits: Limits = DEFAULT_LIMITS) -> Value:
    """Read ``data``, the exact bytes of a readable text, as a value (§4).

    Raises ``ProjectionError`` (profile ``ontos-readable-json/1``) for every refusal. A partial
    value is never returned.
    """
    value, _ = _read(data, limits, False, "parse_utf8")
    return value


def parse_str(text: str, *, limits: Limits = DEFAULT_LIMITS) -> Value:
    """Read a host string as ``parse_utf8`` reads its generalized UTF-8 encoding (§10.1).

    A lone surrogate is refused with ``invalid_utf8``. Use it only for a string that never
    passed through a lossy decoding: a U+FFFD put in place of a bad byte reads as text here.
    """
    _require_limits(limits)
    return parse_utf8(_lexer.str_input_bytes(text, "parse_str"), limits=limits)


def parse_utf8_with_origins(data: bytes, *, limits: Limits = DEFAULT_LIMITS) -> Parsed:
    """Read ``data`` as ``parse_utf8`` does, and also return the origins of the value (§10.2)."""
    value, tree = _read(data, limits, True, "parse_utf8_with_origins")
    return Parsed(value, Origins(value, tree))


# --- writing (§2, §5) --------------------------------------------------------------------------

_ESCAPE = re.compile(r'["\\\x00-\x1f]')
_ESCAPES = {chr(c): "\\u%04x" % c for c in range(0x20)}
_ESCAPES.update({'"': '\\"', "\\": "\\\\", "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f", "\r": "\\r"})


def _json_string(text: str) -> bytes:
    """The JSON string of ``text``, escaped exactly as §5 says, as UTF-8."""
    escaped = _ESCAPE.sub(lambda m: _ESCAPES[m.group()], text)
    return b'"' + escaped.encode("utf-8") + b'"'


def _op_open(w: Writer, piece: bytes, link: object) -> None:
    w.open(piece, link)


def _envelope(w: Writer, tag: bytes, link: object) -> object:
    """Open ``{"$ontos":["<tag>",`` and push its closing ``]}``; returns the tag array's link."""
    w.open(b"{", link)
    w.emit(b'"$ontos":', link)
    ylink = (link, "$ontos")
    w.open(b"[", ylink)
    w.emit(b'"' + tag + b'",', ylink)
    w.ops.append((op_close, b"}", link))
    w.ops.append((op_close, b"]", ylink))
    return ylink


def _write_int(w: Writer, payload: bytes, link: object) -> None:
    """An int already checked: a bare literal inside the window, else the int tag."""
    magnitude = int.from_bytes(payload[1:], "big")
    if magnitude <= _MAX_SAFE:
        literal = str(magnitude)
        w.emit(("-" + literal if payload[0] == 0x01 else literal).encode("ascii"), link)
        return
    ylink = _envelope(w, b"int", link)
    w.emit(b'"' + _int_to_text(payload).encode("ascii") + b'"', (ylink, 1))


def _recognize(value: Tuple, label: bytes):
    """Step 1 of §2.3: the ontos/data kind ``value`` canonically is, or None."""
    try:
        if label == b"null":
            recognize_null(value)
            return ("null",)
        if label == b"bool":
            return ("bool", read_bool(value))
        if label == b"utf8-text":
            return ("text", read_text(value))
        if label == b"int":
            recognize_int(value)
            return ("int",)
        if label == b"list":
            return ("list",)
        if label == b"map":
            return ("map", read_map(value))
        if label == b"set":
            return ("set", read_set(value))
        if label == b"decimal":
            recognize_decimal(value)
            return ("decimal",)
    except DataError:
        return None
    return None


def _write_readable(w: Writer, value: Value, d: int, link: object) -> None:
    """Write ``value`` at value depth ``d``, choosing its spelling in the order of §2.3."""
    if isinstance(value, Atom):
        data = value.bytes()
        w.check(link, d, None, None, len(data))
        ylink = _envelope(w, b"bytes", link)
        w.emit(b'"' + _base64_encode(data) + b'"', (ylink, 1))
        return
    if not isinstance(value, Tuple):
        raise TypeError(f"expected an ontos Value, got {type(value).__name__}")
    items = value.items()
    head = items[0] if items else None
    if not isinstance(head, Atom):
        # Step 4: Tuple(), or a tuple whose first child is a tuple. The envelope contributes
        # nothing; the total form below checks its own nodes.
        ylink = _envelope(w, b"raw", link)
        w.ops.append((write_total, value, d, (ylink, 1)))
        return

    label = head.bytes()
    recognized = _recognize(value, label)
    ops = w.ops
    if recognized is None:
        # Step 3: a compound. Its label is a JSON string when it is well-formed UTF-8.
        arguments = items[1:]
        w.check(link, d + 1, len(items), None, len(label))
        ylink = _envelope(w, b"compound", link)
        link1 = (ylink, 1)
        if utf8_fault(label) is None:
            w.emit(_json_string(label.decode("utf-8")) + b",", link1)
        else:
            w.open(b"[", link1)
            w.emit(b'"bytes","' + _base64_encode(label) + b'"', (link1, 1))
            op_close(w, b"]", link1)
            w.emit(b",", ylink)
        link2 = (ylink, 2)
        w.open(b"[", link2)
        push_sequence(w, _write_readable, arguments, d + 1, link2, b"]", link2)
        return

    kind = recognized[0]
    if kind == "null":
        w.check(link, d + 1, 1, None, 4)
        w.emit(b"null", link)
    elif kind == "bool":
        w.check(link, d + 1, 2, None, 4)
        w.emit(b"true" if recognized[1] else b"false", link)
    elif kind == "text":
        payload = items[1].bytes()
        w.check(link, d + 1, 2, None, max(9, len(payload)))
        w.emit(_json_string(recognized[1]), link)
    elif kind == "int":
        payload = items[1].bytes()
        digits = _digit_count(int.from_bytes(payload[1:], "big"))
        w.check(link, d + 1, 2, digits, max(3, len(payload)))
        _write_int(w, payload, link)
    elif kind == "list":
        w.check(link, d + 1, len(items), None, 4)
        w.open(b"[", link)
        push_sequence(w, _write_readable, items[1:], d + 1, link, b"]", link)
    elif kind == "map":
        entries = recognized[1]
        names = []
        for key, _value in entries:
            try:
                name = read_text(key)
            except DataError:
                break
            if name == "$ontos":
                break
            names.append(name)
        m = len(entries)
        if len(names) == m:
            # Every key is text other than $ontos: an object, members in codec order.
            if m:
                key_bytes = max(len(key.at(1).bytes()) for key, _value in entries)
                w.check(link, d + 3, max(1 + m, 2), None, max(9, key_bytes))
            else:
                w.check(link, d + 1, 1, None, 3)
            w.open(b"{", link)
            ops.append((op_close, b"}", link))
            for i in range(m - 1, -1, -1):
                mlink = (link, names[i])
                ops.append((_write_readable, entries[i][1], d + 2, mlink))
                ops.append((op_emit, _json_string(names[i]) + b":", mlink))
                if i:
                    ops.append((op_emit, b",", link))
        else:
            w.check(link, d + 1, max(1 + m, 2) if m else 1, None, 3)
            ylink = _envelope(w, b"map", link)
            link1 = (ylink, 1)
            w.open(b"[", link1)
            ops.append((op_close, b"]", link1))
            for j in range(m - 1, -1, -1):
                elink = (link1, j)
                ops.append((op_close, b"]", elink))
                ops.append((_write_readable, entries[j][1], d + 2, (elink, 1)))
                ops.append((op_emit, b",", elink))
                ops.append((_write_readable, entries[j][0], d + 2, (elink, 0)))
                ops.append((_op_open, b"[", elink))
                if j:
                    ops.append((op_emit, b",", link1))
    elif kind == "set":
        elements = recognized[1]
        w.check(link, d + 1, len(items), None, 3)
        ylink = _envelope(w, b"set", link)
        link1 = (ylink, 1)
        w.open(b"[", link1)
        push_sequence(w, _write_readable, elements, d + 1, link1, b"]", link1)
    else:  # decimal
        m_payload, e_payload = items[1].at(1).bytes(), items[2].at(1).bytes()
        digits = max(
            _digit_count(int.from_bytes(m_payload[1:], "big")),
            _digit_count(int.from_bytes(e_payload[1:], "big")),
        )
        w.check(link, d + 2, 3, digits, max(7, len(m_payload), len(e_payload)))
        ylink = _envelope(w, b"decimal", link)
        w.emit(
            b'"' + _int_to_text(m_payload).encode("ascii") + b'","' + _int_to_text(e_payload).encode("ascii") + b'"',
            (ylink, 1),
        )


def render_utf8(value: Value, *, limits: Limits = DEFAULT_LIMITS) -> bytes:
    """Write ``value`` in its preferred readable spelling as UTF-8 bytes (§2, §5).

    No byte order mark, no whitespace, no trailing newline; members, entries and elements in
    codec order. Under finite limits the writer refuses as the reader would, with
    ``ProjectionError`` (code ``limit_exceeded``, a kind, no span, and an informative path in
    the output) (§9).
    """
    _require_limits(limits)
    w = Writer(limits, json_depth_bound(limits), PROFILE)
    w.ops.append((_write_readable, value, 0, None))
    return w.run()
