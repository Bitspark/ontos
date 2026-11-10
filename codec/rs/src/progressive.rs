use core::fmt;

use crate::{encode_uvarint, DecodeError, DecodeLimits, TAG_ATOM, TAG_TUPLE};

/// A provisional observation while decoding one value.
///
/// Starts and ends are balanced on a successful complete decode. An empty atom
/// has a start and end with no chunk. Nonempty chunks borrow only the current
/// input slice; their boundaries depend on how the caller divides its input.
/// No event, including the root's end, certifies the complete input. A sink must
/// discard provisional work if decoding, transfer, or its own processing fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeEvent<'a> {
    TupleStart { arity: usize },
    TupleEnd,
    AtomStart { length: usize },
    AtomChunk(&'a [u8]),
    AtomEnd,
}

/// Codec errors retain the existing byte and operational-limit vocabulary.
/// Transfer errors instead report a mismatch with the caller's declared total;
/// they are not evidence about the validity of a complete encoded value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventDecodeError {
    Codec(DecodeError),
    InputUnderfill { expected: usize, received: usize },
    InputOverrun { remaining: usize, supplied: usize },
}

impl From<DecodeError> for EventDecodeError {
    fn from(error: DecodeError) -> Self {
        Self::Codec(error)
    }
}

impl fmt::Display for EventDecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Codec(error) => error.fmt(f),
            Self::InputUnderfill { expected, received } => {
                write!(
                    f,
                    "input transfer expected {expected} bytes, received {received}"
                )
            }
            Self::InputOverrun {
                remaining,
                supplied,
            } => {
                write!(
                    f,
                    "input transfer has {remaining} bytes remaining, supplied {supplied}"
                )
            }
        }
    }
}

impl std::error::Error for EventDecodeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Codec(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Field {
    Atom,
    Tuple,
}

impl Field {
    fn label(self) -> &'static str {
        match self {
            Self::Atom => "atom byte length",
            Self::Tuple => "tuple arity",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Length {
    field: Field,
    offset: usize,
    value: u64,
    shift: u32,
    bytes: [u8; 10],
    count: usize,
}

#[derive(Clone, Copy, Debug)]
enum State {
    Value,
    Length(Length),
    Atom { remaining: usize },
    Complete,
}

/// Decodes one exact-length input without constructing an [`ontos_core::Value`].
///
/// The scanner owns only counters for open tuples and bounded header state. It
/// never owns an atom payload, a child array, an input slice, or the event sink.
/// Retained parser storage grows with nesting depth, not payload length or arity.
/// Canonical header checks use a bounded temporary buffer. A sink can still
/// allocate, including the sink used by [`crate::decode`].
///
/// `logical_len` is the exact total number of encoded bytes, not a chunk size or
/// a maximum. Knowing it preserves the buffer decoder's early extent checks.
/// Offsets are absolute within that input. With the same limits and native
/// width, every partition of an exact-length input has the buffer decoder's
/// codec result. A wrong total is outside that guarantee: an already-detected
/// codec error can terminate before a later transfer mismatch is observable.
/// No byte grammar, default limit, or native field-width check is changed.
///
/// Both operations consume the decoder. An error or sink unwind leaves no
/// resumable decoder. Events remain provisional until [`Self::finish`] succeeds;
/// a consumer with its own semantic errors can retain its first error and ignore
/// later events while allowing codec validation to complete.
///
/// ```
/// use ontos_codec::{DecodeEvent, DecodeLimits, EventDecoder};
/// # fn main() -> Result<(), ontos_codec::EventDecodeError> {
/// let mut payload_bytes = 0;
/// let mut sink = |event: DecodeEvent<'_>| {
///     if let DecodeEvent::AtomChunk(bytes) = event {
///         payload_bytes += bytes.len();
///     }
/// };
/// let decoder = EventDecoder::new(5, DecodeLimits::default());
/// let decoder = decoder.push(&[0, 3, b'a'], &mut sink)?;
/// let decoder = decoder.push(&[b'b', b'c'], &mut sink)?;
/// decoder.finish()?;
/// assert_eq!(payload_bytes, 3);
/// # Ok(())
/// # }
/// ```
///
/// A consumed decoder cannot be reused, even after a failed call:
///
/// ```compile_fail
/// use ontos_codec::{DecodeLimits, EventDecoder};
/// let decoder = EventDecoder::new(1, DecodeLimits::default());
/// let _ = decoder.push(&[0xff], &mut |_| {});
/// let _ = decoder.finish();
/// ```
///
/// Borrowed chunks cannot escape through the universally borrowed sink:
///
/// ```compile_fail
/// use ontos_codec::{DecodeEvent, DecodeLimits, EventDecoder};
/// let mut retained = None;
/// let decoder = EventDecoder::new(3, DecodeLimits::default());
/// let _ = decoder.push(&[0, 1, 42], &mut |event| {
///     if let DecodeEvent::AtomChunk(bytes) = event {
///         retained = Some(bytes);
///     }
/// });
/// ```
#[derive(Debug)]
#[must_use = "only a successful finish validates the complete input"]
pub struct EventDecoder {
    logical_len: usize,
    position: usize,
    limits: DecodeLimits,
    // Remaining children of each open tuple. The next value's depth is len().
    open: Vec<usize>,
    state: State,
}

impl EventDecoder {
    pub fn new(logical_len: usize, limits: DecodeLimits) -> Self {
        Self {
            logical_len,
            position: 0,
            limits,
            open: Vec::new(),
            state: State::Value,
        }
    }

    /// Consume a chunk and return the decoder only if it remains valid so far.
    /// An overrun rejects the entire offending chunk before emitting from it.
    /// Empty chunks are allowed; they do not end an incomplete transfer.
    pub fn push<F>(mut self, chunk: &[u8], emit: &mut F) -> Result<Self, EventDecodeError>
    where
        F: for<'a> FnMut(DecodeEvent<'a>),
    {
        let remaining = self.logical_len - self.position;
        if chunk.len() > remaining {
            return Err(EventDecodeError::InputOverrun {
                remaining,
                supplied: chunk.len(),
            });
        }
        let mut cursor = 0;
        loop {
            match self.state {
                State::Value => {
                    // Preserve depth-before-tag, including before EOF.
                    let depth = self.open.len();
                    if depth > self.limits.max_depth {
                        return Err(DecodeError::LimitExceeded {
                            limit: "decode depth",
                            value: depth as u64,
                            max: self.limits.max_depth as u64,
                        }
                        .into());
                    }
                    let Some(&tag) = chunk.get(cursor) else {
                        return self.need_more();
                    };
                    let offset = self.position;
                    self.position += 1;
                    cursor += 1;
                    let field = match tag {
                        TAG_ATOM => Field::Atom,
                        TAG_TUPLE => Field::Tuple,
                        tag => return Err(DecodeError::UnknownTag { tag, offset }.into()),
                    };
                    self.state = State::Length(Length {
                        field,
                        offset: self.position,
                        value: 0,
                        shift: 0,
                        bytes: [0; 10],
                        count: 0,
                    });
                }
                State::Length(mut length) => {
                    let Some(&byte) = chunk.get(cursor) else {
                        return self.need_more();
                    };
                    self.position += 1;
                    cursor += 1;
                    let low = (byte & 0x7f) as u64;
                    // Read the eleventh byte before reporting overflow. Ten
                    // continuation bytes followed by EOF still report EOF.
                    if length.shift >= 64 || (length.shift == 63 && low > 1) {
                        return Err(DecodeError::UvarintOverflow {
                            offset: length.offset,
                        }
                        .into());
                    }
                    length.bytes[length.count] = byte;
                    length.count += 1;
                    length.value |= low << length.shift;
                    if byte & 0x80 != 0 {
                        length.shift += 7;
                        self.state = State::Length(length);
                        continue;
                    }
                    let mut canonical = Vec::new();
                    encode_uvarint(length.value, &mut canonical);
                    if canonical.as_slice() != &length.bytes[..length.count] {
                        return Err(DecodeError::NonCanonicalUvarint {
                            offset: length.offset,
                        }
                        .into());
                    }
                    // Native narrowing precedes the configured bound, exactly
                    // as in the original buffer reader.
                    let value =
                        usize::try_from(length.value).map_err(|_| DecodeError::LimitExceeded {
                            limit: length.field.label(),
                            value: length.value,
                            max: usize::MAX as u64,
                        })?;
                    let max = match length.field {
                        Field::Atom => self.limits.max_atom_bytes,
                        Field::Tuple => self.limits.max_tuple_arity,
                    };
                    if value > max {
                        return Err(DecodeError::LimitExceeded {
                            limit: length.field.label(),
                            value: value as u64,
                            max: max as u64,
                        }
                        .into());
                    }
                    let remaining = self.logical_len - self.position;
                    match length.field {
                        Field::Atom => {
                            // Equivalent to checked position + length and the
                            // buffer extent comparison, without addition overflow.
                            if value > remaining {
                                return Err(DecodeError::UnexpectedEof.into());
                            }
                            emit(DecodeEvent::AtomStart { length: value });
                            self.state = State::Atom { remaining: value };
                        }
                        Field::Tuple => {
                            // Even a malformed child must not outrank this EOF.
                            if value > remaining / 2 {
                                return Err(DecodeError::UnexpectedEof.into());
                            }
                            emit(DecodeEvent::TupleStart { arity: value });
                            if value == 0 {
                                emit(DecodeEvent::TupleEnd);
                                self.complete(emit);
                            } else {
                                self.open.push(value);
                                self.state = State::Value;
                            }
                        }
                    }
                }
                State::Atom { remaining: 0 } => {
                    emit(DecodeEvent::AtomEnd);
                    self.complete(emit);
                }
                State::Atom { remaining } => {
                    let available = &chunk[cursor..];
                    if available.is_empty() {
                        return Ok(self);
                    }
                    let count = remaining.min(available.len());
                    emit(DecodeEvent::AtomChunk(&available[..count]));
                    self.position += count;
                    cursor += count;
                    self.state = State::Atom {
                        remaining: remaining - count,
                    };
                }
                State::Complete => {
                    if self.position != self.logical_len {
                        return Err(DecodeError::TrailingBytes {
                            offset: self.position,
                        }
                        .into());
                    }
                    return Ok(self);
                }
            }
        }
    }

    /// Finish the exact declared transfer. This is the sole successful terminal
    /// operation; a successful push or a root-end event is only provisional.
    pub fn finish(self) -> Result<(), EventDecodeError> {
        if self.position != self.logical_len {
            return Err(EventDecodeError::InputUnderfill {
                expected: self.logical_len,
                received: self.position,
            });
        }
        match self.state {
            State::Complete => Ok(()),
            _ => Err(DecodeError::UnexpectedEof.into()),
        }
    }

    fn need_more(self) -> Result<Self, EventDecodeError> {
        if self.position == self.logical_len {
            Err(DecodeError::UnexpectedEof.into())
        } else {
            Ok(self)
        }
    }

    fn complete<F>(&mut self, emit: &mut F)
    where
        F: for<'a> FnMut(DecodeEvent<'a>),
    {
        while let Some(remaining) = self.open.last_mut() {
            *remaining -= 1;
            if *remaining != 0 {
                self.state = State::Value;
                return;
            }
            self.open.pop();
            emit(DecodeEvent::TupleEnd);
        }
        self.state = State::Complete;
    }
}
