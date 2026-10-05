//! ontos-data-json/1 — the named, TOTAL projection of a domain-JSON document to an
//! ontos/data value (`docs/spec/ontos-data-json.md`). Rust face; peer of
//! `data/json/go` and `data/json/ts`.
//!
//! This is the first-class, importable realization of that projection, driven by the
//! cross-impl conformance lock in `vectors/data-json.json`. Consumers that need the
//! ontos reading of a JSON value — e.g. domain-separated identity digests — call
//! [`project`] directly instead of re-implementing the walk; a re-implementation is
//! the preimage-drift class this crate exists to remove.
//!
//! The projection is total over the accepted JSON forms and composes the frozen
//! ontos/data primitives (it never re-derives a byte form):
//!
//! ```text
//! JSON object            -> data map        (encode_map)
//! JSON array             -> data list       (encode_list)
//! JSON string            -> utf8-text       (encode_text)
//! JSON integer literal   -> int             (encode_int_bytes, arbitrary precision)
//! JSON true / false      -> bool            (encode_bool)
//! JSON null              -> null()          (encode_null)
//! ```
//!
//! A JSON number carrying a fraction or exponent (`1.5`, `1e3`, `1.0`) falls in the
//! RESERVED decimal arm, which ontos-data-json/1 does not graduate: [`project`]
//! rejects it path-named rather than coercing to a float or a decimal. Acceptance is
//! by the literal FORM, not the numeric value — `1.0` and `1e3` reject even though
//! they are whole numbers.
//!
//! [`project`] reads exactly one JSON document; trailing data after it is rejected.
//!
//! ## Why this crate parses JSON itself, instead of `serde_json`
//!
//! The spec's own-reader hard edge (ontos-internal#224): the profile's acceptance decisions
//! are made on SOURCE distinctions — the number literal's form, and a string's exact
//! content together with the path-named, UTF-16-indexed rejection it must produce
//! when no `utf8-text` reading exists — and `serde_json` destroys the error surface
//! (it rejects a lone surrogate at decode with no JSONPath, no index, no pinnable
//! reason) while its default `Value` also destroys the literal form. The reader
//! below therefore accepts exactly RFC 8259 and nothing more, mirroring the Go and
//! TS peers: number literals are captured verbatim, string content bytes are copied
//! verbatim, and an unpaired `\uXXXX` surrogate escape is decoded to its WTF-8
//! bytes — which no valid UTF-8 string contains — so the walk can reject it
//! path-named with the reason `vectors/data-json.json` pins. Raw invalid UTF-8
//! inside a string literal likewise survives to the walk and is rejected there
//! (ontos-data.md §4.1: a producer must never succeed with a different admissible
//! datum; substituting U+FFFD is exactly that, ontos-internal#216).

use std::collections::BTreeMap;
use std::fmt;

use ontos_core::{Atom, Tuple, Value};
use ontos_data::{
    encode_bool, encode_int_bytes, encode_list, encode_map, encode_null, encode_text,
};

/// A projection failure carrying the JSONPath of the offending node (`$` for the
/// root, `$.key` for an object member, `$[i]` for an array element) and a stable,
/// spec-worded reason. The reason strings are part of the ontos-data-json/1
/// conformance surface — `vectors/data-json.json` pins them — so they are formatted
/// here to match the lock byte-for-byte.
///
/// One representation-bound caveat: when the defective node is an object KEY whose
/// bytes have no UTF-8 reading, the `path` interpolates the key lossily (Rust
/// `String` cannot carry the raw bytes; the Go peer interpolates WTF-8, the TS peer
/// the lone code unit). Paths for that corner are therefore face-divergent and
/// unpinnable; the `reason` stays exact in every face.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProjectionError {
    /// A domain rejection under ontos-data-json/1: the node named by `path` has
    /// no reading, for the pinned `reason`.
    Rejected { path: String, reason: String },
    /// The document exceeded this face's nesting-depth ceiling — an
    /// IMPLEMENTATION BOUND (resource-limit posture, ontos-internal#236), deliberately a
    /// DISTINCT class from `Rejected`: a depth limit does not say the document
    /// is inadmissible under /1 (another conformant face with a higher ceiling
    /// may accept it), so conflating the classes would put the limit into the
    /// profile's semantics. The spec's floor is 512; this face's ceiling is
    /// [`MAX_DEPTH`]. Before this bound, a hostile deeply-nested document was a
    /// stack overflow — in Rust a process ABORT. Mirrors ontos-codec's
    /// decode-limit class (`limit_exceeded`, never a domain error).
    DepthLimit { limit: usize },
    /// The strict-mode refusal (ontos-internal#322): under [`DuplicateKeys::Reject`] the
    /// object at the parent of `path` repeated the member `key`. A SOURCE-ADMISSION
    /// class like `Rejected` — the document was refused, not a resource bound hit —
    /// and deliberately a distinct variant from both `Rejected` (the /1 domain
    /// rejections, whose reasons the vectors pin verbatim) and `DepthLimit`, so a
    /// caller can tell "the admission policy it opted into refused this" from "the
    /// profile has no reading for it". The reader stops at the FIRST repeat it
    /// meets in source order; `path` names that member (e.g. `$.items[1].id`) and
    /// `key` is the name as decoded (lossily, like `path`, when it has no UTF-8
    /// reading).
    DuplicateKey { path: String, key: String },
}

/// This face's nesting-depth ceiling: the deepest object/array nesting
/// [`project`] reads before returning [`ProjectionError::DepthLimit`].
/// Conformance requires accepting at least the spec's floor of 512; the ceiling
/// itself is per-face and never pinned by vectors (stacks differ — the Go face
/// states 10000; the TS face measured its cliff and states 1024). This face
/// states exactly the floor, and the number is measured, not modest: at 1024
/// the ACCEPT path already overruns a default 2 MiB thread stack in debug
/// builds (the projection walk's frames are large), so any higher stated
/// ceiling would be the ontos-internal#236 crash wearing a conformance claim.
pub const MAX_DEPTH: usize = 512;

impl fmt::Display for ProjectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProjectionError::Rejected { path, reason } => write!(f, "{path}: {reason}"),
            ProjectionError::DepthLimit { limit } => write!(
                f,
                "nesting depth exceeds this face's limit ({limit}) — implementation bound, not a rejection of the document under ontos-data-json/1"
            ),
            ProjectionError::DuplicateKey { path, key } => write!(
                f,
                "{path}: duplicate object key {key:?} — rejected under duplicateKeys: reject (the ontos-data-json/1 default is last-wins)"
            ),
        }
    }
}

impl std::error::Error for ProjectionError {}

/// Reads a single domain-JSON document (raw source bytes) and returns its
/// ontos-data-json/1 value. See the crate doc for the arm table and the reserved
/// decimal arm. On any rejected form it returns a [`ProjectionError`] carrying the
/// JSONPath of the offending node.
pub fn project(raw: &[u8]) -> Result<Value, ProjectionError> {
    project_with(raw, Options::default())
}

/// How [`project_with`] treats a JSON object that repeats a member name
/// (ontos-data-json.md §"The projection", *Duplicate object keys*).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DuplicateKeys {
    /// The ontos-data-json/1 default and what [`project`] does: repeated members
    /// collapse to the LAST occurrence at the reader, before any ontos/data value
    /// is built.
    #[default]
    LastWins,
    /// Refuse the document at the first repeated member with
    /// [`ProjectionError::DuplicateKey`]. A stricter SOURCE-ADMISSION policy over
    /// the same mapping, not a different reading: every document it accepts
    /// projects to exactly the value (and bytes) [`project`] emits for it. Names
    /// collide on their exact decoded content — an escaped and a literal spelling
    /// of the same name are one name; two names that differ in bytes are two
    /// names, even when canonically equivalent (no Unicode normalization,
    /// ontos-data §5.2). ontos-internal#322.
    Reject,
}

/// Tunes [`project_with`]. `Options::default()` is exactly [`project`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Options {
    pub duplicate_keys: DuplicateKeys,
}

/// [`project`] with [`Options`]. With the default options it is `project`; with
/// [`DuplicateKeys::Reject`] it additionally returns
/// [`ProjectionError::DuplicateKey`] for a document that repeats an object member.
/// Every other outcome — the accepted value and its bytes, the path-named
/// `Rejected` errors, the `DepthLimit` class — is identical between the two modes.
pub fn project_with(raw: &[u8], opts: Options) -> Result<Value, ProjectionError> {
    let node = read_document(raw, opts.duplicate_keys == DuplicateKeys::Reject)?;
    project_node(&node, "$")
}

/// Wraps a projected value in the era-2 domain-separated preimage
/// `Tuple(Atom(tag), value)`, the shape whose ontos-codec-v1 digest the vectors pin
/// as `era2.digest`. Provided so consumers do not hand-build the wrap and drift.
pub fn era2_preimage(tag: &str, value: Value) -> Value {
    Value::Tuple(Tuple::new(vec![
        Value::Atom(Atom::new(tag.as_bytes().to_vec())),
        value,
    ]))
}

// ---------------------------------------------------------------------------
// JSON reading — literal-preserving, fidelity-preserving, RFC 8259 exact.
// ---------------------------------------------------------------------------

/// The reader's tree. Strings are raw byte sequences, NOT `String`: an unpaired
/// surrogate escape arrives as WTF-8 bytes and raw invalid input bytes arrive
/// verbatim — the walk rejects both path-named. Objects collapse duplicate keys
/// last-wins at the reader (the `BTreeMap` insert), matching the Go and TS peers
/// and the spec's duplicate-keys rule; its ascending byte order is also the walk's
/// deterministic error-path order, matching Go's `sort.Strings`.
enum Node {
    Null,
    Bool(bool),
    Str(Vec<u8>),
    /// A JSON number kept as its source literal (ASCII), never as a float.
    Num(String),
    Arr(Vec<Node>),
    Obj(BTreeMap<Vec<u8>, Node>),
}

/// A malformed-JSON failure; reported `$`-rooted as `invalid JSON: <msg> at offset <n>`.
struct SyntaxError {
    msg: String,
    offset: usize,
}

/// The reader's failure channel: malformed JSON, or the ontos-internal#236 depth bound.
enum ReadFail {
    Syntax(SyntaxError),
    Limit,
    /// Strict mode met a repeated object member (ontos-internal#322).
    DuplicateKey {
        path: String,
        key: String,
    },
}

/// One step of the reader's JSONPath: an object member or an array index.
enum PathSeg {
    Key(Vec<u8>),
    Index(usize),
}

struct Reader<'a> {
    src: &'a [u8],
    i: usize,
    depth: usize,
    /// `DuplicateKeys::Reject`: refuse a repeated object member instead of
    /// collapsing it. `path` is maintained only in strict mode, so the refusal can
    /// name the member; the default reader does not pay for it.
    strict: bool,
    path: Vec<PathSeg>,
}

fn read_document(raw: &[u8], strict: bool) -> Result<Node, ProjectionError> {
    let mut r = Reader {
        src: raw,
        i: 0,
        depth: 0,
        strict,
        path: Vec::new(),
    };
    r.skip_whitespace();
    if r.i >= r.src.len() {
        return Err(ProjectionError::Rejected {
            path: "$".to_string(),
            reason: "empty input: expected one JSON document".to_string(),
        });
    }
    let node = r.read_value().map_err(|e| match e {
        ReadFail::Syntax(se) => ProjectionError::Rejected {
            path: "$".to_string(),
            reason: format!("invalid JSON: {} at offset {}", se.msg, se.offset),
        },
        ReadFail::Limit => ProjectionError::DepthLimit { limit: MAX_DEPTH },
        ReadFail::DuplicateKey { path, key } => ProjectionError::DuplicateKey { path, key },
    })?;
    r.skip_whitespace();
    if r.i < r.src.len() {
        return Err(ProjectionError::Rejected {
            path: "$".to_string(),
            reason: "trailing data after JSON document".to_string(),
        });
    }
    Ok(node)
}

impl<'a> Reader<'a> {
    fn fail<T>(&self, msg: impl Into<String>) -> Result<T, ReadFail> {
        Err(ReadFail::Syntax(SyntaxError {
            msg: msg.into(),
            offset: self.i,
        }))
    }

    /// The JSONPath of member `key` under the current object, in the same
    /// `$.key` / `$[i]` spelling the projection walk uses for its rejections
    /// (lossy for a key with no UTF-8 reading, exactly as the walk's paths are).
    fn member_path(&self, key: &[u8]) -> String {
        let mut out = String::from("$");
        for seg in &self.path {
            match seg {
                PathSeg::Key(k) => {
                    out.push('.');
                    out.push_str(&String::from_utf8_lossy(k));
                }
                PathSeg::Index(i) => out.push_str(&format!("[{i}]")),
            }
        }
        out.push('.');
        out.push_str(&String::from_utf8_lossy(key));
        out
    }

    // The reader is recursive, so this counter is what keeps a hostile document
    // from running the stack out from under every caller (ontos-internal#236). push on entry
    // to read_object/read_array; the matching decrements sit on their Ok exits
    // (an Err aborts the whole parse, so counter state stops mattering — but
    // siblings at ONE level must not accumulate, hence the decrements).
    fn push(&mut self) -> Result<(), ReadFail> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(ReadFail::Limit);
        }
        Ok(())
    }

    fn skip_whitespace(&mut self) {
        while self.i < self.src.len() && matches!(self.src[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn read_value(&mut self) -> Result<Node, ReadFail> {
        if self.i >= self.src.len() {
            return self.fail("unexpected end of input");
        }
        match self.src[self.i] {
            b'{' => self.read_object(),
            b'[' => self.read_array(),
            b'"' => Ok(Node::Str(self.read_string()?)),
            b't' => self.literal("true", Node::Bool(true)),
            b'f' => self.literal("false", Node::Bool(false)),
            b'n' => self.literal("null", Node::Null),
            c if c == b'-' || c.is_ascii_digit() => self.read_number(),
            c => self.fail(format!("unexpected character {:?}", c as char)),
        }
    }

    fn literal(&mut self, word: &str, node: Node) -> Result<Node, ReadFail> {
        if self.src[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(node)
        } else {
            self.fail("invalid literal")
        }
    }

    fn read_object(&mut self) -> Result<Node, ReadFail> {
        self.push()?;
        self.i += 1; // '{'
        let mut out: BTreeMap<Vec<u8>, Node> = BTreeMap::new();
        self.skip_whitespace();
        if self.i < self.src.len() && self.src[self.i] == b'}' {
            self.i += 1;
            self.depth -= 1;
            return Ok(Node::Obj(out));
        }
        loop {
            self.skip_whitespace();
            if self.i >= self.src.len() || self.src[self.i] != b'"' {
                return self.fail("expected object key");
            }
            let key = self.read_string()?;
            if self.strict {
                // Exact decoded content: read_string has already resolved escapes,
                // so "a" and "\u0061" meet here as the same bytes; no normalization.
                if out.contains_key(&key) {
                    return Err(ReadFail::DuplicateKey {
                        path: self.member_path(&key),
                        key: String::from_utf8_lossy(&key).into_owned(),
                    });
                }
                self.path.push(PathSeg::Key(key.clone()));
            }
            self.skip_whitespace();
            if self.i >= self.src.len() || self.src[self.i] != b':' {
                return self.fail("expected ':' after object key");
            }
            self.i += 1;
            self.skip_whitespace();
            let val = self.read_value()?;
            if self.strict {
                self.path.pop();
            }
            out.insert(key, val); // last-wins on duplicate keys (default mode)
            self.skip_whitespace();
            if self.i >= self.src.len() {
                return self.fail("expected ',' or '}' in object");
            }
            match self.src[self.i] {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    self.depth -= 1;
                    return Ok(Node::Obj(out));
                }
                _ => return self.fail("expected ',' or '}' in object"),
            }
        }
    }

    fn read_array(&mut self) -> Result<Node, ReadFail> {
        self.push()?;
        self.i += 1; // '['
        let mut out = Vec::new();
        self.skip_whitespace();
        if self.i < self.src.len() && self.src[self.i] == b']' {
            self.i += 1;
            self.depth -= 1;
            return Ok(Node::Arr(out));
        }
        loop {
            self.skip_whitespace();
            if self.strict {
                self.path.push(PathSeg::Index(out.len()));
            }
            out.push(self.read_value()?);
            if self.strict {
                self.path.pop();
            }
            self.skip_whitespace();
            if self.i >= self.src.len() {
                return self.fail("expected ',' or ']' in array");
            }
            match self.src[self.i] {
                b',' => self.i += 1,
                b']' => {
                    self.i += 1;
                    self.depth -= 1;
                    return Ok(Node::Arr(out));
                }
                _ => return self.fail("expected ',' or ']' in array"),
            }
        }
    }

    /// Decodes one string literal. Content bytes are copied VERBATIM (no
    /// validation, no substitution — fidelity is the point); escapes are decoded
    /// per RFC 8259, with a paired `\uXXXX\uXXXX` surrogate pair combining to one
    /// code point and an unpaired surrogate kept addressable as WTF-8 for the walk
    /// to reject.
    fn read_string(&mut self) -> Result<Vec<u8>, ReadFail> {
        self.i += 1; // opening quote
        let mut b: Vec<u8> = Vec::new();
        loop {
            if self.i >= self.src.len() {
                return self.fail("unterminated string");
            }
            let c = self.src[self.i];
            match c {
                b'"' => {
                    self.i += 1;
                    return Ok(b);
                }
                b'\\' => {
                    self.i += 1;
                    self.append_escape(&mut b)?;
                }
                // RFC 8259: raw control characters below U+0020 must be escaped.
                0x00..=0x1F => return self.fail("unescaped control character in string"),
                _ => {
                    b.push(c);
                    self.i += 1;
                }
            }
        }
    }

    fn append_escape(&mut self, b: &mut Vec<u8>) -> Result<(), ReadFail> {
        if self.i >= self.src.len() {
            return self.fail("unterminated escape");
        }
        let c = self.src[self.i];
        self.i += 1;
        match c {
            b'"' | b'\\' | b'/' => b.push(c),
            b'b' => b.push(0x08),
            b'f' => b.push(0x0C),
            b'n' => b.push(b'\n'),
            b'r' => b.push(b'\r'),
            b't' => b.push(b'\t'),
            b'u' => {
                let u1 = self.hex4()?;
                if (0xD800..=0xDBFF).contains(&u1) {
                    // High surrogate: it pairs with an immediately following
                    // \uXXXX low surrogate into one code point; anything else
                    // leaves it unpaired.
                    if self.i + 1 < self.src.len()
                        && self.src[self.i] == b'\\'
                        && self.src[self.i + 1] == b'u'
                    {
                        let save = self.i;
                        self.i += 2;
                        let u2 = self.hex4()?;
                        if (0xDC00..=0xDFFF).contains(&u2) {
                            let cp = 0x10000
                                + ((u32::from(u1) - 0xD800) << 10)
                                + (u32::from(u2) - 0xDC00);
                            // Supplementary-plane code points are always valid chars.
                            let ch = char::from_u32(cp)
                                .expect("paired surrogates form a valid code point");
                            push_char(b, ch);
                            return Ok(());
                        }
                        self.i = save; // not the pair's low half — that escape reads on its own
                    }
                    push_wtf8(b, u1);
                } else if (0xDC00..=0xDFFF).contains(&u1) {
                    push_wtf8(b, u1); // low surrogate with no preceding high
                } else {
                    // Non-surrogate BMP code units are always valid chars.
                    let ch = char::from_u32(u32::from(u1)).expect("non-surrogate BMP code unit");
                    push_char(b, ch);
                }
            }
            _ => return self.fail(format!("invalid escape \\{}", c as char)),
        }
        Ok(())
    }

    fn hex4(&mut self) -> Result<u16, ReadFail> {
        if self.i + 4 > self.src.len() {
            return self.fail("invalid \\u escape");
        }
        let mut v: u16 = 0;
        for k in 0..4 {
            let d = match self.src[self.i + k] {
                c @ b'0'..=b'9' => c - b'0',
                c @ b'a'..=b'f' => c - b'a' + 10,
                c @ b'A'..=b'F' => c - b'A' + 10,
                _ => return self.fail("invalid \\u escape"),
            };
            v = (v << 4) | u16::from(d);
        }
        self.i += 4;
        Ok(v)
    }

    /// Captures the number literal verbatim, per the RFC 8259 grammar.
    fn read_number(&mut self) -> Result<Node, ReadFail> {
        let start = self.i;
        if self.src[self.i] == b'-' {
            self.i += 1;
        }
        // int: 0 | [1-9][0-9]*  — a leading zero may not be followed by digits.
        match self.src.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                while self.i < self.src.len() && self.src[self.i].is_ascii_digit() {
                    self.i += 1;
                }
            }
            _ => return self.fail("expected digit in number"),
        }
        // frac
        if self.src.get(self.i) == Some(&b'.') {
            self.i += 1;
            if !self.src.get(self.i).is_some_and(u8::is_ascii_digit) {
                return self.fail("expected digit after '.' in number");
            }
            while self.i < self.src.len() && self.src[self.i].is_ascii_digit() {
                self.i += 1;
            }
        }
        // exp
        if matches!(self.src.get(self.i), Some(b'e') | Some(b'E')) {
            self.i += 1;
            if matches!(self.src.get(self.i), Some(b'+') | Some(b'-')) {
                self.i += 1;
            }
            if !self.src.get(self.i).is_some_and(u8::is_ascii_digit) {
                return self.fail("expected digit in number exponent");
            }
            while self.i < self.src.len() && self.src[self.i].is_ascii_digit() {
                self.i += 1;
            }
        }
        // The literal is ASCII by the grammar above.
        let lit =
            String::from_utf8(self.src[start..self.i].to_vec()).expect("number literal is ASCII");
        Ok(Node::Num(lit))
    }
}

fn push_char(b: &mut Vec<u8>, ch: char) {
    let mut buf = [0u8; 4];
    b.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
}

/// Appends the WTF-8 (UTF-8-shaped, but invalid) encoding of a lone surrogate code
/// unit. No valid UTF-8 string contains these bytes, so the walk can recover the
/// exact code unit for the pinned rejection reason.
fn push_wtf8(b: &mut Vec<u8>, u: u16) {
    b.push(0xE0 | (u >> 12) as u8);
    b.push(0x80 | ((u >> 6) & 0x3F) as u8);
    b.push(0x80 | (u & 0x3F) as u8);
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

fn project_node(node: &Node, path: &str) -> Result<Value, ProjectionError> {
    match node {
        Node::Null => Ok(encode_null()),
        Node::Bool(v) => Ok(encode_bool(*v)),
        Node::Str(bytes) => project_text(bytes, path),
        Node::Num(lit) => project_number(lit, path),
        Node::Arr(elems) => {
            let mut values = Vec::with_capacity(elems.len());
            for (i, e) in elems.iter().enumerate() {
                values.push(project_node(e, &format!("{path}[{i}]"))?);
            }
            Ok(encode_list(&values))
        }
        Node::Obj(map) => {
            // BTreeMap iterates in ascending key-byte order — the deterministic
            // error-path order when a document has more than one offending node
            // (matches Go's sort.Strings); it does not affect the emitted bytes,
            // because encode_map re-sorts entries canonically by encoded key.
            // Duplicate JSON keys already collapsed last-wins in the reader, so
            // the map is duplicate-free before encode_map ever sees it.
            let mut entries: Vec<(Value, Value)> = Vec::with_capacity(map.len());
            for (k, v) in map {
                let child_path = format!("{path}.{}", String::from_utf8_lossy(k));
                let child = project_node(v, &child_path)?;
                let key = project_text(k, &child_path)?;
                entries.push((key, child));
            }
            encode_map(&entries).map_err(|e| ProjectionError::Rejected {
                path: path.to_string(),
                reason: e.to_string(), // unreachable: the reader deduplicated keys
            })
        }
    }
}

/// The first datum-destroying defect in a string's bytes, if any.
enum TextDefect {
    /// A WTF-8-encoded surrogate — the trace the reader leaves for an unpaired
    /// `\uXXXX` surrogate escape — with its code unit and UTF-16 code-unit index
    /// (the coordinates the TS peer naturally reports, since a JS string holds the
    /// lone code unit directly; the Go peer computes the same).
    Surrogate { unit: u16, index: usize },
    /// Raw bytes with no UTF-8 reading (byte-level, not escape-level).
    InvalidBytes,
}

/// Reads a string node as utf8-text, enforcing the ontos-data.md §4.1 fidelity law
/// (ontos-internal#216): a string with no UTF-8 encoding is REJECTED path-named, never
/// coerced to U+FFFD — the substitution would succeed with a different admissible
/// datum, invisible to every caller of an identity-digest projection. The
/// unpaired-surrogate reason is pinned by `vectors/data-json.json`, shared
/// byte-for-byte with the Go and TS peers.
fn project_text(bytes: &[u8], path: &str) -> Result<Value, ProjectionError> {
    match text_defect(bytes) {
        Some(TextDefect::Surrogate { unit, index }) => Err(ProjectionError::Rejected {
            path: path.to_string(),
            reason: format!(
                "unpaired surrogate 0x{unit:04x} at UTF-16 index {index} — the string has no UTF-8 encoding, rejected under ontos-data-json/1 (U+FFFD coercion violates the ontos-data.md §4.1 fidelity law)"
            ),
        }),
        // The byte-level class. Rust's encode_text takes &str and so cannot even
        // receive these bytes; the projection names the defect itself, wording
        // matched to the Go peer's data-layer refusal so the two byte-input faces
        // fail identically (unpinned by vectors — a JSON-hosted corpus cannot
        // carry the case — pinned by unit tests in both faces).
        Some(TextDefect::InvalidBytes) => Err(ProjectionError::Rejected {
            path: path.to_string(),
            reason: "ontos/data: not a well-formed utf8-text: producer: string is not valid UTF-8"
                .to_string(),
        }),
        None => {
            let s = std::str::from_utf8(bytes).expect("defect scan proved valid UTF-8");
            Ok(encode_text(s))
        }
    }
}

/// Scans for the first defect, tracking the UTF-16 code-unit index. A hand-rolled
/// decoder because the distinction it draws — WTF-8 surrogate vs plain invalid
/// bytes — is exactly what `std`'s validators erase.
fn text_defect(bytes: &[u8]) -> Option<TextDefect> {
    let mut i = 0;
    let mut u16_index = 0usize;
    while i < bytes.len() {
        let b0 = bytes[i];
        let cont = |k: usize| bytes.get(i + k).is_some_and(|b| (0x80..=0xBF).contains(b));
        match b0 {
            0x00..=0x7F => {
                i += 1;
                u16_index += 1;
            }
            0xC2..=0xDF if cont(1) => {
                i += 2;
                u16_index += 1;
            }
            0xE0 if bytes.get(i + 1).is_some_and(|b| (0xA0..=0xBF).contains(b)) && cont(2) => {
                i += 3;
                u16_index += 1;
            }
            0xED => {
                let b1 = bytes.get(i + 1).copied();
                if b1.is_some_and(|b| (0xA0..=0xBF).contains(&b)) && cont(2) {
                    // The WTF-8 encoding of a surrogate code point.
                    let unit = 0xD000
                        | (u16::from(bytes[i + 1] & 0x3F) << 6)
                        | u16::from(bytes[i + 2] & 0x3F);
                    return Some(TextDefect::Surrogate {
                        unit,
                        index: u16_index,
                    });
                }
                if b1.is_some_and(|b| (0x80..=0x9F).contains(&b)) && cont(2) {
                    i += 3;
                    u16_index += 1;
                } else {
                    return Some(TextDefect::InvalidBytes);
                }
            }
            0xE1..=0xEF if cont(1) && cont(2) => {
                // 0xED handled above; remaining three-byte leads take 80..=BF.
                i += 3;
                u16_index += 1;
            }
            0xF0 if bytes.get(i + 1).is_some_and(|b| (0x90..=0xBF).contains(b))
                && cont(2)
                && cont(3) =>
            {
                i += 4;
                u16_index += 2;
            }
            0xF1..=0xF3 if cont(1) && cont(2) && cont(3) => {
                i += 4;
                u16_index += 2;
            }
            0xF4 if bytes.get(i + 1).is_some_and(|b| (0x80..=0x8F).contains(b))
                && cont(2)
                && cont(3) =>
            {
                i += 4;
                u16_index += 2;
            }
            _ => return Some(TextDefect::InvalidBytes),
        }
    }
    None
}

/// Reads a JSON number literal. An integer literal (`^-?[0-9]+$`) maps to ontos
/// int at arbitrary precision (the §5.1 byte form is unbounded; `encode_int_bytes`
/// avoids any host-width ceiling); any literal carrying a fraction or exponent is
/// the reserved decimal arm and is rejected path-named. The classification is
/// lexical — the literal string, not its numeric value — so `1e3` and `1.0` reject
/// like `3.14`.
fn project_number(lit: &str, path: &str) -> Result<Value, ProjectionError> {
    if lit.contains(['.', 'e', 'E']) {
        return Err(ProjectionError::Rejected {
            path: path.to_string(),
            reason: format!(
                "non-integer number literal \"{lit}\" — fraction/exponent rejected under ontos-data-json/1 (reserved decimal arm ungraduated)"
            ),
        });
    }
    let malformed = || ProjectionError::Rejected {
        path: path.to_string(),
        reason: format!("malformed integer literal \"{lit}\""),
    };
    // A literal without . e or E that this split cannot parse should not occur for
    // well-formed JSON, but fail loudly rather than emit an unlocked shape.
    let (negative, digits) = match lit.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, lit),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(malformed());
    }
    let magnitude = decimal_to_be_bytes(digits);
    // Canonical zero is non-negative ("-0" is the literal `-0`, a valid RFC 8259
    // number whose value is zero — big-integer parity with the Go peer).
    let negative = negative && !magnitude.is_empty();
    encode_int_bytes(negative, &magnitude).map_err(|_| malformed())
}

/// Converts an ASCII decimal-digit string to big-endian minimal magnitude bytes
/// (empty for zero) by schoolbook division by 256. Arbitrary precision with no
/// dependency; the corpus already carries 2^127, one past `i128::MAX`.
fn decimal_to_be_bytes(digits: &str) -> Vec<u8> {
    let mut num: Vec<u8> = digits.bytes().map(|b| b - b'0').collect();
    // Drop leading zero digits so the loop terminates on true zero. (The grammar
    // only permits a leading zero in the literal "0" / "-0" itself.)
    let first_nonzero = num.iter().position(|&d| d != 0).unwrap_or(num.len());
    num.drain(..first_nonzero);
    let mut out = Vec::new();
    while !num.is_empty() {
        let mut rem: u32 = 0;
        let mut quotient: Vec<u8> = Vec::with_capacity(num.len());
        for &d in &num {
            let cur = rem * 10 + u32::from(d);
            let q = cur / 256;
            rem = cur % 256;
            if !quotient.is_empty() || q != 0 {
                quotient.push(q as u8);
            }
        }
        out.push(rem as u8);
        num = quotient;
    }
    out.reverse();
    out
}
