"""ontos/data (L2) — registered canonical embeddings (ontos-data-v1, frozen).

    int       = Tuple(Atom("int"),       Atom(sign-magnitude bytes))
    utf8-text = Tuple(Atom("utf8-text"), Atom(valid UTF-8 bytes))
    bool      = Tuple(Atom("bool"),      Atom(0x00 | 0x01))
    list      = Tuple(Atom("list"),      elem*)
    map       = Tuple(Atom("map"),       Tuple(key, value)*)  # entries sorted by codec key bytes
    set       = Tuple(Atom("set"),       elem*)                # elements sorted by codec bytes, unique
    decimal   = Tuple(Atom("decimal"),   int(mantissa), int(exponent))  # mantissa × 10^exponent

An embedding is a recognized L1 labeled compound — a Tuple whose first child is a
registered label atom — whose payload shape is fixed by docs/spec/ontos-data.md.
``ontos/data`` adds vocabulary and producer discipline only: it introduces NO new
value and NO new identity. Every L2 value IS an L0 value; identity is L0
structural identity, unchanged (ontos-data.md §2). Each datum has exactly ONE
canonical form, so encoders normalize BEFORE building the value (§4) and readers
recognize only the already-canonical form.

Two directions per embedding:

- ``encode_<kind>`` — build the canonical L0 Value from a typed datum (producer).
- ``read_<kind>`` — recognize a well-formed canonical embedding and return the
  typed datum, or raise ``DataError`` (NOT-RECOGNIZED). Recognition is partial
  and opt-in (§1/§7): every non-canonical or malformed form is rejected as
  not-recognized — never quotiented to equal data (§2). Downward is total, upward
  is partial. ``read_*`` never raises anything but ``DataError``.

``map`` (§5.7) and ``set`` (§5.8) depend on ``ontos/codec``'s byte order over the
key/element (their entry/element order IS the codec total order), so this module
imports the codec's ``encode`` as a RUNTIME dependency.

This is the Python peer of the go/rs/ts data crates (ontos-internal#60), a validation
lane. Python's ``int`` is arbitrary precision, so — like the Go (``big.Int``) and
TS (``bigint``) bindings — ``read_int`` / ``read_decimal`` never report a
host-width resource limit; a ``> i128`` magnitude (the int_2pow128 vector) is
recognized AND materialized here. The Rust binding alone reports that
materialization as a resource limit; recognition is structural and identical
across all four (ontos-data.md §5.1).
"""

from __future__ import annotations

from typing import List, Tuple as PyTuple

from ontos_core import Atom, Tuple, Value, atom, tuple_
from ontos_codec import encode

__all__ = [
    "LABELS",
    "DataError",
    "encode_int",
    "read_int",
    "recognize_int",
    "encode_bool",
    "read_bool",
    "encode_text",
    "read_text",
    "encode_list",
    "read_list",
    "encode_map",
    "read_map",
    "encode_set",
    "read_set",
    "encode_decimal",
    "read_decimal",
    "recognize_decimal",
]

# Registered label bytes (ontos-data.md §5). These are the only labels v1 knows.
_LABEL_INT = "int"
_LABEL_BOOL = "bool"
_LABEL_TEXT = "utf8-text"
_LABEL_LIST = "list"
_LABEL_MAP = "map"
_LABEL_SET = "set"
_LABEL_DECIMAL = "decimal"
_LABEL_NULL = "null"

# The canonical ordered list of ontos-data-v1 embedding labels, in the fixed
# recognition order (ontos-data.md §5: int, utf8-text, bool, list, map, set,
# decimal, null). The single source of the registered label set and its order
# within this module; the CLI keeps its own copy by deliberate design (a parity
# test pins the copy against this). decimal (§5.9) was appended 2026-06-06 and
# null (§5.10) on 2026-06-13.
LABELS: PyTuple[str, ...] = (
    _LABEL_INT,
    _LABEL_TEXT,
    _LABEL_BOOL,
    _LABEL_LIST,
    _LABEL_MAP,
    _LABEL_SET,
    _LABEL_DECIMAL,
    _LABEL_NULL,
)

_SIGN_NONNEG = 0x00
_SIGN_NEG = 0x01


class DataError(Exception):
    """A recognition rejection: a value is not a well-formed embedding of a kind.

    ``code`` is a LANGUAGE-LOCAL diagnostic, NOT a cross-language contract: the
    four data cores expose codes on different axes and, unlike the codec's
    DecodeError codes, it is NOT pinned in the conformance vectors (recognition
    is partial/opt-in — ontos-data.md §1/§7). Use it for local diagnostics only.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


# --- int (ontos-data.md §5.1) -------------------------------------------------


def encode_int(n: int) -> Value:
    """Build the canonical ``int`` embedding for an exact, unbounded integer.

    Payload = one sign byte (0x00 non-negative, 0x01 negative) followed by the
    big-endian, minimal-length magnitude of ``|n|`` (no leading 0x00). Zero is
    exactly the single byte 0x00 (sign 0x00, empty magnitude); no negative zero.

    REJECTS ``bool`` (ontos-data.md §4.1, §5.1 producer domain). ``bool`` is a
    subclass of ``int`` in Python, so the annotation ``n: int`` admits ``True`` and a
    type checker accepts it — but ``bool`` has its own embedding (§5.3), and encoding
    ``True`` as the integer 1 succeeds with a datum the caller did not supply (§4.1
    law 2). Before this guard::

        encode_int(1)     -> Tuple(Atom("int"), Atom(00 01))
        encode_int(True)  -> Tuple(Atom("int"), Atom(00 01))   # byte-IDENTICAL
        encode_bool(True) -> Tuple(Atom("bool"), Atom(01))     # the intended value

    ``bool`` is rejected by an explicit ``isinstance(n, bool)`` test, checked BEFORE
    the general int test — an ``isinstance(n, int)`` gate alone would admit it, which
    is the whole defect. Other ``int`` subclasses (``IntEnum``, and similar) are
    ACCEPTED: they denote exact integers and no other embedding claims them, so the
    rule that matters is "does this host value denote a datum of a *different*
    embedding", not "is this the exact builtin type".

    This is the one place in the four cores where the host type system actively hides
    a domain error: Go, Rust and TypeScript all reject a boolean in an integer
    position at compile time, so no equivalent guard is needed there.
    """
    if isinstance(n, bool):
        raise DataError(
            "wrong_host_type",
            "int producer: got a bool, which has its own embedding (§5.3) — use "
            "encode_bool. bool is an int subclass in Python, so this is admitted by "
            "the annotation and would otherwise encode as the integer 0/1.",
        )
    if not isinstance(n, int):
        raise DataError(
            "wrong_host_type",
            f"int producer: expected an exact int, got {type(n).__name__}",
        )
    sign = _SIGN_NEG if n < 0 else _SIGN_NONNEG
    magnitude = _magnitude_bytes(-n if n < 0 else n)
    payload = bytes([sign]) + magnitude
    return tuple_([atom(_LABEL_INT.encode("ascii")), atom(payload)])


def _int_payload(v: Value) -> PyTuple[int, bytes]:
    """Validate the canonical ``int`` structure, returning ``(sign, magnitude)``.

    The recognition gate shared by ``recognize_int`` and ``read_int``: it runs
    every canonical-form check (shape, arity, label, sign byte, minimal
    magnitude, no negative zero) but does NOT materialize the magnitude, so it
    cannot drift from ``read_int`` on what counts as canonical.
    """
    payload = _payload_atom_bytes(v, _LABEL_INT)
    if len(payload) < 1:
        raise DataError("malformed_payload", "int payload must have at least a sign byte")
    sign = payload[0]
    if sign != _SIGN_NONNEG and sign != _SIGN_NEG:
        raise DataError("malformed_payload", f"int sign byte must be 0x00 or 0x01, got 0x{sign:02x}")
    magnitude = payload[1:]
    if len(magnitude) >= 1 and magnitude[0] == 0x00:
        raise DataError("malformed_payload", "int magnitude has a non-canonical leading 0x00 byte")
    if len(magnitude) == 0 and sign == _SIGN_NEG:
        raise DataError("malformed_payload", "int has a forbidden negative-zero payload")
    return sign, magnitude


def recognize_int(v: Value) -> None:
    """Recognize a canonical ``int`` WITHOUT materializing it into a host integer.

    Returns normally for every canonical ``int`` — including a magnitude beyond a
    bounded host integer — and raises ``DataError`` for any non-canonical form.
    Recognition is STRUCTURAL; this binding's ``int`` is unbounded so it can
    always materialize what it recognizes, but the distinction is the surface the
    tri-core CLIs use for ``read --kind int`` (ontos-data.md §5.1).
    """
    _int_payload(v)


def read_int(v: Value) -> int:
    """Recognize a canonical ``int`` and return the integer, else raise.

    Same canonical-form validation as ``recognize_int``. This binding is
    unbounded (Python ``int``), so it never reports a host-width resource limit.
    """
    sign, magnitude = _int_payload(v)
    value = int.from_bytes(magnitude, "big")
    return -value if sign == _SIGN_NEG else value


# --- bool (ontos-data.md §5.3) ------------------------------------------------


def encode_bool(b: bool) -> Value:
    """Build the canonical ``bool`` embedding: payload single byte 0x00 / 0x01."""
    return tuple_([atom(_LABEL_BOOL.encode("ascii")), atom(bytes([0x01 if b else 0x00]))])


def read_bool(v: Value) -> bool:
    """Recognize a canonical ``bool`` and return the boolean, else raise.

    Rejects: non-tuple, arity != 2, wrong label, and any payload that is not a
    single byte in {0x00, 0x01}.
    """
    payload = _payload_atom_bytes(v, _LABEL_BOOL)
    if len(payload) != 1:
        raise DataError("malformed_payload", f"bool payload must be exactly one byte, got {len(payload)}")
    marker = payload[0]
    if marker == 0x00:
        return False
    if marker == 0x01:
        return True
    raise DataError("malformed_payload", f"bool payload byte must be 0x00 or 0x01, got 0x{marker:02x}")


# --- utf8-text (ontos-data.md §5.2) -------------------------------------------


def encode_text(s: str) -> Value:
    """Build the canonical ``utf8-text`` embedding: valid UTF-8 verbatim, no NFC.

    FALLIBLE (ontos-data.md §4.1). A Python ``str`` is a sequence of code points and
    may contain a surrogate (e.g. ``"\\ud800"``, or anything produced by the
    ``surrogateescape`` error handler); surrogates are not Unicode scalar values and
    have no UTF-8 encoding, so such a string is outside the admissible domain and is
    REJECTED.

    ``str.encode("utf-8")`` already refuses these — but it raises
    ``UnicodeEncodeError``, which is a ``ValueError`` from the standard library and
    NOT part of this package's error type. A caller that correctly handles
    ``DataError`` would still crash on it. §4.1 law 3 requires the rejection to be
    reported through this profile's own error channel, so the stdlib exception is
    translated rather than propagated.

    Note the difference from the other cores, which is deliberate: Python already
    rejects (law 2 was never violated here), so this is purely a law-3 repair. Go
    emitted the bytes verbatim and TypeScript substituted U+FFFD; both were
    correctness bugs, this one is an interface bug.
    """
    try:
        payload = s.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise DataError(
            "invalid_utf8",
            f"utf8-text producer: string is not encodable as UTF-8 ({exc.reason} "
            f"at position {exc.start})",
        ) from exc
    return tuple_([atom(_LABEL_TEXT.encode("ascii")), atom(payload)])


def read_text(v: Value) -> str:
    """Recognize a canonical ``utf8-text`` and return the string, else raise.

    Rejects: non-tuple, arity != 2, wrong label, and any payload that is not
    valid UTF-8. The empty string is accepted.
    """
    payload = _payload_atom_bytes(v, _LABEL_TEXT)
    try:
        # strict (the default) raises UnicodeDecodeError on any invalid sequence —
        # the readText rejection condition (ontos-data.md §5.2).
        return payload.decode("utf-8")
    except UnicodeDecodeError:
        raise DataError("invalid_utf8", "utf8-text payload is not valid UTF-8") from None


# --- list (ontos-data.md §5.5) ------------------------------------------------


def encode_list(elements: List[Value]) -> Value:
    """Build the canonical ``list`` embedding: the ``list`` label then the elements.

    Elements are arbitrary L0 values, each expected to be already in its own
    canonical form (the value-not-position rule, §2.1). Order and multiplicity
    are identity; the list is never sorted or deduplicated. Empty list is
    ``Tuple(Atom("list"))``.
    """
    return tuple_([atom(_LABEL_LIST.encode("ascii")), *elements])


def read_list(v: Value) -> List[Value]:
    """Recognize a canonical ``list`` and return its elements, else raise.

    Rejects: non-tuple, arity 0 (no label), and wrong label — in particular the
    bare unlabeled ``Tuple(elem*)`` form is NOT a list (§5.5). No per-element
    validation is performed; elements are returned verbatim.
    """
    if not isinstance(v, Tuple):
        raise DataError("not_a_tuple", "list must be a tuple")
    items = v.items()
    if len(items) < 1:
        raise DataError("wrong_arity", "list must have at least the label child")
    _expect_label(items[0], _LABEL_LIST)
    return list(items[1:])


# --- map (ontos-data.md §5.7) -------------------------------------------------


def encode_map(entries: List[PyTuple[Value, Value]]) -> Value:
    """Build the canonical ``map`` embedding: ``map`` label then arity-2 entries.

    Entries are sorted STRICTLY ascending by the ``ontos-codec-v1`` byte encoding
    of the key (the codec total order, §6) — by key alone, no value tiebreak.
    FALLIBLE: two entries with EQUAL key encodings raise ``DataError`` rather than
    silently picking a winner (the producer must resolve duplicate intent, §5.7).
    """
    keyed = [(encode(key), key, value) for key, value in entries]
    keyed.sort(key=lambda triple: triple[0])
    for i in range(1, len(keyed)):
        if keyed[i - 1][0] == keyed[i][0]:
            raise DataError("duplicate_key", "map has two entries with equal key encodings")
    children: List[Value] = [atom(_LABEL_MAP.encode("ascii"))]
    for _bytes, key, value in keyed:
        children.append(tuple_([key, value]))
    return tuple_(children)


def read_map(v: Value) -> List[PyTuple[Value, Value]]:
    """Recognize a canonical ``map`` and return its (key, value) entries, else raise.

    One left-to-right pass (§5.7): (1) ``v`` is a Tuple of arity >= 1 whose
    child0 is Atom("map"); (2) arity 1 => the empty map; (3) every later child is
    a Tuple of arity EXACTLY 2; (4) for each entry after the first, require
    ``encode(prevKey) < encode(key)`` STRICTLY — equal => duplicate, greater =>
    unsorted. No recursion into key/value sub-embedding canonicality.
    """
    if not isinstance(v, Tuple):
        raise DataError("not_a_tuple", "map must be a tuple")
    items = v.items()
    if len(items) < 1:
        raise DataError("wrong_arity", "map must have at least the label child")
    _expect_label(items[0], _LABEL_MAP)

    entries: List[PyTuple[Value, Value]] = []
    prev_key_bytes = None
    for i in range(1, len(items)):
        entry = items[i]
        if not isinstance(entry, Tuple) or len(entry) != 2:
            raise DataError("malformed_entry", f"map entry {i - 1} must be a tuple of arity 2")
        key = entry.at(0)
        value = entry.at(1)
        key_bytes = encode(key)
        if prev_key_bytes is not None:
            if prev_key_bytes == key_bytes:
                raise DataError("duplicate_key", f"map entry {i - 1} repeats the previous key")
            if prev_key_bytes > key_bytes:
                raise DataError("unsorted_entries", f"map entry {i - 1} key is out of ascending order")
        entries.append((key, value))
        prev_key_bytes = key_bytes
    return entries


# --- set (ontos-data.md §5.8) -------------------------------------------------


def encode_set(elements: List[Value]) -> Value:
    """Build the canonical ``set`` embedding: ``set`` label then sorted elements.

    Elements are sorted STRICTLY ascending by the ``ontos-codec-v1`` byte
    encoding of the whole element (§6). ``map``'s key discipline with no values.
    FALLIBLE: two elements with EQUAL encodings raise ``DataError`` rather than
    silently dropping one (the producer must dedup, §5.8).
    """
    keyed = [(encode(element), element) for element in elements]
    keyed.sort(key=lambda pair: pair[0])
    for i in range(1, len(keyed)):
        if keyed[i - 1][0] == keyed[i][0]:
            raise DataError("duplicate_element", "set has two elements with equal encodings")
    children: List[Value] = [atom(_LABEL_SET.encode("ascii"))]
    for _bytes, element in keyed:
        children.append(element)
    return tuple_(children)


def read_set(v: Value) -> List[Value]:
    """Recognize a canonical ``set`` and return its elements in order, else raise.

    One left-to-right pass (§5.8): (1) ``v`` is a Tuple of arity >= 1 whose
    child0 is Atom("set"); (2) arity 1 => the empty set; (3) for each element
    after the first, require ``encode(prev) < encode(elem)`` STRICTLY — equal =>
    duplicate, greater => unsorted. No recursion into element canonicality.
    """
    if not isinstance(v, Tuple):
        raise DataError("not_a_tuple", "set must be a tuple")
    items = v.items()
    if len(items) < 1:
        raise DataError("wrong_arity", "set must have at least the label child")
    _expect_label(items[0], _LABEL_SET)

    elements: List[Value] = []
    prev_bytes = None
    for i in range(1, len(items)):
        element = items[i]
        element_bytes = encode(element)
        if prev_bytes is not None:
            if prev_bytes == element_bytes:
                raise DataError("duplicate_element", f"set element {i - 1} repeats the previous element")
            if prev_bytes > element_bytes:
                raise DataError("unsorted_elements", f"set element {i - 1} is out of ascending order")
        elements.append(element)
        prev_bytes = element_bytes
    return elements


# --- decimal (ontos-data.md §5.9) ---------------------------------------------


def _decimal_parts(v: Value) -> PyTuple[Value, Value]:
    """Validate the canonical ``decimal`` structure, returning its int children.

    The recognition gate shared by ``recognize_decimal`` and ``read_decimal``:
    shape (arity-3 tuple, ``decimal`` label) + both children canonical ``int``s
    (``_int_payload``, structural so a beyond-host child is still accepted) + the
    canonical-decimal rule — zero is ``decimal(int 0, int 0)``, a non-zero
    mantissa is not divisible by 10 (decided on the magnitude bytes mod 10).

    Unlike list/map/set, ``decimal`` RECURSES into its children: it is a scalar,
    so one-spelling-per-value requires canonical-``int`` children (§5.9).
    """
    if not isinstance(v, Tuple):
        raise DataError("not_a_tuple", "decimal must be a tuple")
    items = v.items()
    if len(items) != 3:
        raise DataError("wrong_arity", f"decimal must have arity 3, got {len(items)}")
    _expect_label(items[0], _LABEL_DECIMAL)
    mantissa = items[1]
    exponent = items[2]
    try:
        _sign_m, mantissa_mag = _int_payload(mantissa)
        _sign_e, exponent_mag = _int_payload(exponent)
    except DataError:
        raise DataError(
            "malformed_payload", "decimal mantissa and exponent must each be a canonical int"
        ) from None
    if len(mantissa_mag) == 0:
        # mantissa == 0 => the exponent must be canonical zero (empty magnitude).
        if len(exponent_mag) != 0:
            raise DataError("malformed_payload", "decimal zero mantissa requires a zero exponent")
    elif _magnitude_mod10(mantissa_mag) == 0:
        raise DataError(
            "malformed_payload", "decimal non-zero mantissa is divisible by 10 (trailing base-10 zero)"
        )
    return mantissa, exponent


def encode_decimal(mantissa: int, exponent: int) -> Value:
    """Build the canonical ``decimal`` embedding for ``mantissa × 10^exponent``.

    ``Tuple(Atom("decimal"), int(mantissa), int(exponent))`` (§5.9). The producer
    normalizes first (``_normalize_decimal``): a non-zero mantissa is stripped of
    trailing base-10 zeros into the exponent, and zero is ``decimal(int 0, int
    0)``. The children are the full canonical ``int`` embedding (value-not-
    position rule, §2.1).
    """
    norm_mantissa, norm_exponent = _normalize_decimal(mantissa, exponent)
    return tuple_(
        [
            atom(_LABEL_DECIMAL.encode("ascii")),
            encode_int(norm_mantissa),
            encode_int(norm_exponent),
        ]
    )


def recognize_decimal(v: Value) -> None:
    """Recognize a canonical ``decimal`` WITHOUT materializing its int children.

    Structural, like ``recognize_int``; returns normally for every canonical
    ``decimal`` (including a mantissa/exponent beyond a bounded host width) and
    raises ``DataError`` otherwise. The surface the tri-core CLIs use for ``read
    --kind decimal`` (§5.9).
    """
    _decimal_parts(v)


def read_decimal(v: Value) -> PyTuple[int, int]:
    """Recognize a canonical ``decimal`` and return ``(mantissa, exponent)``, else raise.

    The value is ``mantissa × 10^exponent``. Same validation as
    ``recognize_decimal``. This binding is unbounded (Python ``int``), so it never
    reports a host-width resource limit.
    """
    mantissa, exponent = _decimal_parts(v)
    return read_int(mantissa), read_int(exponent)


# --- null (ontos-data.md §5.10) -----------------------------------------------


def encode_null() -> Value:
    """Build the canonical ``null`` embedding: ``Tuple(Atom("null"))``.

    A nullary compound — the ``null`` label with NO payload children (tuple arity
    exactly 1). ``null`` is the single canonical spelling of present-but-no-value
    and its only inhabitant (there is no value to vary), so ``encode_null`` takes no
    argument and always returns the same value. Its byte form is fixed by structure
    alone, so — like ``list`` and ``bool`` — it is codec-independent and not
    codec-version-relative (§5.10).
    """
    return tuple_([atom(_LABEL_NULL.encode("ascii"))])


def recognize_null(v: Value) -> None:
    """Recognize the canonical ``null`` embedding, else raise ``DataError``.

    Structural: ``v`` must be a tuple of arity EXACTLY 1 whose only child is
    ``Atom("null")``. Any payload (arity > 1) is NOT a well-formed ``null`` — it
    remains a valid L0 value, merely unrecognized (guardrail 1: exactly one no-value,
    forever). The bare unlabeled arity-0 tuple and a bare ``Atom("null")`` are
    likewise not a ``null``. The surface the tri-core CLIs use for ``read --kind
    null``; ``null`` carries no payload to materialize, so ``read_null`` is its alias.
    """
    if not isinstance(v, Tuple):
        raise DataError("not_a_tuple", "null must be a tuple")
    items = v.items()
    if len(items) != 1:
        raise DataError("wrong_arity", f"null must have arity 1, got {len(items)}")
    _expect_label(items[0], _LABEL_NULL)


def read_null(v: Value) -> None:
    """Recognize the canonical ``null`` embedding (returns ``None``), else raise.

    ``null`` is present-but-no-value, so there is nothing to return beyond the
    recognition decision; identical validation to ``recognize_null`` (recognize and
    read coincide, as for the empty containers).
    """
    recognize_null(v)


# --- internal helpers ---------------------------------------------------------


def _payload_atom_bytes(v: Value, label: str) -> bytes:
    """Shared shape check for the scalar embeddings: arity-2 tuple with ``label``.

    Returns the payload atom's bytes; raises ``DataError`` on a non-tuple, wrong
    arity, wrong label, or a non-atom payload child.
    """
    if not isinstance(v, Tuple):
        raise DataError("not_a_tuple", f"{label} must be a tuple")
    items = v.items()
    if len(items) != 2:
        raise DataError("wrong_arity", f"{label} must have arity 2, got {len(items)}")
    _expect_label(items[0], label)
    payload = items[1]
    if not isinstance(payload, Atom):
        raise DataError("malformed_payload", f"{label} payload must be an atom")
    return payload.bytes()


def _expect_label(child: Value, label: str) -> None:
    """Assert ``child`` is an Atom carrying exactly the expected label bytes."""
    if not isinstance(child, Atom):
        raise DataError("wrong_label", f"{label} label child must be an atom")
    if child.bytes() != label.encode("ascii"):
        raise DataError("wrong_label", f'expected label "{label}"')


def _magnitude_bytes(value: int) -> bytes:
    """Big-endian, minimal-length magnitude of a non-negative int; 0 -> empty."""
    if value == 0:
        return b""
    return value.to_bytes((value.bit_length() + 7) // 8, "big")


def _magnitude_mod10(magnitude: bytes) -> int:
    """``|n| mod 10`` for a big-endian magnitude (empty = 0), folded on the bytes.

    Computed byte-by-byte so it is independent of any host integer width (§5.9):
    ``rem = (rem*256 + b) mod 10``.
    """
    rem = 0
    for b in magnitude:
        rem = (rem * 256 + b) % 10
    return rem


def _normalize_decimal(mantissa: int, exponent: int) -> PyTuple[int, int]:
    """Normalize ``(mantissa, exponent)`` to the canonical decimal pair (§5.9).

    A non-zero mantissa is stripped of trailing base-10 zeros (each carried into
    the exponent); zero is ``(0, 0)``.
    """
    if mantissa == 0:
        return 0, 0
    m = mantissa
    e = exponent
    while m % 10 == 0:
        m //= 10
        e += 1
    return m, e
