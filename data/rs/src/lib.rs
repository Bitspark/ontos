//! ontos/data (L2) — registered canonical embeddings (`ontos-data-v1`, frozen).
//!
//! Freeze provenance: the v1 scalars and `list` (`int`, `utf8-text`, `bool`, `list`)
//! were frozen 2026-05-31; the structural pair `map` (§5.7) and `set` (§5.8) were
//! frozen 2026-06-01 (see `docs/spec/ontos-data.md`).
//!
//! ```text
//! int       = Tuple(Atom("int"),       Atom(sign || big-endian minimal magnitude))
//! utf8-text = Tuple(Atom("utf8-text"), Atom(valid UTF-8 bytes verbatim))
//! bool      = Tuple(Atom("bool"),      Atom(0x00 = false | 0x01 = true))
//! list      = Tuple(Atom("list"),      elem_0, ..., elem_{n-1})
//! map       = Tuple(Atom("map"),       Tuple(k_0, v_0), ..., Tuple(k_{n-1}, v_{n-1}))
//! set       = Tuple(Atom("set"),       elem_0, ..., elem_{n-1})
//! decimal   = Tuple(Atom("decimal"),   int(mantissa), int(exponent))   // mantissa × 10^exponent
//! ```
//!
//! An embedding is a way of *writing* a common datum — an integer, a text string,
//! a boolean, an ordered list — as an ordinary `ontos/core` value. This crate adds
//! **vocabulary and producer discipline only**: it introduces no new value and no
//! new equality. Identity is L0 structural identity, unchanged; each datum has
//! **exactly one** canonical form.
//!
//! Two directions per embedding:
//!
//! - **encode** builds the canonical L0 [`Value`] from a typed datum (producer
//!   side; it normalizes before building).
//! - **read** recognizes whether a [`Value`] is a *well-formed canonical*
//!   embedding of that kind and returns the typed datum, or signals
//!   [`DataError`] when it is not. Recognition is **partial and opt-in**: a
//!   non-canonical or malformed spelling is rejected as not-recognized, never
//!   quotiented to equal the datum. `read` never panics.
//!
//! ## `int` is unbounded in principle; this crate exposes `i128`
//!
//! The `int` embedding is an exact, **unbounded-in-principle** integer (§5.1).
//! This crate's typed surface is the widest primitive, [`i128`]. A canonical `int`
//! value whose magnitude exceeds the [`i128`] range is still well-formed at L0 and
//! is *recognized* as a canonical int — it simply cannot be materialized into this
//! crate's host integer type, so [`read_int`] returns [`DataError::IntOutOfRange`]
//! (a resource-limit condition) rather than panicking. This is the exact analog of
//! `ontos-codec`'s native-width materialization limit (a valid `u64` that exceeds an
//! implementation's usable length type is `limit_exceeded`, not a domain error): the
//! frozen byte form is unbounded, while a given binding exposes a bounded host type.
//! Bindings over an arbitrary-precision type (the TS `bigint` and Go `big.Int`
//! bindings) carry the full range. (`encode` handles `i128::MIN` correctly: its
//! magnitude is `2^127`, which fits in `u128`.) [`recognize_int`] answers the
//! *structural* question — is this a canonical `int`? — without materializing, so it
//! accepts a `> i128` magnitude that [`read_int`] reports as `IntOutOfRange`; this is
//! the recognition surface every binding agrees on.
//!
//! For producers and consumers that carry the full **unbounded** range (an
//! arbitrary-precision `BigInt`/`*big.Int` bridge), the **byte-level** pair
//! [`encode_int_bytes`] / [`read_int_bytes`] exposes the §5.1 payload — a sign plus
//! big-endian-minimal magnitude — directly, with no [`i128`] materialization and so no
//! `IntOutOfRange`. `read_int_bytes` recognizes every canonical `int` (the
//! [`recognize_int`] surface) and returns the sign + magnitude bytes; `encode_int_bytes`
//! builds the canonical `int` from those parts and **rejects** a non-minimal or
//! negative-zero magnitude (§4), so it cannot mint a non-canonical embedding. These let a
//! consumer reach the byte form without re-deriving it or structurally unwrapping an
//! `encode_int` result; for an in-range value they agree byte-for-byte with `encode_int` /
//! `read_int`.
//!
//! `map` (§5.7) is the **keyed structural** embedding, frozen 2026-06-01: a label
//! `map` followed by `n` exactly-arity-2 `Tuple(key, value)` entries, sorted strictly
//! ascending by the `ontos-codec-v1` byte order on the **key** with duplicate keys
//! forbidden. It is the first embedding whose canonical form depends on the codec
//! (its entry order *is* the codec's total order), so this crate depends on
//! `ontos-codec` at runtime and `map`-over-v1 is codec-version-relative.
//!
//! `set` (§5.8) is the **unique structural** embedding, frozen 2026-06-01: a label
//! `set` followed by `n` **elements** (single L0 values, not entries) sorted strictly
//! ascending by the `ontos-codec-v1` byte order on the **whole element** with
//! duplicate elements forbidden. It is `map`'s key-discipline with no values — the
//! unordered-unique sibling of `list`/`map` — and is codec-version-relative like `map`.
//!
//! `decimal` (§5.9) is the **fourth scalar**, frozen 2026-06-06: a label `decimal`
//! followed by two `int` children, the value `mantissa × 10^exponent`. A non-zero
//! mantissa is not divisible by 10 (no trailing base-10 zero) and zero is
//! `decimal(int 0, int 0)`, so each decimal has one canonical spelling. Unlike the
//! containers `list`/`map`/`set`, `decimal` **recurses** — its children must be
//! canonical `int`s (the scalar discipline). It is codec-**in**dependent (its canonical
//! form is purely structural) and mirrors `int`'s recognize/read split:
//! [`recognize_decimal`] is structural (host-width-independent), [`read_decimal`]
//! materializes to `(i128, i128)` and returns `IntOutOfRange` past host width, and
//! [`encode_decimal`] is likewise fallible at the (astronomically large) exponent
//! host-width edge rather than overflowing.
//!
//! The byte forms are normative in `docs/spec/ontos-data.md` and pinned by
//! `vectors/data.json`; changing one is a breaking change shipped as a new version,
//! never an edit.

use core::fmt;
use ontos_codec::encode as codec_encode;
use ontos_core::{Atom, Tuple, Value};

const LABEL_INT: &[u8] = b"int";
const LABEL_BOOL: &[u8] = b"bool";
const LABEL_TEXT: &[u8] = b"utf8-text";
const LABEL_LIST: &[u8] = b"list";
const LABEL_MAP: &[u8] = b"map";
const LABEL_SET: &[u8] = b"set";
const LABEL_DECIMAL: &[u8] = b"decimal";
const LABEL_NULL: &[u8] = b"null";

/// The canonical ordered list of `ontos-data-v1` embedding labels, in the fixed
/// recognition order (§5: `int`, `utf8-text`, `bool`, `list`, `map`, `set`, `decimal`,
/// `null`). This is the ONE source of the registered label set and its order within
/// this crate, pinned against the actual `read_*` recognizers by
/// `labels_match_recognized_order`. `decimal` (§5.9) was appended 2026-06-06 and `null`
/// (§5.10) on 2026-06-13; the order carries no meaning beyond the recognition sequence,
/// so a new label appends rather than reordering.
///
/// The CLI keeps its own copy of this order by deliberate design (so it does not
/// depend on this being exported); a cli-side parity test pins that copy against
/// `LABELS`. The order is part of the CLI's `recognized` JSON contract, so drift is a
/// real, CI-caught parity bug — hence the single source here.
pub const LABELS: [&str; 8] = [
    "int",
    "utf8-text",
    "bool",
    "list",
    "map",
    "set",
    "decimal",
    "null",
];

const SIGN_NONNEG: u8 = 0x00;
const SIGN_NEG: u8 = 0x01;

/// Not-recognized categories for `read_*`. Every variant means "this `Value` is not
/// a well-formed canonical embedding of the requested kind" — it remains a perfectly
/// valid L0 value (§2). The `Display` message is diagnostic only.
///
/// The [`code()`](DataError::code) string is a LANGUAGE-LOCAL diagnostic, NOT a
/// cross-language contract: the three data cores expose codes on different axes (this
/// crate returns a failure-reason set; Go returns the rejected embedding *kind*; TS
/// returns a *different* failure-reason set), and — unlike `ontos-codec`'s
/// `DecodeError` — these codes are NOT pinned in the conformance vectors, because
/// recognition is partial and opt-in (§1, §7). Use it for local diagnostics only; do
/// not rely on it across cores or as a stable wire contract.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DataError {
    /// The value's shape is not the embedding's shape: not a tuple, wrong arity,
    /// a non-atom where an atom is required, or a missing/mismatched label.
    NotRecognized {
        /// The embedding kind the caller asked `read` to recognize.
        kind: &'static str,
    },
    /// The shape matched but the payload bytes are not the canonical form for this
    /// kind (e.g. a bad sign byte, a leading-zero or negative-zero `int` magnitude,
    /// a multi-byte `bool`, or invalid UTF-8 for `utf8-text`).
    NonCanonicalPayload {
        /// The embedding kind the caller asked `read` to recognize.
        kind: &'static str,
    },
    /// A well-formed canonical `int` whose magnitude exceeds the `i128` range this
    /// crate exposes. The value is valid at L0; it simply does not fit the typed
    /// surface. Never a panic.
    IntOutOfRange,
    /// `read_map`: an entry child is not an exactly-arity-2 `Tuple(key, value)` — a
    /// non-tuple child, a flat key/value child, or an entry of arity != 2 (§5.7).
    /// The value remains a valid L0 value, merely not a well-formed `map`.
    MalformedEntry,
    /// `read_map`: two adjacent entries have equal key encodings — the same key
    /// appears twice. Duplicate keys are forbidden (§5.7); never last/first-wins.
    /// (`encode_map` returns this when the producer hands it two equal keys.)
    DuplicateKey,
    /// `read_map`: entries are not strictly ascending by the `ontos-codec-v1` byte
    /// order on the key (an out-of-order adjacent pair). The canonical form is the
    /// single ascending arrangement (§5.7).
    UnsortedEntries,
    /// `read_set`: two adjacent elements have equal encodings — the same element
    /// appears twice. Duplicate elements are forbidden (§5.8); never deduplicated.
    /// (`encode_set` returns this when the producer hands it two equal elements.)
    DuplicateElement,
    /// `read_set`: elements are not strictly ascending by the `ontos-codec-v1` byte
    /// order on the whole element (an out-of-order adjacent pair). The canonical form
    /// is the single ascending arrangement (§5.8).
    UnsortedElements,
}

impl DataError {
    /// The language-local diagnostic not-recognized code (see the type-level note:
    /// NOT cross-language, NOT vector-pinned).
    pub fn code(&self) -> &'static str {
        match self {
            DataError::NotRecognized { .. } => "not_recognized",
            DataError::NonCanonicalPayload { .. } => "non_canonical_payload",
            DataError::IntOutOfRange => "int_out_of_range",
            DataError::MalformedEntry => "malformed_entry",
            DataError::DuplicateKey => "duplicate_key",
            DataError::UnsortedEntries => "unsorted_entries",
            DataError::DuplicateElement => "duplicate_element",
            DataError::UnsortedElements => "unsorted_elements",
        }
    }
}

impl fmt::Display for DataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DataError::NotRecognized { kind } => {
                write!(f, "value is not a well-formed {kind} embedding")
            }
            DataError::NonCanonicalPayload { kind } => {
                write!(f, "non-canonical {kind} payload")
            }
            DataError::IntOutOfRange => {
                write!(f, "canonical int magnitude exceeds the i128 range")
            }
            DataError::MalformedEntry => {
                write!(f, "map entry is not an arity-2 (key, value) tuple")
            }
            DataError::DuplicateKey => {
                write!(f, "map has a duplicate key (equal key encodings)")
            }
            DataError::UnsortedEntries => {
                write!(
                    f,
                    "map entries are not strictly ascending by codec key order"
                )
            }
            DataError::DuplicateElement => {
                write!(f, "set has a duplicate element (equal element encodings)")
            }
            DataError::UnsortedElements => {
                write!(
                    f,
                    "set elements are not strictly ascending by codec element order"
                )
            }
        }
    }
}

impl std::error::Error for DataError {}

// ----- shared shape helpers -----

/// Recognize `Tuple(Atom(label), payload...)` and return the payload children,
/// or `NotRecognized` if `v` is not a tuple whose first child is exactly `label`.
fn read_labeled<'a>(
    v: &'a Value,
    label: &[u8],
    kind: &'static str,
) -> Result<&'a [Value], DataError> {
    let tuple = v.as_tuple().ok_or(DataError::NotRecognized { kind })?;
    let items = tuple.items();
    let head = items
        .first()
        .and_then(Value::as_atom)
        .ok_or(DataError::NotRecognized { kind })?;
    if head.bytes() != label {
        return Err(DataError::NotRecognized { kind });
    }
    Ok(&items[1..])
}

/// Recognize a scalar embedding `Tuple(Atom(label), Atom(payload))` (arity 2) and
/// return the single payload atom's bytes.
fn read_scalar_payload<'a>(
    v: &'a Value,
    label: &[u8],
    kind: &'static str,
) -> Result<&'a [u8], DataError> {
    let rest = read_labeled(v, label, kind)?;
    let [payload] = rest else {
        return Err(DataError::NotRecognized { kind });
    };
    let atom = payload.as_atom().ok_or(DataError::NotRecognized { kind })?;
    Ok(atom.bytes())
}

fn scalar(label: &[u8], payload: Vec<u8>) -> Value {
    Value::Tuple(Tuple::new(vec![
        Value::Atom(Atom::new(label.to_vec())),
        Value::Atom(Atom::new(payload)),
    ]))
}

// ----- int (spec 5.1) -----

/// Build the canonical `int` value: `Tuple(Atom("int"), Atom(sign || magnitude))`.
///
/// `sign` is `0x00` for non-negative, `0x01` for negative; `magnitude` is `|n|` as
/// big-endian bytes with leading zero bytes stripped (empty for zero). Zero is the
/// single payload byte `0x00`. `i128::MIN` is handled correctly via `unsigned_abs`
/// (its magnitude `2^127` fits in `u128`).
pub fn encode_int(n: i128) -> Value {
    let sign = if n < 0 { SIGN_NEG } else { SIGN_NONNEG };
    let magnitude = n.unsigned_abs().to_be_bytes();
    // Strip leading zero bytes; zero yields an empty magnitude.
    let start = magnitude
        .iter()
        .position(|&b| b != 0)
        .unwrap_or(magnitude.len());
    let mut payload = Vec::with_capacity(1 + (magnitude.len() - start));
    payload.push(sign);
    payload.extend_from_slice(&magnitude[start..]);
    scalar(LABEL_INT, payload)
}

/// Validate the canonical `int` structure and return `(sign, magnitude)` if `v` is a
/// well-formed canonical `int` — for **any** magnitude, including one beyond what a
/// host integer type can hold. This is the recognition gate shared by
/// [`recognize_int`] and [`read_int`]: it performs every canonical-form check (shape,
/// label, sign byte, minimal magnitude, no negative zero) but does **not** materialize
/// the magnitude, so it succeeds regardless of host width. Sharing this between the
/// recognizer and the reader guarantees the two can never disagree on what is canonical.
fn int_payload(v: &Value) -> Result<(u8, &[u8]), DataError> {
    const KIND: &str = "int";
    let payload = read_scalar_payload(v, LABEL_INT, KIND)?;

    let (&sign, magnitude) = payload
        .split_first()
        .ok_or(DataError::NonCanonicalPayload { kind: KIND })?;
    if sign != SIGN_NONNEG && sign != SIGN_NEG {
        return Err(DataError::NonCanonicalPayload { kind: KIND });
    }
    // Minimal magnitude: no leading 0x00 byte.
    if magnitude.first() == Some(&0x00) {
        return Err(DataError::NonCanonicalPayload { kind: KIND });
    }
    // No negative zero: sign 0x01 with empty magnitude is not canonical.
    if magnitude.is_empty() && sign == SIGN_NEG {
        return Err(DataError::NonCanonicalPayload { kind: KIND });
    }
    Ok((sign, magnitude))
}

/// Recognize a canonical `int` value **without materializing it** into a host integer
/// type. Returns `Ok(())` for every canonical `int` — including a magnitude beyond the
/// `i128` range that [`read_int`] cannot return — and a not-recognized [`DataError`]
/// for any non-canonical form.
///
/// Recognition is **structural**: it answers "does `v` have the frozen canonical `int`
/// form?", which is distinct from materialization ("can this binding's host integer
/// type hold it?"). A `> i128` canonical int is *recognized* here yet is a resource
/// limit for [`read_int`] (§5.1; the int-layer analog of `ontos-codec`'s
/// `limit_exceeded`). This is the surface the `ontos` CLI's `read --kind int` uses, so
/// every binding agrees on recognition regardless of its host integer width. Never
/// panics.
pub fn recognize_int(v: &Value) -> Result<(), DataError> {
    int_payload(v).map(|_| ())
}

/// Recognize a canonical `int` value and return it as an `i128`.
///
/// Performs the same canonical-form validation as [`recognize_int`] (wrong shape/label,
/// an empty payload, a sign byte outside `{0x00, 0x01}`, a leading-zero magnitude, and
/// the negative-zero spelling are all not-recognized), then materializes the magnitude.
/// A canonical magnitude that exceeds the `i128` range yields [`DataError::IntOutOfRange`]
/// — a resource limit, not a not-recognized rejection (the value is still accepted by
/// [`recognize_int`]) — never a panic.
pub fn read_int(v: &Value) -> Result<i128, DataError> {
    let (sign, magnitude) = int_payload(v)?;
    if magnitude.len() > core::mem::size_of::<u128>() {
        return Err(DataError::IntOutOfRange);
    }

    // Reconstruct the magnitude into a u128 (big-endian, right-aligned).
    let mut mag: u128 = 0;
    for &b in magnitude {
        mag = (mag << 8) | u128::from(b);
    }

    if sign == SIGN_NEG {
        // |i128::MIN| = 2^127 fits in u128 but not in i128 as a positive; negate in
        // the unsigned domain, then cast. mag <= 2^127 is in range; mag > 2^127 is not.
        match i128::try_from(mag) {
            Ok(pos) => Ok(-pos),
            Err(_) => {
                // mag == 2^127 is exactly i128::MIN; anything larger is out of range.
                if mag == 1u128 << 127 {
                    Ok(i128::MIN)
                } else {
                    Err(DataError::IntOutOfRange)
                }
            }
        }
    } else {
        i128::try_from(mag).map_err(|_| DataError::IntOutOfRange)
    }
}

/// Build the canonical `int` value directly from a **sign + big-endian-minimal
/// magnitude** — the §5.1 payload at byte level, with no host integer width ceiling.
///
/// This is the unbounded sibling of [`encode_int`]: where `encode_int` takes an
/// [`i128`] and derives the payload, this takes the payload's two parts and assembles
/// `Tuple(Atom("int"), Atom(sign ‖ magnitude))`. `negative` selects the sign byte
/// (`0x01` negative, `0x00` non-negative); `magnitude` is `|n|` as big-endian bytes.
///
/// It enforces the producer-normalizes rule (§4) so it **cannot mint a non-canonical
/// embedding**: `magnitude` MUST already be minimal (no leading `0x00` byte) and the
/// negative-zero spelling is forbidden (`negative` true with an empty magnitude). A
/// caller that hands it a non-minimal or negative-zero magnitude gets
/// [`DataError::NonCanonicalPayload`] rather than a silently-fixed or wrong-canonical
/// value — the produced `Value` is byte-identical to what `encode_int` would build for
/// the same integer (pinned by the in-range agreement test), and round-trips through
/// [`read_int_bytes`]. The empty magnitude with `negative` false is canonical zero.
///
/// This exists because the byte form is **unbounded** (§5.1) while `encode_int`'s host
/// type stops at [`i128`]: an arbitrary-precision producer (a `BigInt`/`*big.Int`
/// bridge) holds the sign + magnitude bytes already and would otherwise have to either
/// route through `encode_int` only in the i128 range and hand-derive the §5.1 byte form
/// for larger values, or structurally unwrap an `encode_int` result to reach the payload
/// — exactly the per-consumer re-derivation this API removes. Never panics.
pub fn encode_int_bytes(negative: bool, magnitude: &[u8]) -> Result<Value, DataError> {
    const KIND: &str = "int";
    // Minimal magnitude: no leading 0x00 byte (the §5.1 producer-normalizes rule).
    if magnitude.first() == Some(&0x00) {
        return Err(DataError::NonCanonicalPayload { kind: KIND });
    }
    // No negative zero: an empty magnitude is zero, which is canonically non-negative.
    if magnitude.is_empty() && negative {
        return Err(DataError::NonCanonicalPayload { kind: KIND });
    }
    let sign = if negative { SIGN_NEG } else { SIGN_NONNEG };
    let mut payload = Vec::with_capacity(1 + magnitude.len());
    payload.push(sign);
    payload.extend_from_slice(magnitude);
    Ok(scalar(LABEL_INT, payload))
}

/// Recognize a canonical `int` value and return `(negative, magnitude)` — the §5.1
/// payload at byte level, with **no `i128` materialization** and thus no
/// [`DataError::IntOutOfRange`] for a magnitude beyond the host width.
///
/// This is the unbounded sibling of [`read_int`]: it runs the same shared canonical-form
/// gate ([`recognize_int`]'s gate) — shape, label, sign byte in `{0x00, 0x01}`, minimal
/// magnitude, no negative zero — then returns the sign as a `bool` (`true` = negative)
/// and a borrow of the magnitude bytes, rather than reconstructing an integer. Because it
/// never materializes, it accepts **every** canonical `int` regardless of magnitude (the
/// recognition surface of [`recognize_int`]); the only failures are not-recognized /
/// non-canonical, never a resource limit.
///
/// `magnitude` is borrowed from `v` (big-endian minimal, empty for zero); the sign of
/// canonical zero is always `false` (non-negative). For an in-range value the returned
/// parts are exactly those [`encode_int`] derived, so the pair round-trips with
/// [`encode_int_bytes`]. An arbitrary-precision consumer reconstructs its own big integer
/// from these bytes without the i128 ceiling. Never panics.
pub fn read_int_bytes(v: &Value) -> Result<(bool, &[u8]), DataError> {
    let (sign, magnitude) = int_payload(v)?;
    Ok((sign == SIGN_NEG, magnitude))
}

// ----- bool (spec 5.3) -----

/// Build the canonical `bool` value: `Tuple(Atom("bool"), Atom(0x00 | 0x01))`.
pub fn encode_bool(b: bool) -> Value {
    scalar(LABEL_BOOL, vec![u8::from(b)])
}

/// Recognize a canonical `bool` value. The payload must be a single byte in
/// `{0x00, 0x01}`; any other payload (empty, longer, or a different byte) is
/// not-recognized.
pub fn read_bool(v: &Value) -> Result<bool, DataError> {
    const KIND: &str = "bool";
    let payload = read_scalar_payload(v, LABEL_BOOL, KIND)?;
    match payload {
        [0x00] => Ok(false),
        [0x01] => Ok(true),
        _ => Err(DataError::NonCanonicalPayload { kind: KIND }),
    }
}

// ----- utf8-text (spec 5.2) -----

/// Build the canonical `utf8-text` value:
/// `Tuple(Atom("utf8-text"), Atom(utf-8 bytes))`. The string's UTF-8 bytes are
/// stored verbatim — no Unicode normalization. The empty string is an empty-atom
/// payload.
pub fn encode_text(s: &str) -> Value {
    scalar(LABEL_TEXT, s.as_bytes().to_vec())
}

/// Recognize a canonical `utf8-text` value and return the decoded string. The
/// payload bytes must be valid UTF-8 (the empty atom is the valid empty string);
/// invalid UTF-8 is not-recognized.
pub fn read_text(v: &Value) -> Result<String, DataError> {
    const KIND: &str = "utf8-text";
    let payload = read_scalar_payload(v, LABEL_TEXT, KIND)?;
    std::str::from_utf8(payload)
        .map(str::to_owned)
        .map_err(|_| DataError::NonCanonicalPayload { kind: KIND })
}

// ----- list (spec 5.5) -----

/// Build the canonical `list` value: `Tuple(Atom("list"), elem_0, ..., elem_{n-1})`
/// — the `list` label followed by the elements in order. Elements are arbitrary L0
/// values (each expected to be already in its own canonical form, the
/// value-not-position rule §2.1); `list` constrains only its own shape. Order and
/// multiplicity are identity. The empty list is `Tuple(Atom("list"))`.
pub fn encode_list(elems: &[Value]) -> Value {
    let mut items = Vec::with_capacity(1 + elems.len());
    items.push(Value::Atom(Atom::new(LABEL_LIST.to_vec())));
    items.extend_from_slice(elems);
    Value::Tuple(Tuple::new(items))
}

/// Recognize a `list` value and return its element values (possibly empty). The
/// value must be a tuple of arity >= 1 whose first child is `Atom("list")`; the
/// bare unlabeled tuple form is not a list. Elements are returned as-is, with no
/// per-element validation (§5.5).
pub fn read_list(v: &Value) -> Result<Vec<Value>, DataError> {
    let rest = read_labeled(v, LABEL_LIST, "list")?;
    Ok(rest.to_vec())
}

// ----- map (spec 5.7) -----

/// Build the canonical `map` value:
/// `Tuple(Atom("map"), Tuple(k_0, v_0), ..., Tuple(k_{n-1}, v_{n-1}))` — the `map`
/// label followed by `n` arity-2 `Tuple(key, value)` entries, sorted **strictly
/// ascending by the `ontos-codec-v1` byte order on the key** (§5.7).
///
/// Keys and values are arbitrary L0 values (each expected to be already in its own
/// canonical form, the value-not-position rule §2.1); `map` constrains only its own
/// shape and key order/uniqueness, and does not recurse into a key/value that claims
/// an embedding label. The empty map is `Tuple(Atom("map"))`.
///
/// **Fallible — unlike the other encoders.** A canonical map has pairwise-distinct
/// keys; if two entries have **equal** key encodings the association is ambiguous, so
/// `encode_map` returns [`DataError::DuplicateKey`] rather than silently picking a
/// winner. The producer MUST resolve duplicate intent before calling (§4). Sorting is
/// by the key encoding alone — no value tiebreak (a tiebreak could only ever mask a
/// duplicate key, §5.7).
pub fn encode_map(entries: &[(Value, Value)]) -> Result<Value, DataError> {
    // Encode each key once via the frozen codec; sort the entry indices by key bytes.
    let mut indexed: Vec<(Vec<u8>, &(Value, Value))> = entries
        .iter()
        .map(|entry| (codec_encode(&entry.0), entry))
        .collect();
    indexed.sort_by(|a, b| a.0.cmp(&b.0));

    // Reject any pair of equal key encodings (duplicate keys): after sorting, equal
    // keys are adjacent, so a single windows(2) scan is sufficient and total.
    for pair in indexed.windows(2) {
        if pair[0].0 == pair[1].0 {
            return Err(DataError::DuplicateKey);
        }
    }

    let mut items = Vec::with_capacity(1 + indexed.len());
    items.push(Value::Atom(Atom::new(LABEL_MAP.to_vec())));
    for (_, entry) in &indexed {
        items.push(Value::Tuple(Tuple::new(vec![
            entry.0.clone(),
            entry.1.clone(),
        ])));
    }
    Ok(Value::Tuple(Tuple::new(items)))
}

/// Recognize a canonical `map` value and return its `(key, value)` entries in order.
///
/// Single left-to-right pass (§5.7): (1) `v` is a `Tuple` of arity >= 1 whose child 0
/// is `Atom("map")`, else not-recognized; (2) arity 1 => the empty map, return no
/// entries; (3) every later child is a `Tuple` of arity **exactly 2**, else
/// [`DataError::MalformedEntry`]; (4) for each entry after the first, require
/// `encode(prevKey) < encode(key)` **strictly** — equal => [`DataError::DuplicateKey`],
/// greater => [`DataError::UnsortedEntries`]. Entries are returned as-is, with **no**
/// per-key/value canonicality validation (no recursion). Never panics.
pub fn read_map(v: &Value) -> Result<Vec<(Value, Value)>, DataError> {
    let rest = read_labeled(v, LABEL_MAP, "map")?;

    let mut entries: Vec<(Value, Value)> = Vec::with_capacity(rest.len());
    let mut prev_key_bytes: Option<Vec<u8>> = None;
    for child in rest {
        // (3) each entry is an exactly-arity-2 Tuple(key, value).
        let items = child.as_tuple().ok_or(DataError::MalformedEntry)?.items();
        let [key, value] = items else {
            return Err(DataError::MalformedEntry);
        };
        // (4) strict ascent by codec key bytes decides BOTH sortedness and dup-freedom.
        let key_bytes = codec_encode(key);
        if let Some(prev) = &prev_key_bytes {
            match prev.as_slice().cmp(key_bytes.as_slice()) {
                core::cmp::Ordering::Less => {}
                core::cmp::Ordering::Equal => return Err(DataError::DuplicateKey),
                core::cmp::Ordering::Greater => return Err(DataError::UnsortedEntries),
            }
        }
        prev_key_bytes = Some(key_bytes);
        entries.push((key.clone(), value.clone()));
    }
    Ok(entries)
}

// ----- set (spec 5.8) -----

/// Build the canonical `set` value:
/// `Tuple(Atom("set"), elem_0, ..., elem_{n-1})` — the `set` label followed by `n`
/// **elements** (single L0 values, not entries), sorted **strictly ascending by the
/// `ontos-codec-v1` byte order on the whole element** (§5.8).
///
/// Elements are arbitrary L0 values (each expected to be already in its own canonical
/// form, the value-not-position rule §2.1); `set` constrains only its own shape and
/// element order/uniqueness, and does not recurse into an element that claims an
/// embedding label. The empty set is `Tuple(Atom("set"))`.
///
/// **Fallible — like [`encode_map`].** A canonical set has pairwise-distinct elements;
/// if two elements have **equal** encodings the collection has a duplicate, so
/// `encode_set` returns [`DataError::DuplicateElement`] rather than silently dropping
/// one. The producer MUST remove duplicates before calling (§4). This is `map`'s
/// key-discipline with no values — it sorts by the whole element encoding.
pub fn encode_set(elems: &[Value]) -> Result<Value, DataError> {
    // Encode each element once via the frozen codec; sort by element bytes.
    let mut indexed: Vec<(Vec<u8>, &Value)> = elems
        .iter()
        .map(|elem| (codec_encode(elem), elem))
        .collect();
    indexed.sort_by(|a, b| a.0.cmp(&b.0));

    // Reject any pair of equal element encodings (duplicates): after sorting, equal
    // elements are adjacent, so a single windows(2) scan is sufficient and total.
    for pair in indexed.windows(2) {
        if pair[0].0 == pair[1].0 {
            return Err(DataError::DuplicateElement);
        }
    }

    let mut items = Vec::with_capacity(1 + indexed.len());
    items.push(Value::Atom(Atom::new(LABEL_SET.to_vec())));
    for (_, elem) in &indexed {
        items.push((*elem).clone());
    }
    Ok(Value::Tuple(Tuple::new(items)))
}

/// Recognize a canonical `set` value and return its element values in order.
///
/// Single left-to-right pass (§5.8): (1) `v` is a `Tuple` of arity >= 1 whose child 0
/// is `Atom("set")`, else not-recognized; (2) arity 1 => the empty set, return no
/// elements; (3) for each element after the first, require `encode(prev) < encode(elem)`
/// **strictly** — equal => [`DataError::DuplicateElement`], greater =>
/// [`DataError::UnsortedElements`]. Unlike `map` there is **no** entry-arity check:
/// elements are single values, not arity-2 entry tuples. Elements are returned as-is,
/// with **no** per-element canonicality validation (no recursion). Never panics.
pub fn read_set(v: &Value) -> Result<Vec<Value>, DataError> {
    let rest = read_labeled(v, LABEL_SET, "set")?;

    let mut elems: Vec<Value> = Vec::with_capacity(rest.len());
    let mut prev_bytes: Option<Vec<u8>> = None;
    for elem in rest {
        // Strict ascent by codec element bytes decides BOTH sortedness and dup-freedom.
        let bytes = codec_encode(elem);
        if let Some(prev) = &prev_bytes {
            match prev.as_slice().cmp(bytes.as_slice()) {
                core::cmp::Ordering::Less => {}
                core::cmp::Ordering::Equal => return Err(DataError::DuplicateElement),
                core::cmp::Ordering::Greater => return Err(DataError::UnsortedElements),
            }
        }
        prev_bytes = Some(bytes);
        elems.push(elem.clone());
    }
    Ok(elems)
}

// ----- decimal (spec 5.9) -----

/// `|n| mod 10` for a big-endian magnitude byte string (empty magnitude = 0). Computed
/// on the bytes, not a host integer, so it works for a magnitude beyond any host width —
/// the `decimal` recognizer must agree across bindings regardless of host integer width
/// (§5.9). Each step folds one base-256 digit: `rem = (rem*256 + b) mod 10`.
fn magnitude_mod_10(magnitude: &[u8]) -> u8 {
    let mut rem: u16 = 0;
    for &b in magnitude {
        rem = (rem * 256 + u16::from(b)) % 10;
    }
    rem as u8
}

/// Normalize `(mantissa, exponent)` to the canonical decimal pair (§5.9): a non-zero
/// mantissa is stripped of trailing base-10 zeros (each carried into the exponent), and
/// zero is `(0, 0)`. This is the producer-side normalization (§4); `encode_decimal`
/// applies it before building.
///
/// Returns `None` when carrying a stripped zero would push the exponent past
/// [`i128::MAX`] — the canonical exponent does not fit this binding's host integer type.
/// That is the encode-side host-width limit (the producer analog of [`read_decimal`]'s
/// `IntOutOfRange`): `checked_add` makes it a graceful `None`, never an overflow panic
/// (debug) or a silently-wrapped wrong value (release). The unbounded Go/TS bindings have
/// no such edge; a realistic decimal is nowhere near `exponent ≈ i128::MAX`.
fn normalize_decimal(mut mantissa: i128, mut exponent: i128) -> Option<(i128, i128)> {
    if mantissa == 0 {
        return Some((0, 0));
    }
    while mantissa % 10 == 0 {
        mantissa /= 10;
        exponent = exponent.checked_add(1)?;
    }
    Some((mantissa, exponent))
}

/// Validate the canonical `decimal` structure and return the canonical `int` mantissa
/// and exponent child values if `v` is a well-formed canonical `decimal` — for ANY
/// mantissa/exponent magnitude, including beyond a host integer width. The recognition
/// gate shared by [`recognize_decimal`] and [`read_decimal`]: shape (arity-3 tuple,
/// `decimal` label) + **both children are canonical `int`s** (the structural
/// [`recognize_int`] gate via `int_payload`, so a `> i128` child is still recognized) +
/// the canonical-decimal rule — zero is `decimal(int 0, int 0)`, and a non-zero mantissa
/// is not divisible by 10. The divisibility is decided on the mantissa magnitude bytes
/// ([`magnitude_mod_10`]), never by materializing.
///
/// Unlike `list`/`map`/`set`, `decimal` **recurses** into its children: it is a scalar
/// (identity = the number it denotes), so one-spelling-per-value requires canonical-`int`
/// children — the scalar discipline, not the container discipline (§5.9). Never panics.
fn decimal_parts(v: &Value) -> Result<(&Value, &Value), DataError> {
    const KIND: &str = "decimal";
    let rest = read_labeled(v, LABEL_DECIMAL, KIND)?;
    let [mantissa, exponent] = rest else {
        return Err(DataError::NotRecognized { kind: KIND });
    };
    // Both children must be canonical ints; int_payload runs every int canonical-form
    // check structurally (no materialization), so a beyond-host child is still accepted.
    let (_, mantissa_mag) =
        int_payload(mantissa).map_err(|_| DataError::NonCanonicalPayload { kind: KIND })?;
    let (_, exponent_mag) =
        int_payload(exponent).map_err(|_| DataError::NonCanonicalPayload { kind: KIND })?;
    if mantissa_mag.is_empty() {
        // mantissa == 0 ⇒ the exponent must be canonical zero (empty magnitude); a
        // non-zero exponent on zero is a second spelling of zero.
        if !exponent_mag.is_empty() {
            return Err(DataError::NonCanonicalPayload { kind: KIND });
        }
    } else if magnitude_mod_10(mantissa_mag) == 0 {
        // A non-zero mantissa divisible by 10 carries a trailing base-10 zero.
        return Err(DataError::NonCanonicalPayload { kind: KIND });
    }
    Ok((mantissa, exponent))
}

/// Build the canonical `decimal` value for `mantissa × 10^exponent`:
/// `Tuple(Atom("decimal"), int(mantissa), int(exponent))` (§5.9). The producer
/// normalizes first ([`normalize_decimal`]): a non-zero mantissa is stripped of trailing
/// base-10 zeros into the exponent, and zero is `decimal(int 0, int 0)`. The children
/// are the full canonical `int` embedding (§5.1), per the value-not-position rule (§2.1).
///
/// **Fallible — like [`encode_map`]/[`encode_set`].** Returns [`DataError::IntOutOfRange`]
/// only at the i128 host-width edge: if stripping trailing zeros would push the canonical
/// exponent past [`i128::MAX`], that exponent does not fit this binding's host integer
/// type, so `encode_decimal` signals the resource limit rather than panicking (debug) or
/// silently emitting a wrapped, wrong canonical value (release). This is the encode-side
/// analog of [`read_decimal`]'s limit and keeps the producer path on the crate's
/// never-panic discipline; the unbounded Go/TS bindings have no such edge, and a realistic
/// decimal is nowhere near `exponent ≈ i128::MAX`.
pub fn encode_decimal(mantissa: i128, exponent: i128) -> Result<Value, DataError> {
    let (mantissa, exponent) =
        normalize_decimal(mantissa, exponent).ok_or(DataError::IntOutOfRange)?;
    Ok(Value::Tuple(Tuple::new(vec![
        Value::Atom(Atom::new(LABEL_DECIMAL.to_vec())),
        encode_int(mantissa),
        encode_int(exponent),
    ])))
}

/// Recognize a canonical `decimal` value **without materializing** its mantissa/exponent
/// into a host integer type. Returns `Ok(())` for every canonical `decimal` — including
/// one whose mantissa or exponent magnitude exceeds the `i128` range that
/// [`read_decimal`] cannot return — and a not-recognized [`DataError`] for any
/// non-canonical form. Structural, like [`recognize_int`]; the surface the `ontos` CLI's
/// `read --kind decimal` uses so every binding agrees regardless of host width. Never panics.
pub fn recognize_decimal(v: &Value) -> Result<(), DataError> {
    decimal_parts(v).map(|_| ())
}

/// Recognize a canonical `decimal` value and return it as `(mantissa, exponent)` `i128`s
/// (the value is `mantissa × 10^exponent`). Performs the same canonical-form validation
/// as [`recognize_decimal`], then materializes both children. A mantissa or exponent
/// whose magnitude exceeds the `i128` range yields [`DataError::IntOutOfRange`] — a
/// resource limit, not a not-recognized rejection (the value is still accepted by
/// [`recognize_decimal`]) — never a panic. This reuses [`read_int`]'s materialization,
/// so the host-width boundary is exactly `int`'s.
pub fn read_decimal(v: &Value) -> Result<(i128, i128), DataError> {
    let (mantissa, exponent) = decimal_parts(v)?;
    Ok((read_int(mantissa)?, read_int(exponent)?))
}

// ----- null (spec 5.10) -----

/// Build the canonical `null` value: `Tuple(Atom("null"))` — the `null` label with NO
/// payload children (tuple arity exactly 1). `null` is the single canonical spelling of
/// present-but-no-value and its only inhabitant (there is no value to vary), so
/// `encode_null` takes no argument and always returns the same value. Its byte form is
/// fixed by structure alone, so — like `list` and `bool` — it is codec-independent and
/// not codec-version-relative.
pub fn encode_null() -> Value {
    Value::Tuple(Tuple::new(vec![Value::Atom(Atom::new(
        LABEL_NULL.to_vec(),
    ))]))
}

/// Recognize the canonical `null` value: `Ok(())` iff `v` is a tuple of arity EXACTLY 1
/// whose only child is `Atom("null")`, else `NotRecognized`. Any payload (arity > 1) is
/// NOT a well-formed `null` — it remains a valid L0 value, merely unrecognized (the typed
/// not-recognized rejection, never a panic and never a quotient). The bare unlabeled
/// arity-0 tuple and a bare `Atom("null")` are likewise not a `null`. The `ontos` CLI's
/// `read --kind null` uses this surface; `null` carries no payload to materialize, so
/// `read_null` is its alias.
pub fn recognize_null(v: &Value) -> Result<(), DataError> {
    const KIND: &str = "null";
    let rest = read_labeled(v, LABEL_NULL, KIND)?;
    if !rest.is_empty() {
        return Err(DataError::NotRecognized { kind: KIND });
    }
    Ok(())
}

/// Recognize the canonical `null` value, returning `Ok(())` for the single inhabitant
/// `Tuple(Atom("null"))` and `NotRecognized` otherwise. `null` is present-but-no-value,
/// so there is nothing to return beyond the recognition decision; identical validation to
/// [`recognize_null`] (recognize and read coincide, as for the empty containers). Never
/// panics.
pub fn read_null(v: &Value) -> Result<(), DataError> {
    recognize_null(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn int_zero_payload_is_single_byte() {
        // 0 -> Atom("int"), Atom(0x00)
        let v = encode_int(0);
        let payload = read_scalar_payload(&v, LABEL_INT, "int").unwrap();
        assert_eq!(payload, &[0x00]);
        assert_eq!(read_int(&v).unwrap(), 0);
    }

    #[test]
    fn int_round_trips_extremes() {
        for n in [0i128, 1, -1, 255, 256, i128::MAX, i128::MIN] {
            assert_eq!(read_int(&encode_int(n)).unwrap(), n);
        }
    }

    #[test]
    fn int_min_magnitude_is_two_pow_127() {
        let payload = match &encode_int(i128::MIN) {
            Value::Tuple(t) => match &t.items()[1] {
                Value::Atom(a) => a.bytes().to_vec(),
                _ => unreachable!(),
            },
            _ => unreachable!(),
        };
        // sign 0x01 then 2^127 big-endian = 0x80 followed by 15 zero bytes.
        assert_eq!(payload[0], SIGN_NEG);
        assert_eq!(payload[1], 0x80);
        assert_eq!(payload.len(), 1 + 16);
    }

    #[test]
    fn int_out_of_range_is_not_a_panic() {
        // 17-magnitude-byte canonical int: 2^128, beyond i128/u128 reconstruction.
        let big = scalar(LABEL_INT, {
            let mut p = vec![SIGN_NONNEG, 0x01];
            p.extend(std::iter::repeat_n(0x00, 16));
            p
        });
        assert_eq!(read_int(&big), Err(DataError::IntOutOfRange));
    }

    /// A canonical int value built from raw sign + big-endian-minimal magnitude bytes.
    /// (Magnitudes beyond i128 cannot come from `encode_int`, which takes an `i128`.)
    fn int_from(sign: u8, magnitude: &[u8]) -> Value {
        let mut p = vec![sign];
        p.extend_from_slice(magnitude);
        scalar(LABEL_INT, p)
    }

    // The `read_int` host-width frontier (+2^127, -2^127, -(2^127+1)) is pinned by
    // `int_host_width_boundary_is_a_resource_limit_not_a_rejection` below. These tests
    // cover the structural recognizer `recognize_int`, which accepts beyond that edge.
    #[test]
    fn recognize_int_accepts_beyond_i128_where_read_int_cannot() {
        // 2^128: 17 magnitude bytes (0x01 then sixteen 0x00) — beyond u128/i128.
        let two_pow_128 = int_from(SIGN_NONNEG, &{
            let mut m = vec![0x01u8];
            m.extend(std::iter::repeat_n(0x00, 16));
            m
        });
        // Recognized structurally...
        assert_eq!(recognize_int(&two_pow_128), Ok(()));
        // ...but not materializable into i128 — a resource limit, not a reject.
        assert_eq!(read_int(&two_pow_128), Err(DataError::IntOutOfRange));

        // +2^127 is likewise recognized though read_int reports it out of range.
        let pos_2pow127 = int_from(SIGN_NONNEG, &{
            let mut m = vec![0x80u8];
            m.extend(std::iter::repeat_n(0x00, 15));
            m
        });
        assert_eq!(recognize_int(&pos_2pow127), Ok(()));
        assert_eq!(read_int(&pos_2pow127), Err(DataError::IntOutOfRange));
    }

    #[test]
    fn recognize_int_and_read_int_agree_on_canonicality() {
        // Sharing int_payload, the two cannot disagree on what is canonical: every
        // non-canonical form is rejected by BOTH, and every in-range canonical int is
        // accepted by both.
        let noncanonical = [
            Value::atom(vec![0x00]),                   // not a tuple
            scalar(LABEL_INT, vec![]),                 // empty payload (no sign byte)
            scalar(LABEL_INT, vec![0x02, 0x01]),       // sign byte 0x02
            scalar(LABEL_INT, vec![0x01]),             // negative zero
            scalar(LABEL_INT, vec![0x00, 0x00, 0x01]), // leading-zero magnitude
            encode_bool(true),                         // wrong label
        ];
        for v in &noncanonical {
            assert!(recognize_int(v).is_err(), "recognize_int must reject {v}");
            assert!(read_int(v).is_err(), "read_int must reject {v}");
        }
        for n in [0i128, 1, -1, 255, 256, i128::MAX, i128::MIN] {
            assert_eq!(recognize_int(&encode_int(n)), Ok(()));
            assert!(read_int(&encode_int(n)).is_ok());
        }
    }

    #[test]
    fn int_host_width_boundary_is_a_resource_limit_not_a_rejection() {
        // The exact i128 host-width boundary (spec §5.1, "Implementation bindings &
        // integer width"). Both payloads are well-formed canonical `int` values that
        // ALL three cores recognize, but their magnitude is one ULP past i128:
        // 2^127 (= i128::MAX + 1) and -(2^127 + 1) (= i128::MIN - 1). Rust's i128
        // binding cannot materialize them, so `read_int` returns the implementation-
        // local resource limit `IntOutOfRange` — never a panic, and never a
        // NonCanonical/NotRecognized "malformed" rejection (the value IS well-formed).
        // Go (`*big.Int`) and TS (`bigint`) materialize these very same bytes; that is
        // the divergence ontos-internal#67 pins. The payloads are shared verbatim with the Go and TS
        // boundary tests so all three exercise identical bytes.

        // 2^127: sign 0x00, magnitude 0x80 then 15 zero bytes.
        let max_plus_1 = scalar(LABEL_INT, {
            let mut p = vec![SIGN_NONNEG, 0x80];
            p.extend(std::iter::repeat_n(0x00, 15));
            p
        });
        // -(2^127 + 1): sign 0x01, magnitude 0x80, 14 zero bytes, then 0x01.
        let min_minus_1 = scalar(LABEL_INT, {
            let mut p = vec![SIGN_NEG, 0x80];
            p.extend(std::iter::repeat_n(0x00, 14));
            p.push(0x01);
            p
        });

        assert_eq!(read_int(&max_plus_1), Err(DataError::IntOutOfRange));
        assert_eq!(read_int(&min_minus_1), Err(DataError::IntOutOfRange));

        // The representable extremes one ULP closer to zero still materialize exactly,
        // so IntOutOfRange marks precisely the host-width edge — not a near-miss.
        assert_eq!(read_int(&encode_int(i128::MAX)).unwrap(), i128::MAX);
        assert_eq!(read_int(&encode_int(i128::MIN)).unwrap(), i128::MIN);
    }

    #[test]
    fn int_bytes_round_trip_and_agree_with_encode_int() {
        // For every in-range value the byte-level pair agrees with the host-width pair:
        // encode_int_bytes(read_int_bytes(encode_int(n))) is byte-identical to encode_int(n),
        // and read_int_bytes returns exactly encode_int's inner payload (sign + magnitude).
        for n in [0i128, 1, -1, 255, 256, -256, i128::MAX, i128::MIN] {
            let v = encode_int(n);
            let (negative, magnitude) = read_int_bytes(&v).unwrap();
            // Sign agrees with the integer's sign (zero is non-negative).
            assert_eq!(negative, n < 0, "sign for {n}");
            // The (sign, magnitude) parts rebuild the very same canonical value.
            assert_eq!(
                encode_int_bytes(negative, magnitude).unwrap(),
                v,
                "encode_int_bytes round-trip for {n}"
            );
            // And those parts are exactly encode_int's inner payload (sign ‖ magnitude).
            let payload = read_scalar_payload(&v, LABEL_INT, "int").unwrap();
            let (&want_sign, want_mag) = payload.split_first().unwrap();
            assert_eq!(negative, want_sign == SIGN_NEG, "payload sign for {n}");
            assert_eq!(magnitude, want_mag, "payload magnitude for {n}");
        }
    }

    #[test]
    fn int_bytes_zero_is_nonnegative_empty_magnitude() {
        // Canonical zero: non-negative, empty magnitude; the produced value is the single
        // 0x00 payload byte, identical to encode_int(0).
        let zero = encode_int_bytes(false, &[]).unwrap();
        assert_eq!(zero, encode_int(0));
        let (negative, magnitude) = read_int_bytes(&zero).unwrap();
        assert!(!negative);
        assert!(magnitude.is_empty());
    }

    #[test]
    fn encode_int_bytes_rejects_noncanonical_magnitude() {
        // Leading-zero magnitude is non-minimal — rejected for either sign.
        assert_eq!(
            encode_int_bytes(false, &[0x00, 0x01]),
            Err(DataError::NonCanonicalPayload { kind: "int" })
        );
        assert_eq!(
            encode_int_bytes(true, &[0x00, 0x01]),
            Err(DataError::NonCanonicalPayload { kind: "int" })
        );
        // A bare leading 0x00 (would be a non-minimal spelling of zero) is rejected.
        assert_eq!(
            encode_int_bytes(false, &[0x00]),
            Err(DataError::NonCanonicalPayload { kind: "int" })
        );
        // Negative zero (sign 0x01, empty magnitude) is not a canonical int.
        assert_eq!(
            encode_int_bytes(true, &[]),
            Err(DataError::NonCanonicalPayload { kind: "int" })
        );
        // It is impossible to mint a non-canonical embedding: anything encode_int_bytes
        // accepts is recognized as canonical by read_int_bytes / recognize_int.
        for (negative, magnitude) in [(false, &[0x01][..]), (true, &[0x80, 0x00][..])] {
            let v = encode_int_bytes(negative, magnitude).unwrap();
            assert_eq!(recognize_int(&v), Ok(()));
            assert_eq!(read_int_bytes(&v).unwrap(), (negative, magnitude));
        }
    }

    #[test]
    fn read_int_bytes_rejects_noncanonical_values() {
        // Exactly the int_payload not-recognized / non-canonical set, mirroring the
        // recognize_int agreement test — read_int_bytes shares the same gate.
        let noncanonical = [
            Value::atom(vec![0x00]),                   // not a tuple
            scalar(LABEL_INT, vec![]),                 // empty payload (no sign byte)
            scalar(LABEL_INT, vec![0x02, 0x01]),       // sign byte 0x02
            scalar(LABEL_INT, vec![0x01]),             // negative zero
            scalar(LABEL_INT, vec![0x00, 0x00, 0x01]), // leading-zero magnitude
            encode_bool(true),                         // wrong label
        ];
        for v in &noncanonical {
            assert!(read_int_bytes(v).is_err(), "read_int_bytes must reject {v}");
        }
    }

    #[test]
    fn int_bytes_handle_beyond_i128_without_a_resource_limit() {
        // The whole point of the byte-level pair: a magnitude beyond i128 round-trips
        // with no IntOutOfRange (read_int on the same value would report the limit).
        // 2^128: magnitude 0x01 then sixteen 0x00 bytes (17 bytes, beyond u128/i128).
        let mut big_mag = vec![0x01u8];
        big_mag.extend(std::iter::repeat_n(0x00, 16));

        let v = encode_int_bytes(false, &big_mag).unwrap();
        // read_int_bytes returns the bytes verbatim — never a resource limit...
        assert_eq!(read_int_bytes(&v).unwrap(), (false, big_mag.as_slice()));
        // ...whereas the host-width read_int reports IntOutOfRange on the same value,
        // and recognize_int still accepts it (structural recognition is unbounded).
        assert_eq!(read_int(&v), Err(DataError::IntOutOfRange));
        assert_eq!(recognize_int(&v), Ok(()));

        // Negative beyond i128 likewise: -(2^128).
        let v_neg = encode_int_bytes(true, &big_mag).unwrap();
        assert_eq!(read_int_bytes(&v_neg).unwrap(), (true, big_mag.as_slice()));
        assert_eq!(read_int(&v_neg), Err(DataError::IntOutOfRange));
        assert_eq!(recognize_int(&v_neg), Ok(()));
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(
            DataError::NotRecognized { kind: "int" }.code(),
            "not_recognized"
        );
        assert_eq!(
            DataError::NonCanonicalPayload { kind: "int" }.code(),
            "non_canonical_payload"
        );
        assert_eq!(DataError::IntOutOfRange.code(), "int_out_of_range");
        assert_eq!(DataError::MalformedEntry.code(), "malformed_entry");
        assert_eq!(DataError::DuplicateKey.code(), "duplicate_key");
        assert_eq!(DataError::UnsortedEntries.code(), "unsorted_entries");
        assert_eq!(DataError::DuplicateElement.code(), "duplicate_element");
        assert_eq!(DataError::UnsortedElements.code(), "unsorted_elements");
    }

    #[test]
    fn map_empty_and_single_round_trip() {
        // empty map
        let empty = encode_map(&[]).unwrap();
        assert_eq!(
            empty,
            Value::Tuple(Tuple::new(vec![Value::atom(b"map".to_vec())]))
        );
        assert_eq!(read_map(&empty).unwrap(), Vec::<(Value, Value)>::new());

        // single entry
        let entries = vec![(encode_int(1), encode_text("hi"))];
        let m = encode_map(&entries).unwrap();
        assert_eq!(read_map(&m).unwrap(), entries);
    }

    #[test]
    fn encode_map_sorts_by_codec_key_bytes() {
        // Two atom keys 0x62, 0x61 given out of order must come back as 0x61 then 0x62.
        let entries = vec![
            (Value::atom(vec![0x62]), encode_int(2)),
            (Value::atom(vec![0x61]), encode_int(1)),
        ];
        let m = encode_map(&entries).unwrap();
        let got = read_map(&m).unwrap();
        assert_eq!(got[0].0, Value::atom(vec![0x61]));
        assert_eq!(got[1].0, Value::atom(vec![0x62]));
    }

    #[test]
    fn encode_map_rejects_duplicate_keys() {
        let entries = vec![
            (Value::atom(vec![0x61]), encode_int(0)),
            (Value::atom(vec![0x61]), encode_int(1)),
        ];
        assert_eq!(encode_map(&entries), Err(DataError::DuplicateKey));
    }

    #[test]
    fn set_empty_and_single_round_trip() {
        // empty set
        let empty = encode_set(&[]).unwrap();
        assert_eq!(
            empty,
            Value::Tuple(Tuple::new(vec![Value::atom(b"set".to_vec())]))
        );
        assert_eq!(read_set(&empty).unwrap(), Vec::<Value>::new());

        // single element
        let elems = vec![encode_int(1)];
        let s = encode_set(&elems).unwrap();
        assert_eq!(read_set(&s).unwrap(), elems);
    }

    #[test]
    fn encode_set_sorts_by_codec_element_bytes() {
        // Two atom elements 0x62, 0x61 given out of order must come back 0x61 then 0x62.
        let elems = vec![Value::atom(vec![0x62]), Value::atom(vec![0x61])];
        let s = encode_set(&elems).unwrap();
        let got = read_set(&s).unwrap();
        assert_eq!(got[0], Value::atom(vec![0x61]));
        assert_eq!(got[1], Value::atom(vec![0x62]));
    }

    #[test]
    fn encode_set_rejects_duplicate_elements() {
        let elems = vec![Value::atom(vec![0x61]), Value::atom(vec![0x61])];
        assert_eq!(encode_set(&elems), Err(DataError::DuplicateElement));
    }

    /// Pins `LABELS` — the single source of the registered label set and its order
    /// (§5) — against the actual `read_*` recognizers: for each label in order, the
    /// canonical embedding of that kind is recognized by exactly that label's
    /// recognizer, so `LABELS` truly is the recognized order. Drift is a real,
    /// CI-caught parity bug (the order is part of the CLI's `recognized` JSON
    /// contract; the CLI keeps its own copy by design, pinned to `LABELS` by a
    /// separate cli-side test).
    #[test]
    fn labels_match_recognized_order() {
        assert_eq!(
            LABELS,
            [
                "int",
                "utf8-text",
                "bool",
                "list",
                "map",
                "set",
                "decimal",
                "null"
            ]
        );
        // recognizes(label, v): the matching read_* succeeds on v.
        fn recognizes(label: &str, v: &Value) -> bool {
            match label {
                // `int`/`decimal` recognition uses the structural recognizer, matching the CLI.
                "int" => recognize_int(v).is_ok(),
                "utf8-text" => read_text(v).is_ok(),
                "bool" => read_bool(v).is_ok(),
                "list" => read_list(v).is_ok(),
                "map" => read_map(v).is_ok(),
                "set" => read_set(v).is_ok(),
                "decimal" => recognize_decimal(v).is_ok(),
                "null" => recognize_null(v).is_ok(),
                _ => panic!("no recognizer for label {label}"),
            }
        }
        // One canonical embedding per kind, in LABELS order.
        let samples: [Value; 8] = [
            encode_int(1),
            encode_text("x"),
            encode_bool(true),
            encode_list(&[]),
            encode_map(&[]).unwrap(),
            encode_set(&[]).unwrap(),
            encode_decimal(1, 0).unwrap(),
            encode_null(),
        ];
        for (label, sample) in LABELS.iter().zip(samples.iter()) {
            assert!(
                recognizes(label, sample),
                "LABELS entry {label:?}: its canonical embedding is not recognized by read_{label}"
            );
        }
    }

    #[test]
    fn decimal_round_trips_and_normalizes() {
        // (mantissa, exponent) → canonical value → read back the normalized pair.
        for (m, e, want) in [
            (0i128, 0i128, (0i128, 0i128)),
            (1, 0, (1, 0)),
            (314, -2, (314, -2)),
            (-5, -1, (-5, -1)),
            (100, 0, (1, 2)), // trailing zeros stripped into the exponent
            (10, 1, (1, 2)),  // same value, different surface spelling
            (0, 5, (0, 0)),   // zero normalizes its exponent to 0
            (-120, 3, (-12, 4)),
        ] {
            let v = encode_decimal(m, e).unwrap();
            assert_eq!(read_decimal(&v).unwrap(), want, "read_decimal({m},{e})");
            // Encoding the normalized pair is idempotent (canonical form is a fixpoint).
            assert_eq!(
                encode_decimal(want.0, want.1).unwrap(),
                v,
                "canonical fixpoint ({m},{e})"
            );
            assert_eq!(recognize_decimal(&v), Ok(()));
        }
    }

    #[test]
    fn decimal_rejects_noncanonical_forms() {
        let dec = |m: Value, e: Value| {
            Value::Tuple(Tuple::new(vec![Value::atom(b"decimal".to_vec()), m, e]))
        };
        let noncanonical = [
            // trailing-zero mantissa (canonical is decimal(int 1, int 1)).
            dec(encode_int(10), encode_int(0)),
            // zero with a non-zero exponent.
            dec(encode_int(0), encode_int(5)),
            // non-canonical int mantissa (leading-zero magnitude) — the recursion case.
            dec(scalar(LABEL_INT, vec![0x00, 0x00, 0x01]), encode_int(0)),
            // a child that is not an int embedding (bare atom).
            dec(Value::atom(vec![0x01]), encode_int(0)),
            // wrong arity (missing exponent).
            Value::Tuple(Tuple::new(vec![
                Value::atom(b"decimal".to_vec()),
                encode_int(1),
            ])),
            // a bare atom is not a decimal.
            Value::atom(b"decimal".to_vec()),
            // cross-kind: a well-formed int is not a decimal.
            encode_int(1),
        ];
        for v in &noncanonical {
            assert!(
                recognize_decimal(v).is_err(),
                "recognize_decimal must reject {v}"
            );
            assert!(read_decimal(v).is_err(), "read_decimal must reject {v}");
        }
    }

    #[test]
    fn decimal_beyond_i128_recognized_but_not_read() {
        // A canonical decimal whose mantissa is 2^128 (17 magnitude bytes, 0x01 then
        // sixteen 0x00) is beyond i128 — recognized structurally, but read_decimal
        // reports the resource limit, never a panic (the int-layer §5.1 boundary).
        let mantissa = scalar(LABEL_INT, {
            let mut p = vec![SIGN_NONNEG, 0x01];
            p.extend(std::iter::repeat_n(0x00, 16));
            p
        });
        // 2^128 ends in ...211456, not divisible by 10, so it is a canonical mantissa.
        let v = Value::Tuple(Tuple::new(vec![
            Value::atom(b"decimal".to_vec()),
            mantissa,
            encode_int(0),
        ]));
        assert_eq!(recognize_decimal(&v), Ok(()));
        assert_eq!(read_decimal(&v), Err(DataError::IntOutOfRange));
    }

    #[test]
    fn encode_decimal_exponent_overflow_is_a_resource_limit_not_a_panic() {
        // Producer-side host-width edge: stripping a trailing zero from a non-zero mantissa
        // carries into the exponent, and at exponent ≈ i128::MAX that carry would overflow.
        // encode_decimal must report IntOutOfRange — never panic, never silently wrap to a
        // wrong canonical value (the unbounded Go/TS bindings encode the larger exponent
        // cleanly; this is the encode-side analog of read_decimal's limit).
        assert_eq!(encode_decimal(10, i128::MAX), Err(DataError::IntOutOfRange));
        assert_eq!(
            encode_decimal(100, i128::MAX - 1),
            Err(DataError::IntOutOfRange)
        );
        // i128::MAX itself is a fine exponent when the mantissa needs no carry (not
        // divisible by 10): the boundary is the carry, not the value i128::MAX.
        let v = encode_decimal(7, i128::MAX).unwrap();
        assert_eq!(read_decimal(&v).unwrap(), (7, i128::MAX));
    }

    #[test]
    fn null_is_the_unique_nullary_compound() {
        let v = encode_null();
        // Exact canonical structure: Tuple(Atom("null")), arity exactly 1.
        assert_eq!(
            v,
            Value::Tuple(Tuple::new(vec![Value::atom(b"null".to_vec())]))
        );
        // Frozen byte form: 01 01 00 04 6e 75 6c 6c (spec §5.10).
        assert_eq!(
            codec_encode(&v),
            vec![0x01, 0x01, 0x00, 0x04, 0x6e, 0x75, 0x6c, 0x6c]
        );
        assert_eq!(recognize_null(&v), Ok(()));
        assert_eq!(read_null(&v), Ok(()));
        // Re-encoding is a fixpoint — null has no value to vary.
        assert_eq!(encode_null(), v);
    }

    #[test]
    fn null_rejects_payload_wrong_label_and_cross_kind() {
        let null_label = || Value::atom(b"null".to_vec());
        let cases = [
            // arity 2: a "null" with a payload child — present-but-no-value forbids payload.
            Value::Tuple(Tuple::new(vec![null_label(), Value::atom(vec![0x61])])),
            // arity 3: more payload, still rejected.
            Value::Tuple(Tuple::new(vec![
                null_label(),
                Value::atom(vec![0x61]),
                Value::atom(vec![0x62]),
            ])),
            // arity 0: the bare empty tuple is not the null.
            Value::Tuple(Tuple::new(vec![])),
            // a bare atom (even the bytes of "null") is not a null.
            null_label(),
            // near-miss label.
            Value::Tuple(Tuple::new(vec![Value::atom(b"nul".to_vec())])),
            // cross-kind: a well-formed empty list is not a null.
            encode_list(&[]),
            // cross-kind: a well-formed bool is not a null.
            encode_bool(false),
        ];
        for v in &cases {
            assert_eq!(
                recognize_null(v),
                Err(DataError::NotRecognized { kind: "null" }),
                "recognize_null must reject {v}"
            );
            assert!(read_null(v).is_err(), "read_null must reject {v}");
        }
        // The single null value is recognized ONLY as null, never as another kind.
        let v = encode_null();
        assert!(read_list(&v).is_err());
        assert!(read_set(&v).is_err());
        assert!(read_map(&v).is_err());
        assert!(read_bool(&v).is_err());
    }
}
