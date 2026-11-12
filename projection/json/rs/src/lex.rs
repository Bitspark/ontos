//! Stage 3 of total §4.1: the strict JSON reading of total §4.3, shared by both profiles.
//!
//! The reader follows the page's procedure step by step, so that every refusal has the
//! code, path and span the procedure assigns. It keeps an explicit stack of the open
//! arrays and objects and never recurses, so its depth is bounded only by
//! `max_json_depth` (total §9.2: no reliance on native recursion). It builds a flat
//! arena of nodes, children before parents, which drops without recursion too.

use std::collections::HashSet;

use crate::error::{Code, Fault, LimitKind, Segment, Span};

/// The JSON tree of a text: its nodes, each with its span, and the root's index.
pub(crate) struct Tree<'a> {
    pub text: &'a str,
    pub nodes: Vec<Node>,
    pub root: usize,
}

pub(crate) struct Node {
    /// A string's from its opening to its closing quotation mark, a number's or a
    /// literal's lexeme, an object's or array's from bracket to bracket inclusive.
    pub span: Span,
    pub kind: Kind,
}

pub(crate) enum Kind {
    Null,
    True,
    False,
    /// The decoded content: Unicode scalar values only, since stage 3 refuses lone
    /// surrogates.
    Str(String),
    /// A number; its lexeme is the text at the node's span.
    Num,
    Arr(Vec<usize>),
    Obj(Vec<Member>),
}

pub(crate) struct Member {
    pub name: String,
    /// The name's token, from its opening to its closing quotation mark.
    pub name_span: Span,
    pub value: usize,
}

impl Tree<'_> {
    /// The lexeme of a number node.
    pub fn lexeme(&self, node: usize) -> &str {
        let span = self.nodes[node].span;
        &self.text[span.start..span.end]
    }
}

/// Reads one JSON text under the strict reading, or returns the refusal the procedure of
/// total §4.3 defines. `text` is already known to be well-formed UTF-8 (stage 2).
pub(crate) fn read(text: &str, max_json_depth: u64) -> Result<Tree<'_>, Fault> {
    let b = text.as_bytes();
    if b.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(Fault::new(
            Code::ByteOrderMark,
            Vec::new(),
            Span::new(0, 3),
            "the text begins with a byte order mark (U+FEFF)",
        ));
    }
    let mut lexer = Lexer {
        text,
        b,
        p: 0,
        frames: Vec::new(),
        nodes: Vec::new(),
        max_depth: max_json_depth,
    };
    lexer.ws();
    let root = lexer.value_tree()?;
    lexer.ws();
    if lexer.p < b.len() {
        return Err(Fault::new(
            Code::TrailingData,
            Vec::new(),
            Span::new(lexer.p, b.len()),
            "something other than whitespace follows the value",
        ));
    }
    Ok(Tree {
        text,
        nodes: lexer.nodes,
        root,
    })
}

enum Frame {
    Obj {
        start: usize,
        members: Vec<Member>,
        names: HashSet<String>,
        /// The member whose value is being read: its name and its token's span.
        current: Option<(String, Span)>,
    },
    Arr {
        start: usize,
        items: Vec<usize>,
    },
}

/// Whose path a refusal inside a string names (total §4.3): the value being read, or,
/// for a member name, the object's.
#[derive(Clone, Copy)]
enum At {
    Value,
    Container,
}

struct Lexer<'a> {
    text: &'a str,
    b: &'a [u8],
    p: usize,
    frames: Vec<Frame>,
    nodes: Vec<Node>,
    max_depth: u64,
}

fn is_ws(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\n' | b'\r')
}

fn hex_digit(c: u8) -> Option<u32> {
    match c {
        b'0'..=b'9' => Some(u32::from(c - b'0')),
        b'a'..=b'f' => Some(u32::from(c - b'a') + 10),
        b'A'..=b'F' => Some(u32::from(c - b'A') + 10),
        _ => None,
    }
}

impl Lexer<'_> {
    fn n(&self) -> usize {
        self.b.len()
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.p).copied()
    }

    fn ws(&mut self) {
        while self.p < self.n() && is_ws(self.b[self.p]) {
            self.p += 1;
        }
    }

    /// The span of the character at `q`, or `[n, n)` at the end of the input.
    fn char_span(&self, q: usize) -> Span {
        let n = self.n();
        if q >= n {
            return Span::new(n, n);
        }
        let lead = self.b[q];
        let len = if lead < 0x80 {
            1
        } else if lead < 0xe0 {
            2
        } else if lead < 0xf0 {
            3
        } else {
            4
        };
        Span::new(q, q + len)
    }

    fn end_span(&self) -> Span {
        Span::new(self.n(), self.n())
    }

    /// The path of the value being read: one segment per open array or object.
    fn value_path(&self) -> Vec<Segment> {
        self.frames.iter().map(frame_segment).collect()
    }

    /// The path of the innermost open array or object itself.
    fn container_path(&self) -> Vec<Segment> {
        let open = self.frames.len().saturating_sub(1);
        self.frames[..open].iter().map(frame_segment).collect()
    }

    fn path(&self, at: At) -> Vec<Segment> {
        match at {
            At::Value => self.value_path(),
            At::Container => self.container_path(),
        }
    }

    fn json_fault(&self, at: At, span: Span, message: &str) -> Fault {
        Fault::new(Code::InvalidJson, self.path(at), span, message)
    }

    fn push(&mut self, span: Span, kind: Kind) -> usize {
        self.nodes.push(Node { span, kind });
        self.nodes.len() - 1
    }

    /// Reads the root value and everything inside it, with an explicit stack.
    fn value_tree(&mut self) -> Result<usize, Fault> {
        'value: loop {
            // Read a value at the current path, enclosed by `frames.len()` containers.
            let mut done = match self.peek() {
                None => {
                    return Err(self.json_fault(
                        At::Value,
                        self.end_span(),
                        "the text ends where a value was expected",
                    ))
                }
                Some(b'{') => {
                    self.open(true)?;
                    if self.peek() == Some(b'}') {
                        self.p += 1;
                        self.close()
                    } else {
                        self.member_name()?;
                        continue 'value;
                    }
                }
                Some(b'[') => {
                    self.open(false)?;
                    if self.peek() == Some(b']') {
                        self.p += 1;
                        self.close()
                    } else {
                        continue 'value;
                    }
                }
                Some(b'"') => {
                    let start = self.p;
                    let content = self.string(At::Value)?;
                    self.push(Span::new(start, self.p), Kind::Str(content))
                }
                Some(b't') => self.literal(b"true", Kind::True)?,
                Some(b'f') => self.literal(b"false", Kind::False)?,
                Some(b'n') => self.literal(b"null", Kind::Null)?,
                Some(c) if c == b'-' || c.is_ascii_digit() => self.number()?,
                Some(_) => {
                    return Err(self.json_fault(
                        At::Value,
                        self.char_span(self.p),
                        "no JSON value starts with this character",
                    ))
                }
            };
            // A value is complete: hand it to the open container, closing each container
            // it completes.
            loop {
                let Some(frame) = self.frames.last_mut() else {
                    return Ok(done);
                };
                match frame {
                    Frame::Obj {
                        members, current, ..
                    } => {
                        let (name, name_span) =
                            current.take().expect("a member value has its name");
                        members.push(Member {
                            name,
                            name_span,
                            value: done,
                        });
                        self.ws();
                        match self.peek() {
                            Some(b',') => {
                                self.p += 1;
                                self.ws();
                                self.member_name()?;
                                continue 'value;
                            }
                            Some(b'}') => {
                                self.p += 1;
                                done = self.close();
                            }
                            _ => {
                                return Err(self.json_fault(
                                    At::Container,
                                    self.char_span(self.p),
                                    "expected ',' or '}' after an object member",
                                ))
                            }
                        }
                    }
                    Frame::Arr { items, .. } => {
                        items.push(done);
                        self.ws();
                        match self.peek() {
                            Some(b',') => {
                                self.p += 1;
                                self.ws();
                                continue 'value;
                            }
                            Some(b']') => {
                                self.p += 1;
                                done = self.close();
                            }
                            _ => {
                                return Err(self.json_fault(
                                    At::Container,
                                    self.char_span(self.p),
                                    "expected ',' or ']' after an array element",
                                ))
                            }
                        }
                    }
                }
            }
        }
    }

    /// Opens the object or array whose bracket is at `p`, after checking its depth, and
    /// skips the whitespace after the bracket.
    fn open(&mut self, object: bool) -> Result<(), Fault> {
        let k = self.frames.len() as u64;
        if k + 1 > self.max_depth {
            return Err(Fault::limit(
                LimitKind::JsonDepth,
                self.value_path(),
                Some(Span::new(self.p, self.p + 1)),
            ));
        }
        let start = self.p;
        self.frames.push(if object {
            Frame::Obj {
                start,
                members: Vec::new(),
                names: HashSet::new(),
                current: None,
            }
        } else {
            Frame::Arr {
                start,
                items: Vec::new(),
            }
        });
        self.p += 1;
        self.ws();
        Ok(())
    }

    /// Closes the innermost container, whose closing bracket was just consumed.
    fn close(&mut self) -> usize {
        let frame = self.frames.pop().expect("a container is open");
        let (start, kind) = match frame {
            Frame::Obj { start, members, .. } => (start, Kind::Obj(members)),
            Frame::Arr { start, items } => (start, Kind::Arr(items)),
        };
        self.push(Span::new(start, self.p), kind)
    }

    /// Steps 1 to 3 of a member (total §4.3): the name, the repeated-name check, and the
    /// name separator, leaving `p` at the member's value.
    fn member_name(&mut self) -> Result<(), Fault> {
        if self.peek() != Some(b'"') {
            return Err(self.json_fault(
                At::Container,
                self.char_span(self.p),
                "expected a member name in quotation marks",
            ));
        }
        let start = self.p;
        let name = self.string(At::Container)?;
        let name_span = Span::new(start, self.p);
        let Some(Frame::Obj { names, current, .. }) = self.frames.last_mut() else {
            unreachable!("a member name is read inside an object");
        };
        if names.contains(&name) {
            let mut path = self.container_path();
            path.push(Segment::Name(name));
            return Err(Fault::new(
                Code::DuplicateMember,
                path,
                name_span,
                "the object repeats this member name (compared after escape decoding)",
            ));
        }
        names.insert(name.clone());
        *current = Some((name, name_span));
        self.ws();
        if self.peek() != Some(b':') {
            return Err(self.json_fault(
                At::Value,
                self.char_span(self.p),
                "expected ':' after the member name",
            ));
        }
        self.p += 1;
        self.ws();
        Ok(())
    }

    /// Four hexadecimal digits at `at`, or the refusal for the first missing or
    /// non-hexadecimal one.
    fn hex4(&self, at: usize, path: At) -> Result<u32, Fault> {
        let mut cp = 0;
        for q in at..at + 4 {
            if q >= self.n() {
                return Err(self.json_fault(
                    path,
                    self.end_span(),
                    "the text ends inside a \\u escape",
                ));
            }
            let Some(d) = hex_digit(self.b[q]) else {
                return Err(self.json_fault(
                    path,
                    self.char_span(q),
                    "a \\u escape needs four hexadecimal digits",
                ));
            };
            cp = cp * 16 + d;
        }
        Ok(cp)
    }

    /// Whether the six bytes at `q` are `\u` and four hexadecimal digits naming a low
    /// surrogate; its code point if so.
    fn low_surrogate_at(&self, q: usize) -> Option<u32> {
        let b = self.b.get(q..q + 6)?;
        if b[0] != b'\\' || b[1] != b'u' {
            return None;
        }
        let mut cp = 0;
        for &c in &b[2..] {
            cp = cp * 16 + hex_digit(c)?;
        }
        (0xdc00..=0xdfff).contains(&cp).then_some(cp)
    }

    /// Reads the string whose opening quotation mark is at `p` and returns its decoded
    /// content, leaving `p` after the closing quotation mark.
    fn string(&mut self, path: At) -> Result<String, Fault> {
        self.p += 1;
        let mut out = String::new();
        loop {
            // Copy the run of ordinary characters as it stands. It ends at an ASCII byte or
            // at the end, so it lies on character boundaries.
            let run = self.p;
            while self.p < self.n() {
                let c = self.b[self.p];
                if c == b'"' || c == b'\\' || c < 0x20 {
                    break;
                }
                self.p += 1;
            }
            out.push_str(&self.text[run..self.p]);
            let Some(c) = self.peek() else {
                return Err(self.json_fault(
                    path,
                    self.end_span(),
                    "the text ends inside a string",
                ));
            };
            match c {
                b'"' => {
                    self.p += 1;
                    return Ok(out);
                }
                b'\\' => self.escape(path, &mut out)?,
                _ => {
                    return Err(self.json_fault(
                        path,
                        Span::new(self.p, self.p + 1),
                        "a control character must be escaped inside a string",
                    ))
                }
            }
        }
    }

    /// Reads the escape whose backslash is at `p` into `out`.
    fn escape(&mut self, path: At, out: &mut String) -> Result<(), Fault> {
        let q = self.p;
        let Some(&e) = self.b.get(q + 1) else {
            return Err(self.json_fault(path, self.end_span(), "the text ends inside an escape"));
        };
        let simple = match e {
            b'"' => Some('"'),
            b'\\' => Some('\\'),
            b'/' => Some('/'),
            b'b' => Some('\u{8}'),
            b'f' => Some('\u{c}'),
            b'n' => Some('\n'),
            b'r' => Some('\r'),
            b't' => Some('\t'),
            _ => None,
        };
        if let Some(ch) = simple {
            out.push(ch);
            self.p += 2;
            return Ok(());
        }
        if e != b'u' {
            let after = self.char_span(q + 1);
            return Err(self.json_fault(path, Span::new(q, after.end), "not a JSON escape"));
        }
        let cp = self.hex4(q + 2, path)?;
        let scalar = if (0xd800..=0xdbff).contains(&cp) {
            let Some(low) = self.low_surrogate_at(q + 6) else {
                return Err(Fault::new(
                    Code::InvalidUnicodeEscape,
                    self.path(path),
                    Span::new(q, q + 6),
                    "a high surrogate escape is not followed by a low surrogate escape",
                ));
            };
            self.p = q + 12;
            0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00)
        } else if (0xdc00..=0xdfff).contains(&cp) {
            return Err(Fault::new(
                Code::InvalidUnicodeEscape,
                self.path(path),
                Span::new(q, q + 6),
                "a low surrogate escape without a high surrogate before it",
            ));
        } else {
            self.p = q + 6;
            cp
        };
        out.push(char::from_u32(scalar).expect("a scalar value outside the surrogates"));
        Ok(())
    }

    /// Reads `word` exactly, or refuses at the first byte that differs.
    fn literal(&mut self, word: &[u8], kind: Kind) -> Result<usize, Fault> {
        let start = self.p;
        for (i, &w) in word.iter().enumerate() {
            let q = start + i;
            if q >= self.n() {
                return Err(self.json_fault(
                    At::Value,
                    self.end_span(),
                    "the text ends inside a literal",
                ));
            }
            if self.b[q] != w {
                return Err(self.json_fault(
                    At::Value,
                    self.char_span(q),
                    "not the literal true, false or null",
                ));
            }
        }
        self.p = start + word.len();
        Ok(self.push(Span::new(start, self.p), kind))
    }

    /// One or more digits at `p`, or the refusal for what stands there instead.
    fn digits(&mut self) -> Result<(), Fault> {
        match self.peek() {
            Some(c) if c.is_ascii_digit() => {}
            _ => {
                return Err(self.json_fault(
                    At::Value,
                    self.char_span(self.p),
                    "a number needs a digit here",
                ))
            }
        }
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.p += 1;
        }
        Ok(())
    }

    /// The longest match of RFC 8259's `number` at `p`.
    fn number(&mut self) -> Result<usize, Fault> {
        let start = self.p;
        if self.peek() == Some(b'-') {
            self.p += 1;
        }
        if self.peek() == Some(b'0') {
            self.p += 1;
        } else {
            self.digits()?;
        }
        if self.peek() == Some(b'.') {
            self.p += 1;
            self.digits()?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.p += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.p += 1;
            }
            self.digits()?;
        }
        Ok(self.push(Span::new(start, self.p), Kind::Num))
    }
}

fn frame_segment(frame: &Frame) -> Segment {
    match frame {
        Frame::Obj { current, .. } => Segment::Name(
            current
                .as_ref()
                .map(|(name, _)| name.clone())
                .expect("a value inside an object belongs to a named member"),
        ),
        Frame::Arr { items, .. } => Segment::Index(items.len()),
    }
}
