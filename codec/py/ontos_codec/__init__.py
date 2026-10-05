"""ontos canonical binary codec — ontos-codec-v1 (frozen).

    encode(Atom(b))            = 0x00 || uvarint(len(b)) || b
    encode(Tuple(v0..v_{n-1})) = 0x01 || uvarint(n)      || encode(v0) .. encode(v_{n-1})

uvarint is unsigned LEB128 in shortest/canonical form over the u64 domain
``[0, 2^64 - 1]`` (ontos-codec.md §3.1 / §4). The decoder rejects unknown tags,
trailing bytes, non-canonical uvarints, uvarints outside the u64 domain
(``uvarint_overflow``), and inputs exceeding the configured limits
(``limit_exceeded``).

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

from typing import List, Optional

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
