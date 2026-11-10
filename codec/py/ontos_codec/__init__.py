"""ontos canonical binary codec — ontos-codec-v1 (frozen).

    encode(Atom(b))            = 0x00 || uvarint(len(b)) || b
    encode(Tuple(v0..v_{n-1})) = 0x01 || uvarint(n)      || encode(v0) .. encode(v_{n-1})

uvarint is unsigned LEB128 in shortest/canonical form over the u64 domain
``[0, 2^64 - 1]`` (ontos-codec.md §3.1 / §4). The decoder rejects unknown tags,
trailing bytes, non-canonical uvarints, uvarints outside the u64 domain
(``uvarint_overflow``), and inputs exceeding the configured limits
(``limit_exceeded``).

``measure`` reports a value's canonical encoded length, its expanded occurrence
count and its height without expanding shared subtrees, against bounds the
caller states (ontos-codec.md §10, pinned by vectors/codec-measure.json).

This codec is kept beside the model (it depends on ``ontos_core``, never the
reverse). The byte mapping is frozen (any change ships as a new version).
Conformance is pinned by vectors/codec.json (codec: ``ontos-codec-v1``).

This is the Python peer of the go/rs/ts codecs (ontos-internal#60), a validation lane.
Python's native ``int`` is arbitrary precision, so this binding — like the Go
(``big.Int``) and TS (``bigint``) bindings — materializes any valid u64 length
without a native-width ceiling; the ``limit_exceeded`` resource limit is
configurable but not reached by the cross-core vectors (whose only large-value
cases are the ``>= 2^64`` ``uvarint_overflow`` family, which every core rejects
structurally).
"""

from __future__ import annotations

from typing import Dict, List, NamedTuple, Optional

from ontos_core import Atom, Tuple, Value, atom, tuple_

__all__ = [
    "DecodeError",
    "LIMIT_DECODE_DEPTH",
    "LIMIT_ATOM_BYTES",
    "LIMIT_TUPLE_ARITY",
    "LIMIT_NATIVE_WIDTH",
    "encode",
    "decode",
    "encode_uvarint",
    "MEASURE_ENCODED_BYTES",
    "MEASURE_HEIGHT",
    "MEASURE_OCCURRENCES",
    "MeasureError",
    "Measures",
    "measure",
]

_TAG_ATOM = 0x00
_TAG_TUPLE = 0x01
_DEFAULT_MAX_DEPTH = 1024

# uvarint integer domain (ontos-codec.md §3.1 / §4): unsigned values in
# [0, 2^64 - 1]. A canonical uvarint is shortest-form and at most 10 bytes.
_MAX_UVARINT_BYTES = 10
_UVARINT_CEILING = 1 << 64  # 2^64: exclusive upper bound of the u64 domain.


# The rejection categories (ontos-codec.md §4). The five byte-contract codes are
# normative and pinned by vectors/codec.json; ``limit_exceeded`` is operational
# (§4.2) and is not. The human-readable message is never normative.
_VALID_CODES = frozenset(
    {
        "unexpected_eof",
        "trailing_bytes",
        "unknown_tag",
        "non_canonical_uvarint",
        "uvarint_overflow",
        "limit_exceeded",
    }
)


# The operational bounds a ``limit_exceeded`` can name (ontos-codec.md §4.2). The
# vocabulary is append-only: a name never changes meaning, but a later version may add
# names, so treat an unrecognized kind as the generic ``limit_exceeded``.
LIMIT_DECODE_DEPTH = "decode_depth"  # nested deeper than max_depth (the root is depth 0)
LIMIT_ATOM_BYTES = "atom_bytes"  # a declared atom byte length exceeds max_atom_bytes
LIMIT_TUPLE_ARITY = "tuple_arity"  # a declared tuple arity exceeds max_tuple_arity
# A length that does not fit the native length type. Never raised here: Python's int has
# no width ceiling. It is exported so a consumer can match every kind by one name.
LIMIT_NATIVE_WIDTH = "native_width"


class DecodeError(Exception):
    """A decode rejection carrying a cross-core ``code`` (ontos-codec.md §4).

    The five byte-contract codes are the normative, vector-pinned identity of the
    failure. ``limit_exceeded`` is not: it reports that decoding stopped at an
    operational bound and says nothing about whether the input is a valid encoding.
    For it, ``limit_kind`` names the bound (§4.2); for every other code it is
    ``None``. The kind is observational, so another implementation may name a
    different bound for the same input. ``args[0]`` is the human message.
    """

    def __init__(self, code: str, message: str, *, limit_kind: Optional[str] = None) -> None:
        super().__init__(message)
        assert code in _VALID_CODES, f"unknown DecodeError code {code!r}"
        self.code = code
        self.limit_kind = limit_kind


def encode(value: Value) -> bytes:
    """Return the canonical ``ontos-codec-v1`` bytes of ``value``."""
    out = bytearray()
    _encode_into(value, out)
    return bytes(out)


# Pre-order with an explicit stack (ontos-internal#347): the depth of a value this writes is never bounded by
# Python's recursion limit. Children are pushed in reverse so they are written in order; the
# bytes are exactly the recursive walk's.
def _encode_into(value: Value, out: bytearray) -> None:
    stack: List[Value] = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, Atom):
            body = v.bytes()
            out.append(_TAG_ATOM)
            out += encode_uvarint(len(body))
            out += body
        elif isinstance(v, Tuple):
            items = v.items()
            out.append(_TAG_TUPLE)
            out += encode_uvarint(len(items))
            stack.extend(reversed(items))
        else:  # pragma: no cover - Value is closed (Atom | Tuple)
            raise TypeError("expected an ontos Value")


def encode_uvarint(n: int) -> bytes:
    """Shortest-form unsigned LEB128 of ``n`` in the u64 domain.

    Emits 7 bits per byte, little-endian, with the high bit (0x80) set on every
    byte except the last. The encoding of 0 is the single byte 0x00. Raises
    ``ValueError`` for a value outside ``[0, 2^64 - 1]`` — the encoder only ever
    sees lengths/arities of real (in-memory, hence small) values, so this guards
    a programming error, not untrusted input (decode does the input validation).
    """
    if n < 0 or n >= _UVARINT_CEILING:
        raise ValueError(f"uvarint requires a value in [0, 2^64 - 1], got {n}")
    out = bytearray()
    v = n
    while True:
        byte = v & 0x7F
        v >>= 7
        if v != 0:
            byte |= 0x80
        out.append(byte)
        if v == 0:
            break
    return bytes(out)


class _Reader:
    """A cursor over the input bytes plus the active resource limits."""

    __slots__ = ("data", "pos", "max_depth", "max_atom_bytes", "max_tuple_arity")

    def __init__(
        self,
        data: bytes,
        max_depth: int,
        max_atom_bytes: Optional[int],
        max_tuple_arity: Optional[int],
    ) -> None:
        self.data = data
        self.pos = 0
        self.max_depth = max_depth
        self.max_atom_bytes = max_atom_bytes
        self.max_tuple_arity = max_tuple_arity


def decode(
    data: bytes,
    *,
    max_depth: int = _DEFAULT_MAX_DEPTH,
    max_atom_bytes: Optional[int] = None,
    max_tuple_arity: Optional[int] = None,
) -> Value:
    """Decode exactly one ``ontos-codec-v1`` value, rejecting trailing bytes.

    On any malformed or non-canonical input raises ``DecodeError`` with the
    stable ``code`` (ontos-codec.md §4). Optional resource limits
    (``max_atom_bytes``, ``max_tuple_arity``, ``max_depth``) fail **safely** as
    ``limit_exceeded`` — operational policy, not part of the byte contract.
    """
    if not isinstance(data, (bytes, bytearray)):
        data = bytes(data)
    reader = _Reader(bytes(data), max_depth, max_atom_bytes, max_tuple_arity)
    value = _read_value(reader, 0)
    if reader.pos != len(reader.data):
        raise DecodeError("trailing_bytes", f"trailing bytes at offset {reader.pos}")
    return value


# With an explicit stack of open tuples (ontos-internal#347), never one call per level, so a value at the
# harmonized default depth decodes and one past it is ``limit_exceeded`` rather than a
# RecursionError. Each value's header is read and checked in the recursive walk's order (depth,
# then tag, then length or arity, with the same errors at the same offsets), and a completed
# value is handed to its parent, closing every tuple it fills. Mirrors codec/ts (ontos-internal#345).
def _read_value(reader: _Reader, depth: int) -> Value:
    open_: List[tuple] = []  # (items, arity) of each tuple still being filled
    while True:
        if depth + len(open_) > reader.max_depth:
            raise DecodeError(
                "limit_exceeded",
                f"maximum decode depth exceeded: {reader.max_depth}",
                limit_kind=LIMIT_DECODE_DEPTH,
            )
        if reader.pos >= len(reader.data):
            raise DecodeError("unexpected_eof", "unexpected end of input while reading tag")

        offset = reader.pos
        tag = reader.data[reader.pos]
        reader.pos += 1

        if tag == _TAG_ATOM:
            length = _read_uvarint(reader)
            if reader.max_atom_bytes is not None and length > reader.max_atom_bytes:
                raise DecodeError(
                    "limit_exceeded",
                    f"atom byte length {length} exceeds limit {reader.max_atom_bytes}",
                    limit_kind=LIMIT_ATOM_BYTES,
                )
            if reader.pos + length > len(reader.data):
                raise DecodeError("unexpected_eof", "unexpected end of input while reading atom bytes")
            start = reader.pos
            reader.pos += length
            done: Value = atom(reader.data[start:reader.pos])
        elif tag == _TAG_TUPLE:
            arity = _read_uvarint(reader)
            if reader.max_tuple_arity is not None and arity > reader.max_tuple_arity:
                raise DecodeError(
                    "limit_exceeded",
                    f"tuple arity {arity} exceeds limit {reader.max_tuple_arity}",
                    limit_kind=LIMIT_TUPLE_ARITY,
                )
            # Every encoded value is at least two bytes (tag + zero uvarint), so an
            # arity larger than half the remaining bytes is impossible. Guards
            # malformed input against a giant declared arity exhausting memory.
            max_possible_children = (len(reader.data) - reader.pos) // 2
            if arity > max_possible_children:
                raise DecodeError("unexpected_eof", "unexpected end of input while reading tuple items")
            if arity > 0:
                open_.append(([], arity))
                continue
            done = tuple_([])
        else:
            raise DecodeError("unknown_tag", f"unknown value tag 0x{tag:02x} at offset {offset}")

        while True:
            if not open_:
                return done
            items, arity = open_[-1]
            items.append(done)
            if len(items) < arity:
                break
            open_.pop()
            done = tuple_(items)


def _read_uvarint(reader: _Reader) -> int:
    start = reader.pos
    result = 0
    shift = 0
    length = 0

    while True:
        if reader.pos >= len(reader.data):
            raise DecodeError("unexpected_eof", "unexpected end of input while reading uvarint")
        byte = reader.data[reader.pos]
        reader.pos += 1
        length += 1
        result |= (byte & 0x7F) << shift
        # Any decoded value at or above 2^64 is outside the u64 domain. This
        # catches a 10th byte whose high bits push the value past the ceiling.
        if result >= _UVARINT_CEILING:
            raise DecodeError("uvarint_overflow", f"uvarint exceeds the u64 domain at offset {start}")
        if (byte & 0x80) == 0:
            break
        shift += 7
        # A canonical uvarint is at most 10 bytes; an 11th continuation byte can
        # only encode a value >= 2^64, so it is a u64-domain overflow.
        if length >= _MAX_UVARINT_BYTES:
            raise DecodeError("uvarint_overflow", f"uvarint exceeds 10 bytes at offset {start}")

    # Reject any uvarint that is not shortest-form: re-encode the value and
    # compare against the actual bytes consumed (ontos-codec.md §3).
    canonical = encode_uvarint(result)
    actual = reader.data[start:reader.pos]
    if canonical != actual:
        raise DecodeError("non_canonical_uvarint", f"non-canonical uvarint at offset {start}")

    return result


# The measures ``measure`` reports (ontos-codec.md §10), by their stable identifiers. The
# vocabulary is append-only, as the limit kinds' is: a name never changes meaning, but a
# later version may add names, so treat an unrecognized name as over limit all the same.
MEASURE_ENCODED_BYTES = "encoded_bytes"  # the length of the canonical encoding
MEASURE_HEIGHT = "height"  # how deep the value is nested, as max_depth counts it
MEASURE_OCCURRENCES = "occurrences"  # the number of values in the expanded tree


class Measures(NamedTuple):
    """A value's three measures, each exact, as ``measure`` returns them."""

    encoded_bytes: int
    occurrences: int
    height: int


class MeasureError(Exception):
    """The over-limit outcome of ``measure``.

    ``exceeded`` names every measure that exceeded its bound, in ascending order of the
    names (``encoded_bytes``, ``height``, ``occurrences``), and is never empty. It is a
    function of the value and the bounds alone (ontos-codec.md §10.2). It carries no
    numbers: a measure past its bound was not counted to the end.
    """

    def __init__(self, exceeded) -> None:
        self.exceeded = tuple(exceeded)
        super().__init__("over limit: " + ", ".join(self.exceeded))


def measure(value: Value, *, max_encoded_bytes: int, max_occurrences: int, max_height: int) -> Measures:
    """The length of ``value``'s canonical encoding, the number of values in its expanded
    tree, and its height, computed without expanding it (ontos-codec.md §10).

    Every bound is required, keyword-only and a non-negative ``int`` (``TypeError`` for
    another type, ``bool`` included; ``ValueError`` for a negative one). A measure equal to
    its bound is within it. Returns the three measures exactly when each is within its
    bound; otherwise raises ``MeasureError`` naming every measure over its bound.

    A tuple may be a child of several parents, and a chain of k such tuples can denote a
    tree whose encoding is 5·2^k − 2 bytes long. ``measure`` visits each distinct tuple
    object once and adds its measures once per incoming edge, so its work is linear in the
    distinct tuples plus their child edges, whatever the bounds. It walks with an explicit
    stack, so a value of any height can be measured. Its arithmetic saturates at each
    bound, so every number it handles stays at most a bound. Structurally equal tuples
    built separately are measured correctly, just not shared.
    """
    meter = _Meter(
        _require_bound("max_encoded_bytes", max_encoded_bytes),
        _require_bound("max_occurrences", max_occurrences),
        _require_bound("max_height", max_height),
    )
    got = meter.measure(value)
    exceeded = []
    if meter.over_bytes:
        exceeded.append(MEASURE_ENCODED_BYTES)
    if meter.over_height:
        exceeded.append(MEASURE_HEIGHT)
    if meter.over_occurrences:
        exceeded.append(MEASURE_OCCURRENCES)
    if exceeded:
        raise MeasureError(exceeded)
    return got


def _require_bound(name: str, bound: object) -> int:
    if not isinstance(bound, int) or isinstance(bound, bool):
        raise TypeError(f"{name} must be a non-negative int, got {type(bound).__name__}")
    if bound < 0:
        raise ValueError(f"{name} must be a non-negative int, got {bound}")
    return bound


def _uvarint_length(n: int) -> int:
    """The length of ``n``'s shortest-form uvarint (ontos-codec.md §3)."""
    return max(1, (n.bit_length() + 6) // 7)


class _Meter:
    """One walk: the bounds, the memo of measured tuples, and for each measure whether any
    partial result passed its bound.

    No subtree's measure is larger than the whole value's, so a partial result past a bound
    proves the value's measure is too: one flag per measure is exact, and a number held at
    its bound never changes the outcome (ontos-codec.md §10.2). The memo is keyed on
    ``id(tuple)``: every tuple stays reachable from the root for the whole walk, so no id
    is reused while the memo lives.
    """

    __slots__ = ("max_bytes", "max_occurrences", "max_height", "memo", "over_bytes", "over_occurrences", "over_height")

    def __init__(self, max_bytes: int, max_occurrences: int, max_height: int) -> None:
        self.max_bytes = max_bytes
        self.max_occurrences = max_occurrences
        self.max_height = max_height
        self.memo: Dict[int, Measures] = {}
        self.over_bytes = False
        self.over_occurrences = False
        self.over_height = False

    def _add_bytes(self, a: int, b: int) -> int:
        if a + b > self.max_bytes:
            self.over_bytes = True
            return self.max_bytes
        return a + b

    def _add_occurrences(self, a: int, b: int) -> int:
        if a + b > self.max_occurrences:
            self.over_occurrences = True
            return self.max_occurrences
        return a + b

    def _atom(self, v: Atom) -> Measures:
        n = len(v)
        return Measures(self._add_bytes(1 + _uvarint_length(n), n), self._add_occurrences(0, 1), 0)

    def _open(self, t: Tuple) -> list:
        items = t.items()
        # [tuple, items, next child, bytes, occurrences, deepest child height]
        return [t, items, 0, self._add_bytes(1, _uvarint_length(len(items))), self._add_occurrences(0, 1), 0]

    def _add_child(self, frame: list, child: Measures) -> None:
        frame[3] = self._add_bytes(frame[3], child.encoded_bytes)
        frame[4] = self._add_occurrences(frame[4], child.occurrences)
        if child.height > frame[5]:
            frame[5] = child.height

    def measure(self, value: Value) -> Measures:
        """Post-order with an explicit stack of open tuples. A tuple is opened the first
        time it is reached; it cannot be reached again while open, because a value is
        acyclic, so each distinct tuple is opened once and every later edge to it is a memo
        hit that adds its measures, height included."""
        if isinstance(value, Atom):
            return self._atom(value)
        if not isinstance(value, Tuple):
            raise TypeError("expected an ontos Value")
        stack = [self._open(value)]
        while True:
            top = stack[-1]
            items = top[1]
            if top[2] < len(items):
                child = items[top[2]]
                top[2] += 1
                if isinstance(child, Atom):
                    self._add_child(top, self._atom(child))
                else:
                    seen = self.memo.get(id(child))
                    if seen is not None:
                        self._add_child(top, seen)
                    else:
                        stack.append(self._open(child))
                continue
            height = 0
            if items:
                height = top[5] + 1
                if height > self.max_height:
                    self.over_height = True
                    height = self.max_height
            done = Measures(top[3], top[4], height)
            self.memo[id(top[0])] = done
            stack.pop()
            if not stack:
                return done
            self._add_child(stack[-1], done)
