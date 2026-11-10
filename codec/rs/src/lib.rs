//! ontos canonical binary codec — `ontos-codec-v1` (frozen).
//!
//! ```text
//! Atom(bytes)    = 0x00 || uvarint(len(bytes)) || bytes
//! Tuple(values)  = 0x01 || uvarint(arity)      || encode(values[0]) || ...
//! ```
//!
//! `uvarint` is unsigned LEB128 in shortest/canonical form over the domain
//! `[0, 2^64 - 1]` (at most 10 bytes). The decoder rejects unknown tags, trailing
//! bytes, non-canonical uvarints, uvarints whose value would be `>= 2^64`
//! (`uvarint_overflow`), valid `u64`s that exceed this implementation's native
//! length type (`limit_exceeded`; only reachable on 32-bit targets where
//! `usize::MAX < u64::MAX`), and inputs exceeding the configured safety limits.
//! A `limit_exceeded` names the bound responsible through
//! [`DecodeError::limit_kind`] (`docs/spec/ontos-codec.md` §4.2).
//!
//! [`measure`] reports a value's canonical encoded length, its expanded occurrence
//! count and its height against bounds the caller states (`docs/spec/ontos-codec.md`
//! §10, pinned by `vectors/codec-measure.json`).
//!
//! This codec is kept beside the model (it depends on `ontos-core`, never the
//! reverse). The integer domain and rejection codes are normative in
//! `docs/spec/ontos-codec.md`; conformance is pinned by `vectors/codec.json`.

use core::fmt;
use ontos_core::{Atom, Tuple, Value};

const TAG_ATOM: u8 = 0x00;
const TAG_TUPLE: u8 = 0x01;
const DEFAULT_MAX_DEPTH: usize = 1024;

/// Safety limits for decoding untrusted input. Operational policy, not value
/// semantics: a value rejected for exceeding a limit is still a value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DecodeLimits {
    pub max_depth: usize,
    pub max_atom_bytes: usize,
    pub max_tuple_arity: usize,
}

impl Default for DecodeLimits {
    fn default() -> Self {
        Self {
            max_depth: DEFAULT_MAX_DEPTH,
            max_atom_bytes: usize::MAX,
            max_tuple_arity: usize::MAX,
        }
    }
}

/// Rejection categories (`docs/spec/ontos-codec.md` §4). The `code()` of the five
/// byte-contract variants is normative and pinned by `vectors/codec.json`.
/// [`DecodeError::LimitExceeded`] is different: it reports that decoding stopped at an
/// operational bound, is not vector-pinned, and says nothing about whether the input is
/// a valid encoding; [`DecodeError::limit_kind`] names the bound (§4.2). The `limit`
/// labels (`"decode depth"`, `"atom byte length"`, `"tuple arity"`) are kept as they
/// were for callers that match them, and the `Display` message is diagnostic only.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DecodeError {
    UnexpectedEof,
    TrailingBytes {
        offset: usize,
    },
    UnknownTag {
        tag: u8,
        offset: usize,
    },
    NonCanonicalUvarint {
        offset: usize,
    },
    UvarintOverflow {
        offset: usize,
    },
    LimitExceeded {
        limit: &'static str,
        value: u64,
        max: u64,
    },
}

/// The operational bound named by a `limit_exceeded` rejection
/// (`docs/spec/ontos-codec.md` §4.2). Marked `#[non_exhaustive]` because the vocabulary
/// is append-only: a later version may add a kind, so a `match` needs a wildcard arm,
/// and an unrecognized kind means no more than the generic `limit_exceeded`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum DecodeLimitKind {
    /// The value about to be read is nested deeper than `max_depth` (the root is depth 0).
    DecodeDepth,
    /// A declared atom byte length exceeds `max_atom_bytes`.
    AtomBytes,
    /// A declared tuple arity exceeds `max_tuple_arity`.
    TupleArity,
    /// A valid `u64` length or arity exceeds `usize::MAX`. Only reachable on a
    /// 32-bit target such as `wasm32`: on 64-bit, `usize` holds every `u64`.
    NativeWidth,
}

impl DecodeLimitKind {
    /// The kind's identifier, as the spec and the other faces spell it.
    pub fn as_str(self) -> &'static str {
        match self {
            DecodeLimitKind::DecodeDepth => "decode_depth",
            DecodeLimitKind::AtomBytes => "atom_bytes",
            DecodeLimitKind::TupleArity => "tuple_arity",
            DecodeLimitKind::NativeWidth => "native_width",
        }
    }
}

impl fmt::Display for DecodeLimitKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl DecodeError {
    /// The cross-language rejection code (`docs/spec/ontos-codec.md` §4). The five
    /// byte-contract codes are pinned by `vectors/codec.json`; `"limit_exceeded"` is
    /// operational and is not.
    pub fn code(&self) -> &'static str {
        match self {
            DecodeError::UnexpectedEof => "unexpected_eof",
            DecodeError::TrailingBytes { .. } => "trailing_bytes",
            DecodeError::UnknownTag { .. } => "unknown_tag",
            DecodeError::NonCanonicalUvarint { .. } => "non_canonical_uvarint",
            DecodeError::UvarintOverflow { .. } => "uvarint_overflow",
            DecodeError::LimitExceeded { .. } => "limit_exceeded",
        }
    }

    /// The bound that stopped decoding, for a `LimitExceeded` this decoder produced;
    /// `None` for every other variant, and for a `LimitExceeded` whose `limit` label is
    /// not one of the three this decoder writes. It is observational: another
    /// implementation may name a different bound for the same input (§4.2).
    ///
    /// Native width is told apart by its numbers, not its label, which it shares with
    /// the configured check on the same field: only the narrowing to `usize` reports
    /// `max == usize::MAX` with `value > max`, because every configured check compares
    /// a value that has already been narrowed to `usize`.
    pub fn limit_kind(&self) -> Option<DecodeLimitKind> {
        let DecodeError::LimitExceeded { limit, value, max } = self else {
            return None;
        };
        if *max == usize::MAX as u64 && *value > *max {
            return Some(DecodeLimitKind::NativeWidth);
        }
        match *limit {
            "decode depth" => Some(DecodeLimitKind::DecodeDepth),
            "atom byte length" => Some(DecodeLimitKind::AtomBytes),
            "tuple arity" => Some(DecodeLimitKind::TupleArity),
            _ => None,
        }
    }
}

/// Encode a value to its canonical ontos-codec-v1 bytes.
pub fn encode(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    encode_into(value, &mut out);
    out
}

/// Decode one value with default safety limits; rejects trailing bytes.
pub fn decode(input: &[u8]) -> Result<Value, DecodeError> {
    decode_with_limits(input, DecodeLimits::default())
}

/// Decode one value with explicit limits; rejects trailing bytes.
pub fn decode_with_limits(input: &[u8], limits: DecodeLimits) -> Result<Value, DecodeError> {
    let mut reader = Reader {
        input,
        pos: 0,
        limits,
    };
    let value = reader.read_value(0)?;
    if reader.pos != input.len() {
        return Err(DecodeError::TrailingBytes { offset: reader.pos });
    }
    Ok(value)
}

/// Encode an unsigned integer (`[0, 2^64 - 1]`) as shortest-form LEB128.
///
/// The codec domain is `u64`; callers holding a `usize` length (atom byte count,
/// tuple arity) widen with `as u64`, which is lossless on every target.
pub fn encode_uvarint(mut value: u64, out: &mut Vec<u8>) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

/// Pre-order with an explicit stack (ontos-internal#340), so the depth of a value this writes is never a
/// property of the native stack. Children are pushed in reverse so they are written in order;
/// the bytes are exactly the recursive walk's.
///
/// An atom, or a tuple whose items are all atoms, is the common case and is written directly in
/// the same order, without allocating a stack (Bitspark/ontos#31).
fn encode_into(value: &Value, out: &mut Vec<u8>) {
    let shallow = match value {
        Value::Atom(_) => true,
        Value::Tuple(tuple) => tuple.items().iter().all(Value::is_atom),
    };
    if shallow {
        write_head(value, out);
        if let Value::Tuple(tuple) = value {
            for item in tuple.items() {
                write_head(item, out);
            }
        }
        return;
    }
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        write_head(value, out);
        if let Value::Tuple(tuple) = value {
            pending.extend(tuple.items().iter().rev());
        }
    }
}

/// Writes what a value contributes before its items: all of an atom, or a tuple's tag and arity.
fn write_head(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Atom(atom) => {
            out.push(TAG_ATOM);
            encode_uvarint(atom.bytes().len() as u64, out);
            out.extend_from_slice(atom.bytes());
        }
        Value::Tuple(tuple) => {
            out.push(TAG_TUPLE);
            encode_uvarint(tuple.len() as u64, out);
        }
    }
}

struct Reader<'a> {
    input: &'a [u8],
    pos: usize,
    limits: DecodeLimits,
}

impl Reader<'_> {
    /// Reads one value rooted at `depth`, with an explicit stack of the tuples still being
    /// filled rather than one native frame per level. A recursive reader spends a stack frame
    /// per nesting level, and on wasm32 (a 1 MiB stack) that trapped before the harmonized
    /// default depth of 1024 (ontos-codec.md §4.1 invariant 1). Each value's header is read
    /// and checked in the recursive reader's order (depth, then tag, then length or arity),
    /// with the same errors carrying the same numbers, and a completed value is handed to its
    /// parent, closing every tuple it fills. Mirrors codec/ts (ontos-internal#345) and codec/py (ontos-internal#349).
    fn read_value(&mut self, depth: usize) -> Result<Value, DecodeError> {
        // (items, arity) of each tuple still being filled; the next value sits at
        // depth + open.len().
        let mut open: Vec<(Vec<Value>, usize)> = Vec::new();
        loop {
            let level = depth + open.len();
            if level > self.limits.max_depth {
                return Err(DecodeError::LimitExceeded {
                    limit: "decode depth",
                    value: level as u64,
                    max: self.limits.max_depth as u64,
                });
            }

            let offset = self.pos;
            let tag = self.read_byte()?;
            let mut done = match tag {
                TAG_ATOM => {
                    let length = self.read_length("atom byte length")?;
                    if length > self.limits.max_atom_bytes {
                        return Err(DecodeError::LimitExceeded {
                            limit: "atom byte length",
                            value: length as u64,
                            max: self.limits.max_atom_bytes as u64,
                        });
                    }
                    let bytes = self.read_exact(length)?.to_vec();
                    Value::Atom(Atom::new(bytes))
                }
                TAG_TUPLE => {
                    let arity = self.read_length("tuple arity")?;
                    if arity > self.limits.max_tuple_arity {
                        return Err(DecodeError::LimitExceeded {
                            limit: "tuple arity",
                            value: arity as u64,
                            max: self.limits.max_tuple_arity as u64,
                        });
                    }
                    // Every encoded value is at least two bytes (tag + zero uvarint),
                    // so an arity larger than half the remaining bytes is impossible.
                    // Guards against allocating/looping on malformed input.
                    let remaining = self.input.len().saturating_sub(self.pos);
                    if arity > remaining / 2 {
                        return Err(DecodeError::UnexpectedEof);
                    }
                    if arity > 0 {
                        open.push((Vec::with_capacity(arity), arity));
                        continue;
                    }
                    Value::Tuple(Tuple::new(Vec::new()))
                }
                other => return Err(DecodeError::UnknownTag { tag: other, offset }),
            };

            // Hand the completed value to its parent, closing every tuple it completes.
            loop {
                let Some((items, arity)) = open.last_mut() else {
                    return Ok(done);
                };
                items.push(done);
                if items.len() < *arity {
                    break;
                }
                let (items, _) = open.pop().expect("the tuple just filled is open");
                done = Value::Tuple(Tuple::new(items));
            }
        }
    }

    fn read_byte(&mut self) -> Result<u8, DecodeError> {
        let Some(byte) = self.input.get(self.pos).copied() else {
            return Err(DecodeError::UnexpectedEof);
        };
        self.pos += 1;
        Ok(byte)
    }

    fn read_exact(&mut self, length: usize) -> Result<&[u8], DecodeError> {
        let end = self
            .pos
            .checked_add(length)
            .ok_or(DecodeError::UnexpectedEof)?;
        if end > self.input.len() {
            return Err(DecodeError::UnexpectedEof);
        }
        let out = &self.input[self.pos..end];
        self.pos = end;
        Ok(out)
    }

    /// Read a uvarint and narrow it to the native length type (`usize`).
    ///
    /// The value is accumulated and validated in `u64` first, so a uvarint whose
    /// value would be `>= 2^64` is rejected as `uvarint_overflow`. A *valid* `u64`
    /// that does not fit `usize` — only possible on 32-bit targets, where
    /// `usize::MAX < u64::MAX` — is rejected as `limit_exceeded` (a resource-limit
    /// class), never `uvarint_overflow`.
    fn read_length(&mut self, limit: &'static str) -> Result<usize, DecodeError> {
        let value = self.read_uvarint()?;
        usize::try_from(value).map_err(|_| DecodeError::LimitExceeded {
            limit,
            value,
            max: usize::MAX as u64,
        })
    }

    /// Read one canonical uvarint into a 64-bit accumulator.
    ///
    /// A value `>= 2^64` is detected **structurally** — an 11th (or later)
    /// continuation byte, or a 10th byte whose value bits exceed the single bit
    /// that fits below the `u64` ceiling — and rejected as `uvarint_overflow`
    /// before any narrowing. Canonicality is then checked against the 64-bit value.
    fn read_uvarint(&mut self) -> Result<u64, DecodeError> {
        let start = self.pos;
        let mut result: u64 = 0;
        let mut shift: u32 = 0;

        loop {
            let byte = self.read_byte()?;
            let low = (byte & 0x7f) as u64;

            if shift >= 64 {
                // An 11th (or later) byte: the value is necessarily >= 2^64.
                return Err(DecodeError::UvarintOverflow { offset: start });
            }
            if shift == 63 && low > 1 {
                // 10th byte: only bit 0 fits below 2^64; any higher bit overflows.
                return Err(DecodeError::UvarintOverflow { offset: start });
            }

            result |= low << shift;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
        }

        // Canonicality: the bytes just read must equal the shortest-form encoding
        // of the 64-bit value.
        let mut canonical = Vec::new();
        encode_uvarint(result, &mut canonical);
        if canonical.as_slice() != &self.input[start..self.pos] {
            return Err(DecodeError::NonCanonicalUvarint { offset: start });
        }
        Ok(result)
    }
}

/// One of the three measures [`measure`] reports (`docs/spec/ontos-codec.md` §10), by its
/// stable identifier. Marked `#[non_exhaustive]` because the vocabulary is append-only, as
/// [`DecodeLimitKind`]'s is: a later version may add a measure, so a `match` needs a
/// wildcard arm, and an unrecognized measure still means over limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum MeasureKind {
    /// The length of the value's canonical encoding: `encode(value).len()`.
    EncodedBytes,
    /// How deep the value is nested, as `max_depth` counts it: 0 for an atom and for the
    /// empty tuple, 1 + the deepest child otherwise.
    Height,
    /// The number of values in the tree, the root included.
    Occurrences,
}

impl MeasureKind {
    /// The measure's identifier, as the spec and the other faces spell it.
    pub fn as_str(self) -> &'static str {
        match self {
            MeasureKind::EncodedBytes => "encoded_bytes",
            MeasureKind::Height => "height",
            MeasureKind::Occurrences => "occurrences",
        }
    }
}

impl fmt::Display for MeasureKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One bound for each measure. There is no `Default`: the caller states all three. A
/// measure equal to its bound is within it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MeasureBounds {
    pub max_encoded_bytes: u64,
    pub max_occurrences: u64,
    pub max_height: u64,
}

/// A value's three measures, each exact, as [`measure`] returns them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Measures {
    pub encoded_bytes: u64,
    pub occurrences: u64,
    pub height: u64,
}

/// The over-limit outcome of [`measure`]. It names every measure that exceeded its bound,
/// and nothing else: a measure past its bound was not counted to the end.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MeasureError {
    exceeded: Vec<MeasureKind>,
}

impl MeasureError {
    /// Every measure that exceeded its bound, in ascending order of the identifiers
    /// (`encoded_bytes`, `height`, `occurrences`); never empty. It is a function of the
    /// value and the bounds alone (§10.2), unlike [`DecodeError::limit_kind`].
    pub fn exceeded(&self) -> &[MeasureKind] {
        &self.exceeded
    }
}

impl fmt::Display for MeasureError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("over limit: ")?;
        for (i, kind) in self.exceeded.iter().enumerate() {
            if i > 0 {
                f.write_str(", ")?;
            }
            f.write_str(kind.as_str())?;
        }
        Ok(())
    }
}

impl std::error::Error for MeasureError {}

/// The length of `value`'s canonical encoding, the number of values in its tree, and its
/// height (`docs/spec/ontos-codec.md` §10). Returns them exactly when each is within its
/// bound; otherwise names every measure over its bound in a [`MeasureError`].
///
/// A Rust [`Value`] owns its children, so it cannot share a subtree, and its tree is
/// already expanded in memory: `measure` is a plain walk, with no memo, over every value
/// once. It keeps an explicit stack, so a value of any height can be measured. Its
/// arithmetic saturates at each bound, so it never overflows, and it always finishes the
/// walk, so its outcome is the one the sharing faces (Go, TypeScript, Python) report for
/// the same tree.
pub fn measure(value: &Value, bounds: MeasureBounds) -> Result<Measures, MeasureError> {
    let mut bytes = Saturating::new(bounds.max_encoded_bytes);
    let mut occurrences = Saturating::new(bounds.max_occurrences);
    let mut height = Saturating::new(bounds.max_height);
    // In a tree, the height is the depth of the deepest value, with the root at depth 0
    // (codec §4.1), so a pre-order walk that carries each value's depth finds it.
    let mut pending: Vec<(&Value, u64)> = vec![(value, 0)];
    while let Some((value, depth)) = pending.pop() {
        occurrences.add(1);
        height.raise_to(depth);
        match value {
            Value::Atom(atom) => {
                let n = atom.len() as u64;
                bytes.add(1 + uvarint_len(n));
                bytes.add(n);
            }
            Value::Tuple(tuple) => {
                bytes.add(1 + uvarint_len(tuple.len() as u64));
                pending.extend(tuple.items().iter().map(|child| (child, depth + 1)));
            }
        }
    }
    let mut exceeded = Vec::new();
    if bytes.over {
        exceeded.push(MeasureKind::EncodedBytes);
    }
    if height.over {
        exceeded.push(MeasureKind::Height);
    }
    if occurrences.over {
        exceeded.push(MeasureKind::Occurrences);
    }
    if exceeded.is_empty() {
        Ok(Measures {
            encoded_bytes: bytes.value,
            occurrences: occurrences.value,
            height: height.value,
        })
    } else {
        Err(MeasureError { exceeded })
    }
}

/// A count that saturates at its bound: once a sum, or a height, passes the bound it is
/// marked over and held at the bound. A partial count past the bound proves the whole is
/// past it too, because every count here only grows, so `over` is exact (§10.2).
struct Saturating {
    value: u64,
    bound: u64,
    over: bool,
}

impl Saturating {
    fn new(bound: u64) -> Self {
        Saturating {
            value: 0,
            bound,
            over: false,
        }
    }

    fn add(&mut self, n: u64) {
        match self.value.checked_add(n) {
            Some(sum) if sum <= self.bound => self.value = sum,
            _ => {
                self.over = true;
                self.value = self.bound;
            }
        }
    }

    fn raise_to(&mut self, n: u64) {
        if n > self.bound {
            self.over = true;
            self.value = self.bound;
        } else if n > self.value {
            self.value = n;
        }
    }
}

/// The length of `n`'s shortest-form uvarint (§3).
fn uvarint_len(mut n: u64) -> u64 {
    let mut len = 1;
    while n >= 0x80 {
        n >>= 7;
        len += 1;
    }
    len
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DecodeError::UnexpectedEof => write!(f, "unexpected end of input"),
            DecodeError::TrailingBytes { offset } => write!(f, "trailing bytes at offset {offset}"),
            DecodeError::UnknownTag { tag, offset } => {
                write!(f, "unknown value tag 0x{tag:02x} at offset {offset}")
            }
            DecodeError::NonCanonicalUvarint { offset } => {
                write!(f, "non-canonical uvarint at offset {offset}")
            }
            DecodeError::UvarintOverflow { offset } => {
                write!(f, "uvarint overflow at offset {offset}")
            }
            DecodeError::LimitExceeded { limit, value, max } => {
                write!(f, "{limit} value {value} exceeds maximum {max}")
            }
        }
    }
}

impl std::error::Error for DecodeError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips() {
        let value = Value::tuple(vec![
            Value::atom(vec![0]),
            Value::tuple(vec![Value::atom(vec![1]), Value::atom(vec![2, 3])]),
            Value::atom(Vec::<u8>::new()),
        ]);
        assert_eq!(decode(&encode(&value)).unwrap(), value);
    }

    #[test]
    fn rejects_noncanonical_uvarint() {
        assert_eq!(
            decode(&[TAG_ATOM, 0x80, 0x00]).unwrap_err().code(),
            "non_canonical_uvarint"
        );
    }

    #[test]
    fn rejects_trailing_bytes() {
        assert_eq!(
            decode(&[TAG_ATOM, 0x00, 0xff]).unwrap_err().code(),
            "trailing_bytes"
        );
    }

    /// ontos-internal#340: encode walks with an explicit stack. A value 10^6 deep encodes byte for byte on
    /// the default test-thread stack; the expected bytes are built by hand (each level is
    /// TAG_TUPLE and arity 1, then TAG_ATOM, length 1, 0x61), not by the encoder.
    #[test]
    fn encodes_a_million_deep_value_without_recursing() {
        const DEEP: usize = 1_000_000;
        let mut value = Value::atom(vec![0x61]);
        for _ in 0..DEEP {
            value = Value::tuple([value]);
        }
        let mut expected = Vec::with_capacity(2 * DEEP + 3);
        for _ in 0..DEEP {
            expected.extend_from_slice(&[TAG_TUPLE, 0x01]);
        }
        expected.extend_from_slice(&[TAG_ATOM, 0x01, 0x61]);
        assert_eq!(encode(&value), expected);
    }

    /// decode walks with an explicit stack as well. A value 10^5 deep, with the depth bound
    /// raised to admit it, decodes on the default test-thread stack and equals the value built
    /// by hand; one level past the bound is still `decode depth`, with the same numbers. The
    /// recursive reader overflows the stack here; on wasm32 it already did at depth 1024.
    #[test]
    fn decodes_a_deep_value_without_recursing() {
        const DEEP: usize = 100_000;
        let mut bytes = Vec::with_capacity(2 * DEEP + 3);
        for _ in 0..DEEP {
            bytes.extend_from_slice(&[TAG_TUPLE, 0x01]);
        }
        bytes.extend_from_slice(&[TAG_ATOM, 0x01, 0x61]);
        let mut expected = Value::atom(vec![0x61]);
        for _ in 0..DEEP {
            expected = Value::tuple([expected]);
        }
        let admit = DecodeLimits {
            max_depth: DEEP,
            ..DecodeLimits::default()
        };
        assert!(decode_with_limits(&bytes, admit).unwrap() == expected);
        let refuse = DecodeLimits {
            max_depth: DEEP - 1,
            ..DecodeLimits::default()
        };
        assert_eq!(
            decode_with_limits(&bytes, refuse).unwrap_err(),
            DecodeError::LimitExceeded {
                limit: "decode depth",
                value: DEEP as u64,
                max: (DEEP - 1) as u64,
            }
        );
    }

    const UNBOUNDED: MeasureBounds = MeasureBounds {
        max_encoded_bytes: u64::MAX,
        max_occurrences: u64::MAX,
        max_height: u64::MAX,
    };

    /// `measure` walks with an explicit stack: a value a million deep, far past the decoder's
    /// depth bound, is measured on the default test-thread stack. Each level is a tag and an
    /// arity of 1 (2 bytes), around Atom(61) (3 bytes).
    #[test]
    fn measures_a_million_deep_value_without_recursing() {
        const DEEP: u64 = 1_000_000;
        let mut value = Value::atom(vec![0x61]);
        for _ in 0..DEEP {
            value = Value::tuple([value]);
        }
        assert_eq!(
            measure(&value, UNBOUNDED).unwrap(),
            Measures {
                encoded_bytes: 2 * DEEP + 3,
                occurrences: DEEP + 1,
                height: DEEP,
            }
        );
        let bounded = MeasureBounds {
            max_height: 1024,
            ..UNBOUNDED
        };
        assert_eq!(
            measure(&value, bounded).unwrap_err().exceeded(),
            [MeasureKind::Height]
        );
    }

    /// A Rust value cannot hold more than memory, so no real walk reaches the u64 ceiling:
    /// the saturating count is checked on its own. Past the bound it is over and held at the
    /// bound, never wrapped.
    #[test]
    fn the_count_saturates_at_the_u64_ceiling() {
        let mut count = Saturating::new(u64::MAX);
        count.add(u64::MAX - 1);
        count.add(1);
        assert_eq!((count.value, count.over), (u64::MAX, false));
        count.add(1);
        assert_eq!((count.value, count.over), (u64::MAX, true));
        count.add(u64::MAX);
        assert_eq!((count.value, count.over), (u64::MAX, true));

        let mut count = Saturating::new(5);
        count.add(5);
        assert!(!count.over);
        count.add(1);
        assert_eq!((count.value, count.over), (5, true));

        let mut height = Saturating::new(3);
        height.raise_to(3);
        height.raise_to(1);
        assert_eq!((height.value, height.over), (3, false));
        height.raise_to(4);
        assert_eq!((height.value, height.over), (3, true));
    }

    #[test]
    fn uvarint_len_matches_encode_uvarint() {
        for n in [0, 1, 0x7f, 0x80, 0x3fff, 0x4000, u64::MAX >> 1, u64::MAX] {
            let mut out = Vec::new();
            encode_uvarint(n, &mut out);
            assert_eq!(uvarint_len(n), out.len() as u64, "{n}");
        }
    }

    /// Zero bounds are zero: every value has at least two encoded bytes and one occurrence.
    #[test]
    fn zero_bounds_and_the_message() {
        let zero = MeasureBounds {
            max_encoded_bytes: 0,
            max_occurrences: 0,
            max_height: 0,
        };
        let err = measure(&Value::tuple(Vec::<Value>::new()), zero).unwrap_err();
        assert_eq!(
            err.exceeded(),
            [MeasureKind::EncodedBytes, MeasureKind::Occurrences]
        );
        assert_eq!(err.to_string(), "over limit: encoded_bytes, occurrences");
    }

    #[test]
    fn encoded_bytes_is_the_encoding_length() {
        let a = Value::atom(*b"abc");
        let value = Value::tuple([
            Value::tuple([a.clone()]),
            Value::tuple([a]),
            Value::tuple(Vec::<Value>::new()),
        ]);
        let got = measure(&value, UNBOUNDED).unwrap();
        assert_eq!(
            got,
            Measures {
                encoded_bytes: 2 + 7 + 7 + 2,
                occurrences: 1 + 2 + 2 + 1,
                height: 2,
            }
        );
        assert_eq!(got.encoded_bytes, encode(&value).len() as u64);
    }
}
