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
//! This codec is kept beside the model (it depends on `ontos-core`, never the
//! reverse). The integer domain and rejection codes are normative in
//! `docs/spec/ontos-codec.md`; conformance is pinned by `vectors/codec.json`.

use core::fmt;
use ontos_core::{Atom, Tuple, Value};

mod progressive;

pub use progressive::{DecodeEvent, EventDecodeError, EventDecoder};

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
    let mut builder = ValueBuilder::default();
    let decoder = EventDecoder::new(input.len(), limits)
        .push(input, &mut |event| builder.event(event))
        .map_err(buffer_decode_error)?;
    decoder.finish().map_err(buffer_decode_error)?;
    Ok(builder.value.expect("a complete decode has one root value"))
}

fn buffer_decode_error(error: EventDecodeError) -> DecodeError {
    match error {
        EventDecodeError::Codec(error) => error,
        EventDecodeError::InputUnderfill { .. } | EventDecodeError::InputOverrun { .. } => {
            unreachable!("the buffer decoder supplies exactly its declared input length")
        }
    }
}

/// Materialization is a sink over the same scanner used by the progressive API.
/// Neither the byte grammar nor its checks are duplicated here.
#[derive(Default)]
struct ValueBuilder {
    tuples: Vec<Vec<Value>>,
    atom: Option<Vec<u8>>,
    value: Option<Value>,
}

impl ValueBuilder {
    fn event(&mut self, event: DecodeEvent<'_>) {
        match event {
            DecodeEvent::TupleStart { arity } => self.tuples.push(Vec::with_capacity(arity)),
            DecodeEvent::TupleEnd => {
                let items = self.tuples.pop().expect("tuple end follows tuple start");
                self.complete(Value::Tuple(Tuple::new(items)));
            }
            DecodeEvent::AtomStart { length } => self.atom = Some(Vec::with_capacity(length)),
            DecodeEvent::AtomChunk(bytes) => self
                .atom
                .as_mut()
                .expect("atom chunks follow atom start")
                .extend_from_slice(bytes),
            DecodeEvent::AtomEnd => {
                let bytes = self.atom.take().expect("atom end follows atom start");
                self.complete(Value::Atom(Atom::new(bytes)));
            }
        }
    }

    fn complete(&mut self, value: Value) {
        if let Some(items) = self.tuples.last_mut() {
            items.push(value);
        } else {
            self.value = Some(value);
        }
    }
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
fn encode_into(value: &Value, out: &mut Vec<u8>) {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Atom(atom) => {
                out.push(TAG_ATOM);
                encode_uvarint(atom.bytes().len() as u64, out);
                out.extend_from_slice(atom.bytes());
            }
            Value::Tuple(tuple) => {
                out.push(TAG_TUPLE);
                encode_uvarint(tuple.len() as u64, out);
                pending.extend(tuple.items().iter().rev());
            }
        }
    }
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
}
