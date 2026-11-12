//! The refusal record shared by both profiles (total §8, readable §8, total §10 "Errors").

use core::fmt;

/// Which JSON profile produced a refusal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Profile {
    /// `ontos-total-json/1`.
    Total,
    /// `ontos-readable-json/1`.
    Readable,
}

impl Profile {
    /// The profile id, as the spec pages and the other faces spell it.
    pub fn id(self) -> &'static str {
        match self {
            Profile::Total => "ontos-total-json/1",
            Profile::Readable => "ontos-readable-json/1",
        }
    }
}

impl fmt::Display for Profile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.id())
    }
}

/// A refusal code (total §8.4, readable §8). The codes are fixed for `/1`; the enum is
/// `#[non_exhaustive]` because a later profile may append codes, never reassign them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum Code {
    /// An operational bound was reached; [`Error::kind`] names it.
    LimitExceeded,
    /// The input is not well-formed UTF-8.
    InvalidUtf8,
    /// The input begins with U+FEFF.
    ByteOrderMark,
    /// The input is not an RFC 8259 JSON text with RFC 8259 whitespace.
    InvalidJson,
    /// A `\u` escape names a lone surrogate.
    InvalidUnicodeEscape,
    /// An object repeats a member name after escape decoding.
    DuplicateMember,
    /// Something other than whitespace follows the value.
    TrailingData,
    /// A node is not exactly `{"atom": string}` or `{"tuple": array}`.
    InvalidTotalForm,
    /// An atom string is not even-length lowercase hexadecimal.
    InvalidHex,
    /// A number literal has a fraction or an exponent (readable).
    InvalidNumber,
    /// A bare integer literal lies outside ±(2⁵³ − 1) (readable).
    UnsafeIntegerLiteral,
    /// A malformed envelope, or an object with `$ontos` and another member (readable).
    InvalidEnvelope,
    /// The tag name is not one of the seven (readable).
    UnknownTag,
    /// Wrong arity, a payload of the wrong JSON kind, or a malformed label (readable).
    InvalidTag,
    /// An integer string is not canonical decimal text (readable).
    InvalidInteger,
    /// Decimal components that are canonical integers but not the canonical pair (readable).
    NoncanonicalDecimal,
    /// A base64 string that is not canonical padded standard base64 (readable).
    InvalidBase64,
    /// A `map` tag repeats a key, by ground-value equality (readable).
    DuplicateMapKey,
    /// A `set` tag repeats an element, by ground-value equality (readable).
    DuplicateSetElement,
}

impl Code {
    /// The stable lowercase code.
    pub fn as_str(self) -> &'static str {
        match self {
            Code::LimitExceeded => "limit_exceeded",
            Code::InvalidUtf8 => "invalid_utf8",
            Code::ByteOrderMark => "byte_order_mark",
            Code::InvalidJson => "invalid_json",
            Code::InvalidUnicodeEscape => "invalid_unicode_escape",
            Code::DuplicateMember => "duplicate_member",
            Code::TrailingData => "trailing_data",
            Code::InvalidTotalForm => "invalid_total_form",
            Code::InvalidHex => "invalid_hex",
            Code::InvalidNumber => "invalid_number",
            Code::UnsafeIntegerLiteral => "unsafe_integer_literal",
            Code::InvalidEnvelope => "invalid_envelope",
            Code::UnknownTag => "unknown_tag",
            Code::InvalidTag => "invalid_tag",
            Code::InvalidInteger => "invalid_integer",
            Code::NoncanonicalDecimal => "noncanonical_decimal",
            Code::InvalidBase64 => "invalid_base64",
            Code::DuplicateMapKey => "duplicate_map_key",
            Code::DuplicateSetElement => "duplicate_set_element",
        }
    }
}

impl fmt::Display for Code {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The bound a `limit_exceeded` refusal names (total §9.1, readable §9). The kinds share
/// the codec's namespace (`ontos-codec.md` §4.2) and its rule: append-only, never
/// reassigned, hence `#[non_exhaustive]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum LimitKind {
    /// `max_text_bytes`: bytes of the input text (reader) or of the output text (writer).
    TextBytes,
    /// `max_json_depth`: arrays and objects open at once.
    JsonDepth,
    /// `max_value_depth`: how deep the value is nested, the root at depth 0.
    DecodeDepth,
    /// `max_atom_bytes`: the byte length of an atom.
    AtomBytes,
    /// `max_tuple_arity`: the arity of a tuple.
    TupleArity,
    /// `max_integer_digits`: the decimal digits of an integer's magnitude (readable).
    IntegerDigits,
}

impl LimitKind {
    /// The kind's identifier, as the spec and the other faces spell it.
    pub fn as_str(self) -> &'static str {
        match self {
            LimitKind::TextBytes => "text_bytes",
            LimitKind::JsonDepth => "json_depth",
            LimitKind::DecodeDepth => "decode_depth",
            LimitKind::AtomBytes => "atom_bytes",
            LimitKind::TupleArity => "tuple_arity",
            LimitKind::IntegerDigits => "integer_digits",
        }
    }
}

impl fmt::Display for LimitKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One typed segment of a JSON path (total §8.2): a member name, as its decoded string,
/// or an array index. A member named `"0"` is `Name("0")`, never `Index(0)`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Segment {
    /// A step into an object, by the member's decoded name.
    Name(String),
    /// A step into an array, counting from 0.
    Index(usize),
}

impl fmt::Display for Segment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Segment::Name(name) => write!(f, "{name:?}"),
            Segment::Index(index) => write!(f, "{index}"),
        }
    }
}

/// A zero-based, half-open UTF-8 byte span `[start, end)` of the input (total §8.3).
/// `start == end == n` marks the end of an input of `n` bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub(crate) fn new(start: usize, end: usize) -> Self {
        Span { start, end }
    }
}

/// A refusal of either profile, from a reader or a writer.
///
/// `profile`, `code`, `path`, `span` and `kind` are normative for a reader and pinned by
/// the vectors. A writer refusal has no span, and its path is informative: the path, in
/// the output, of the node being written (total §9.3). The message is for people only:
/// its wording may change, and nobody may parse it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error {
    profile: Profile,
    code: Code,
    path: Vec<Segment>,
    span: Option<Span>,
    kind: Option<LimitKind>,
    message: String,
}

impl Error {
    /// The profile that refused.
    pub fn profile(&self) -> Profile {
        self.profile
    }

    /// The refusal code.
    pub fn code(&self) -> Code {
        self.code
    }

    /// The typed path of the refusal (total §8.2).
    pub fn path(&self) -> &[Segment] {
        &self.path
    }

    /// The input span of a reader refusal; `None` for a writer refusal, which has no input.
    pub fn span(&self) -> Option<Span> {
        self.span
    }

    /// The limit kind of a `limit_exceeded` refusal; `None` for every other code.
    pub fn kind(&self) -> Option<LimitKind> {
        self.kind
    }

    /// A human-readable explanation. Not normative.
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.profile, self.code)?;
        if let Some(kind) = self.kind {
            write!(f, " ({kind})")?;
        }
        f.write_str(" at [")?;
        for (i, segment) in self.path.iter().enumerate() {
            if i > 0 {
                f.write_str(", ")?;
            }
            write!(f, "{segment}")?;
        }
        f.write_str("]")?;
        if let Some(span) = self.span {
            write!(f, ", bytes {}..{}", span.start, span.end)?;
        }
        write!(f, ": {}", self.message)
    }
}

impl std::error::Error for Error {}

/// A refusal before the profile is attached: the shared stages (1 to 3) and the
/// interpreters produce these, and the public entry points name the profile.
#[derive(Debug)]
pub(crate) struct Fault {
    code: Code,
    path: Vec<Segment>,
    span: Option<Span>,
    kind: Option<LimitKind>,
    message: String,
}

impl Fault {
    pub(crate) fn new(
        code: Code,
        path: Vec<Segment>,
        span: Span,
        message: impl Into<String>,
    ) -> Self {
        Fault {
            code,
            path,
            span: Some(span),
            kind: None,
            message: message.into(),
        }
    }

    pub(crate) fn limit(kind: LimitKind, path: Vec<Segment>, span: Option<Span>) -> Self {
        Fault {
            code: Code::LimitExceeded,
            path,
            span,
            kind: Some(kind),
            message: limit_message(kind).to_owned(),
        }
    }

    pub(crate) fn into_error(self, profile: Profile) -> Error {
        Error {
            profile,
            code: self.code,
            path: self.path,
            span: self.span,
            kind: self.kind,
            message: self.message,
        }
    }
}

fn limit_message(kind: LimitKind) -> &'static str {
    match kind {
        LimitKind::TextBytes => "the text is longer than max_text_bytes",
        LimitKind::JsonDepth => "more arrays and objects are open at once than max_json_depth",
        LimitKind::DecodeDepth => "the value is nested deeper than max_value_depth",
        LimitKind::AtomBytes => "an atom is longer than max_atom_bytes",
        LimitKind::TupleArity => "a tuple has more children than max_tuple_arity",
        LimitKind::IntegerDigits => "an integer has more decimal digits than max_integer_digits",
    }
}
