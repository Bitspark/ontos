//! Stage 4 of total §4.1: interpreting the JSON tree as a value, for the total form
//! (total §4.4) and the readable profile (readable §4.2–§4.4, §4.9), with the origins of
//! readable §10.2 when asked for.
//!
//! The walk keeps an explicit stack of frames and never recurses (total §9.2). A node's own
//! checks run first, then its limit checks, then its children in document order, each
//! subtree completing before the next begins (readable §4.1), so the first failing check
//! in that order is the refusal.

use std::collections::HashSet;

use ontos_codec::encode;
use ontos_core::Value;
use ontos_data::{encode_bool, encode_decimal_bytes, encode_int_bytes, encode_null, encode_text};

use crate::digits::{
    decode_base64, decode_lower_hex, is_int_text, is_lower_hex, magnitude_of_digits,
};
use crate::error::{Code, Fault, LimitKind, Segment, Span};
use crate::lex::{Kind, Member, Tree};
use crate::limits::Limits;

/// The path id of the root, which has no segments; also "no parent".
pub(crate) const ROOT: usize = usize::MAX;
/// The origin id used when origins are not recorded.
const NO_ORIGIN: usize = usize::MAX;

/// One segment of a path in the arena: a member of an object node, or an index.
#[derive(Clone, Copy)]
pub(crate) enum PSeg {
    Member { object: usize, index: usize },
    Index(usize),
}

#[derive(Clone, Copy)]
pub(crate) struct PathNode {
    pub parent: usize,
    pub seg: PSeg,
}

/// Where a value node came from: a JSON path (an arena id) and a span.
#[derive(Clone, Copy)]
pub(crate) struct At {
    pub path: usize,
    pub span: Span,
}

/// The origin of a value node. `kids: None` gives the whole subtree the same origin.
pub(crate) struct ONode {
    pub at: At,
    pub kids: Option<Vec<usize>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    Total,
    Readable,
}

/// The result of interpreting a tree: the value, its origin id, and the arenas the
/// origins refer to.
pub(crate) struct Interpreted {
    pub value: Value,
    pub origin: usize,
    pub origins: Vec<ONode>,
    pub paths: Vec<PathNode>,
}

/// Interprets `tree` under `mode` and `limits`, recording origins when `record` is set.
pub(crate) fn interpret(
    tree: &Tree<'_>,
    mode: Mode,
    limits: &Limits,
    record: bool,
) -> Result<Interpreted, Fault> {
    let mut interp = Interp {
        tree,
        limits: *limits,
        paths: Vec::new(),
        origins: record.then(Vec::new),
        stack: Vec::new(),
    };
    let (value, origin) = interp.run(mode)?;
    Ok(Interpreted {
        value,
        origin,
        origins: interp.origins.unwrap_or_default(),
        paths: interp.paths,
    })
}

/// The members of a key-sorted container while it fills.
struct Entry {
    key_enc: Vec<u8>,
    key: Value,
    value: Value,
    origin: usize,
}

enum Frame<'t> {
    /// Children in order behind an optional label already in `items`: a readable array
    /// (a list), a compound's arguments, a total-form tuple's elements. Child `i` has path
    /// `base + [i]`.
    Seq {
        at: At,
        depth: u64,
        mode: Mode,
        children: &'t [usize],
        base: usize,
        next: usize,
        items: Vec<Value>,
        kids: Vec<usize>,
    },
    /// A plain readable object: member values at `depth`, entries sorted when complete.
    Object {
        at: At,
        depth: u64,
        object: usize,
        members: &'t [Member],
        next: usize,
        current: usize,
        entries: Vec<Entry>,
    },
    /// A `map` tag: for each entry, its key, the duplicate check, then its value.
    MapTag {
        at: At,
        depth: u64,
        entry_nodes: &'t [usize],
        base: usize,
        next: usize,
        entry_path: usize,
        key_path: usize,
        key: Option<(Value, Vec<u8>, usize)>,
        seen: HashSet<Vec<u8>>,
        entries: Vec<Entry>,
    },
    /// A `set` tag: each element, then the duplicate check.
    Set {
        at: At,
        depth: u64,
        children: &'t [usize],
        base: usize,
        next: usize,
        current: usize,
        seen: HashSet<Vec<u8>>,
        elems: Vec<(Vec<u8>, Value, usize)>,
    },
}

#[derive(Clone, Copy)]
enum Tag {
    Bytes,
    Int,
    Decimal,
    Map,
    Set,
    Compound,
    Raw,
}

struct Interp<'t> {
    tree: &'t Tree<'t>,
    limits: Limits,
    paths: Vec<PathNode>,
    origins: Option<Vec<ONode>>,
    stack: Vec<Frame<'t>>,
}

/// Whether a bare integer's digits lie in the window ±(2⁵³ − 1) (readable §4.5).
fn in_window(digits: &str) -> bool {
    const MAX_SAFE: &str = "9007199254740991";
    digits.len() < MAX_SAFE.len() || (digits.len() == MAX_SAFE.len() && digits <= MAX_SAFE)
}

/// The sign and the digits of canonical integer text or of a number lexeme.
fn split_sign(text: &str) -> (bool, &str) {
    match text.strip_prefix('-') {
        Some(digits) => (true, digits),
        None => (false, text),
    }
}

/// `int(n)` from its sign and decimal digits; `-0` is zero.
fn int_value(negative: bool, magnitude: &[u8]) -> Value {
    encode_int_bytes(negative && !magnitude.is_empty(), magnitude)
        .expect("a minimal magnitude is a canonical int")
}

fn label(name: &[u8]) -> Value {
    Value::atom(name.to_vec())
}

impl<'t> Interp<'t> {
    fn recording(&self) -> bool {
        self.origins.is_some()
    }

    fn onode(&mut self, at: At, kids: Option<Vec<usize>>) -> usize {
        match &mut self.origins {
            Some(origins) => {
                origins.push(ONode { at, kids });
                origins.len() - 1
            }
            None => NO_ORIGIN,
        }
    }

    fn child(&mut self, parent: usize, seg: PSeg) -> usize {
        self.paths.push(PathNode { parent, seg });
        self.paths.len() - 1
    }

    fn path_of(&self, id: usize) -> Vec<Segment> {
        materialize(self.tree, &self.paths, id)
    }

    fn refuse(&self, code: Code, path: usize, span: Span, message: &str) -> Fault {
        Fault::new(code, self.path_of(path), span, message)
    }

    fn limit(&self, kind: LimitKind, at: At) -> Fault {
        Fault::limit(kind, self.path_of(at.path), Some(at.span))
    }

    /// The first three checks of a node's contribution (readable §4.9): `decode_depth`,
    /// `tuple_arity`, `integer_digits`.
    fn check_dad(
        &self,
        at: At,
        depth: u64,
        arity: Option<usize>,
        digits: Option<usize>,
    ) -> Result<(), Fault> {
        let l = &self.limits;
        let kind = if depth > l.max_value_depth {
            LimitKind::DecodeDepth
        } else if arity.is_some_and(|a| a as u64 > l.max_tuple_arity) {
            LimitKind::TupleArity
        } else if digits.is_some_and(|g| g as u64 > l.max_integer_digits) {
            LimitKind::IntegerDigits
        } else {
            return Ok(());
        };
        Err(self.limit(kind, at))
    }

    /// The last check of a node's contribution: `atom_bytes`, over every atom it adds.
    fn check_atoms(&self, at: At, lens: impl IntoIterator<Item = usize>) -> Result<(), Fault> {
        let max = self.limits.max_atom_bytes;
        if lens.into_iter().any(|len| len as u64 > max) {
            return Err(self.limit(LimitKind::AtomBytes, at));
        }
        Ok(())
    }

    fn check(
        &self,
        at: At,
        depth: u64,
        arity: Option<usize>,
        atoms: impl IntoIterator<Item = usize>,
    ) -> Result<(), Fault> {
        self.check_dad(at, depth, arity, None)?;
        self.check_atoms(at, atoms)
    }

    fn run(&mut self, mode: Mode) -> Result<(Value, usize), Fault> {
        let mut done = self.visit(self.tree.root, 0, ROOT, mode)?;
        loop {
            if let Some(out) = done.take() {
                if self.stack.is_empty() {
                    return Ok(out);
                }
                self.accept(out)?;
            }
            done = self.advance()?;
        }
    }

    /// Starts the top frame's next child, or completes the frame when it has none left.
    fn advance(&mut self) -> Result<Option<(Value, usize)>, Fault> {
        enum Next {
            Child {
                node: usize,
                depth: u64,
                mode: Mode,
                base: usize,
                seg: PSeg,
            },
            MapKey {
                node: usize,
                depth: u64,
                base: usize,
                j: usize,
            },
            Done,
        }
        let tree = self.tree;
        let next = match self.stack.last().expect("a frame is open") {
            Frame::Seq {
                depth,
                mode,
                children,
                base,
                next,
                ..
            } => match children.get(*next) {
                Some(&node) => Next::Child {
                    node,
                    depth: *depth,
                    mode: *mode,
                    base: *base,
                    seg: PSeg::Index(*next),
                },
                None => Next::Done,
            },
            Frame::Object {
                at,
                depth,
                object,
                members,
                next,
                ..
            } => match members.get(*next) {
                Some(member) => Next::Child {
                    node: member.value,
                    depth: *depth,
                    mode: Mode::Readable,
                    base: at.path,
                    seg: PSeg::Member {
                        object: *object,
                        index: *next,
                    },
                },
                None => Next::Done,
            },
            Frame::MapTag {
                depth,
                entry_nodes,
                base,
                next,
                entry_path,
                key,
                ..
            } => match entry_nodes.get(*next) {
                None => Next::Done,
                Some(&entry) => {
                    let Kind::Arr(pair) = &tree.nodes[entry].kind else {
                        unreachable!("map entries were checked to be pairs");
                    };
                    if key.is_none() {
                        Next::MapKey {
                            node: pair[0],
                            depth: *depth,
                            base: *base,
                            j: *next,
                        }
                    } else {
                        Next::Child {
                            node: pair[1],
                            depth: *depth,
                            mode: Mode::Readable,
                            base: *entry_path,
                            seg: PSeg::Index(1),
                        }
                    }
                }
            },
            Frame::Set {
                depth,
                children,
                base,
                next,
                ..
            } => match children.get(*next) {
                Some(&node) => Next::Child {
                    node,
                    depth: *depth,
                    mode: Mode::Readable,
                    base: *base,
                    seg: PSeg::Index(*next),
                },
                None => Next::Done,
            },
        };
        match next {
            Next::Done => Ok(Some(self.finish())),
            Next::MapKey {
                node,
                depth,
                base,
                j,
            } => {
                let entry = self.child(base, PSeg::Index(j));
                let key = self.child(entry, PSeg::Index(0));
                if let Some(Frame::MapTag {
                    entry_path,
                    key_path,
                    ..
                }) = self.stack.last_mut()
                {
                    *entry_path = entry;
                    *key_path = key;
                }
                self.visit(node, depth, key, Mode::Readable)
            }
            Next::Child {
                node,
                depth,
                mode,
                base,
                seg,
            } => {
                let path = self.child(base, seg);
                if let Some(Frame::Object { current, .. } | Frame::Set { current, .. }) =
                    self.stack.last_mut()
                {
                    *current = path;
                }
                self.visit(node, depth, path, mode)
            }
        }
    }

    /// Hands a completed child value to the top frame.
    fn accept(&mut self, (value, origin): (Value, usize)) -> Result<(), Fault> {
        let recording = self.recording();
        let tree = self.tree;
        let top = self.stack.len() - 1;
        match &mut self.stack[top] {
            Frame::Seq {
                items, kids, next, ..
            } => {
                items.push(value);
                if recording {
                    kids.push(origin);
                }
                *next += 1;
            }
            Frame::Object {
                members,
                next,
                current,
                ..
            } => {
                let member = &members[*next];
                let (path, name_span) = (*current, member.name_span);
                let value_end = tree.nodes[member.value].span.end;
                let key = encode_text(&member.name);
                let key_enc = encode(&key);
                *next += 1;
                let origin = if recording {
                    let key_origin = self.onode(
                        At {
                            path,
                            span: name_span,
                        },
                        None,
                    );
                    let member_span = Span::new(name_span.start, value_end);
                    self.onode(
                        At {
                            path,
                            span: member_span,
                        },
                        Some(vec![key_origin, origin]),
                    )
                } else {
                    NO_ORIGIN
                };
                if let Frame::Object { entries, .. } = &mut self.stack[top] {
                    entries.push(Entry {
                        key_enc,
                        key,
                        value,
                        origin,
                    });
                }
            }
            Frame::MapTag {
                entry_nodes,
                next,
                entry_path,
                key_path,
                key,
                seen,
                ..
            } => match key.take() {
                None => {
                    let key_enc = encode(&value);
                    if seen.contains(&key_enc) {
                        let key_node = match &tree.nodes[entry_nodes[*next]].kind {
                            Kind::Arr(pair) => pair[0],
                            _ => unreachable!("map entries were checked to be pairs"),
                        };
                        let path = *key_path;
                        return Err(self.refuse(
                            Code::DuplicateMapKey,
                            path,
                            tree.nodes[key_node].span,
                            "the map repeats this key (compared as ground values)",
                        ));
                    }
                    seen.insert(key_enc.clone());
                    *key = Some((value, key_enc, origin));
                }
                Some((key, key_enc, key_origin)) => {
                    let entry_span = tree.nodes[entry_nodes[*next]].span;
                    let path = *entry_path;
                    *next += 1;
                    let origin = if recording {
                        self.onode(
                            At {
                                path,
                                span: entry_span,
                            },
                            Some(vec![key_origin, origin]),
                        )
                    } else {
                        NO_ORIGIN
                    };
                    if let Frame::MapTag { entries, .. } = &mut self.stack[top] {
                        entries.push(Entry {
                            key_enc,
                            key,
                            value,
                            origin,
                        });
                    }
                }
            },
            Frame::Set {
                children,
                next,
                current,
                seen,
                elems,
                ..
            } => {
                let enc = encode(&value);
                if seen.contains(&enc) {
                    let (path, span) = (*current, tree.nodes[children[*next]].span);
                    return Err(self.refuse(
                        Code::DuplicateSetElement,
                        path,
                        span,
                        "the set repeats this element (compared as ground values)",
                    ));
                }
                seen.insert(enc.clone());
                elems.push((enc, value, origin));
                *next += 1;
            }
        }
        Ok(())
    }

    /// Completes the top frame into its value.
    fn finish(&mut self) -> (Value, usize) {
        let frame = self.stack.pop().expect("a frame is open");
        match frame {
            Frame::Seq {
                at, items, kids, ..
            } => {
                let origin = self.onode(at, Some(kids));
                (Value::tuple(items), origin)
            }
            Frame::Object { at, entries, .. } | Frame::MapTag { at, entries, .. } => {
                self.map_of(at, entries)
            }
            Frame::Set { at, mut elems, .. } => {
                elems.sort_by(|a, b| a.0.cmp(&b.0));
                let mut items = Vec::with_capacity(elems.len() + 1);
                items.push(label(b"set"));
                let mut kids = Vec::new();
                if self.recording() {
                    kids.reserve(elems.len() + 1);
                    kids.push(self.onode(at, None));
                }
                for (_, value, origin) in elems {
                    items.push(value);
                    kids.push(origin);
                }
                let origin = self.onode(at, Some(kids));
                (Value::tuple(items), origin)
            }
        }
    }

    /// A map from its entries in any order: sorted by the codec encoding of the keys.
    fn map_of(&mut self, at: At, mut entries: Vec<Entry>) -> (Value, usize) {
        entries.sort_by(|a, b| a.key_enc.cmp(&b.key_enc));
        let mut items = Vec::with_capacity(entries.len() + 1);
        items.push(label(b"map"));
        let mut kids = Vec::new();
        if self.recording() {
            kids.reserve(entries.len() + 1);
            kids.push(self.onode(at, None));
        }
        for entry in entries {
            items.push(Value::tuple([entry.key, entry.value]));
            kids.push(entry.origin);
        }
        let origin = self.onode(at, Some(kids));
        (Value::tuple(items), origin)
    }

    /// Interprets node `x` at value depth `d` and path `path`: a value at once, or `None`
    /// after pushing a frame for its children.
    fn visit(
        &mut self,
        x: usize,
        d: u64,
        path: usize,
        mode: Mode,
    ) -> Result<Option<(Value, usize)>, Fault> {
        match mode {
            Mode::Total => self.visit_total(x, d, path),
            Mode::Readable => self.visit_readable(x, d, path),
        }
    }

    /// Total §4.4, in its check order.
    fn visit_total(
        &mut self,
        x: usize,
        d: u64,
        path: usize,
    ) -> Result<Option<(Value, usize)>, Fault> {
        let tree = self.tree;
        let node = &tree.nodes[x];
        let at = At {
            path,
            span: node.span,
        };
        let Kind::Obj(members) = &node.kind else {
            return Err(self.refuse(
                Code::InvalidTotalForm,
                path,
                node.span,
                "a total-form value is an object",
            ));
        };
        if members.len() != 1 {
            return Err(self.refuse(
                Code::InvalidTotalForm,
                path,
                node.span,
                "a total-form object has exactly one member",
            ));
        }
        let member = &members[0];
        let y = &tree.nodes[member.value];
        let member_seg = PSeg::Member {
            object: x,
            index: 0,
        };
        match member.name.as_str() {
            "atom" => {
                let Kind::Str(hex) = &y.kind else {
                    let yp = self.child(path, member_seg);
                    return Err(self.refuse(
                        Code::InvalidTotalForm,
                        yp,
                        y.span,
                        "an atom's member value is a string",
                    ));
                };
                if !is_lower_hex(hex) {
                    let yp = self.child(path, member_seg);
                    return Err(self.refuse(
                        Code::InvalidHex,
                        yp,
                        y.span,
                        "an atom's bytes are even-length lowercase hexadecimal",
                    ));
                }
                self.check(at, d, None, [hex.len() / 2])?;
                let value = Value::atom(decode_lower_hex(hex));
                let origin = self.onode(at, None);
                Ok(Some((value, origin)))
            }
            "tuple" => {
                let Kind::Arr(elems) = &y.kind else {
                    let yp = self.child(path, member_seg);
                    return Err(self.refuse(
                        Code::InvalidTotalForm,
                        yp,
                        y.span,
                        "a tuple's member value is an array",
                    ));
                };
                self.check(at, d, Some(elems.len()), [])?;
                if elems.is_empty() {
                    let origin = self.onode(at, Some(Vec::new()));
                    return Ok(Some((Value::tuple([]), origin)));
                }
                let base = self.child(path, member_seg);
                self.stack.push(Frame::Seq {
                    at,
                    depth: d + 1,
                    mode: Mode::Total,
                    children: elems,
                    base,
                    next: 0,
                    items: Vec::with_capacity(elems.len()),
                    kids: Vec::new(),
                });
                Ok(None)
            }
            _ => Err(self.refuse(
                Code::InvalidTotalForm,
                path,
                node.span,
                "a total-form object's member is named atom or tuple",
            )),
        }
    }

    /// Readable §4.2: plain JSON, and the envelope through [`Interp::envelope`].
    fn visit_readable(
        &mut self,
        x: usize,
        d: u64,
        path: usize,
    ) -> Result<Option<(Value, usize)>, Fault> {
        let tree = self.tree;
        let node = &tree.nodes[x];
        let at = At {
            path,
            span: node.span,
        };
        let value = match &node.kind {
            Kind::Null => {
                self.check(at, d + 1, Some(1), [4])?;
                encode_null()
            }
            Kind::True | Kind::False => {
                self.check(at, d + 1, Some(2), [4, 1])?;
                encode_bool(matches!(node.kind, Kind::True))
            }
            Kind::Str(s) => {
                self.check(at, d + 1, Some(2), [9, s.len()])?;
                encode_text(s)
            }
            Kind::Num => {
                let lexeme = tree.lexeme(x);
                if lexeme.bytes().any(|c| matches!(c, b'.' | b'e' | b'E')) {
                    return Err(self.refuse(
                        Code::InvalidNumber,
                        path,
                        node.span,
                        "a number has neither a fraction nor an exponent here",
                    ));
                }
                let (negative, digits) = split_sign(lexeme);
                if !in_window(digits) {
                    return Err(self.refuse(
                        Code::UnsafeIntegerLiteral,
                        path,
                        node.span,
                        "a bare integer lies within ±(2^53 − 1); use the int tag",
                    ));
                }
                self.check_dad(at, d + 1, Some(2), Some(digits.len()))?;
                let magnitude = magnitude_of_digits(digits.as_bytes());
                self.check_atoms(at, [3, 1 + magnitude.len()])?;
                int_value(negative, &magnitude)
            }
            Kind::Arr(elems) => {
                self.check(at, d + 1, Some(elems.len() + 1), [4])?;
                let list = label(b"list");
                if elems.is_empty() {
                    Value::tuple([list])
                } else {
                    let mut items = Vec::with_capacity(elems.len() + 1);
                    items.push(list);
                    let mut kids = Vec::new();
                    if self.recording() {
                        kids.reserve(elems.len() + 1);
                        kids.push(self.onode(at, None));
                    }
                    self.stack.push(Frame::Seq {
                        at,
                        depth: d + 1,
                        mode: Mode::Readable,
                        children: elems,
                        base: path,
                        next: 0,
                        items,
                        kids,
                    });
                    return Ok(None);
                }
            }
            Kind::Obj(members) => {
                if members.iter().any(|m| m.name == "$ontos") {
                    return self.envelope(x, d, path, members);
                }
                let n = members.len();
                let (depth, arity) = if n > 0 {
                    (d + 3, (n + 1).max(2))
                } else {
                    (d + 1, 1)
                };
                let shared: &[usize] = if n > 0 { &[3, 9] } else { &[3] };
                self.check(
                    at,
                    depth,
                    Some(arity),
                    shared
                        .iter()
                        .copied()
                        .chain(members.iter().map(|m| m.name.len())),
                )?;
                if n == 0 {
                    Value::tuple([label(b"map")])
                } else {
                    self.stack.push(Frame::Object {
                        at,
                        depth: d + 2,
                        object: x,
                        members,
                        next: 0,
                        current: ROOT,
                        entries: Vec::with_capacity(n),
                    });
                    return Ok(None);
                }
            }
        };
        let origin = self.onode(at, None);
        Ok(Some((value, origin)))
    }

    /// Readable §4.3 and §4.4: an object with a member named `$ontos`.
    fn envelope(
        &mut self,
        x: usize,
        d: u64,
        path: usize,
        members: &'t [Member],
    ) -> Result<Option<(Value, usize)>, Fault> {
        let tree = self.tree;
        let node = &tree.nodes[x];
        let at = At {
            path,
            span: node.span,
        };
        if members.len() != 1 {
            return Err(self.refuse(
                Code::InvalidEnvelope,
                path,
                node.span,
                "an object with a member named $ontos has no other member",
            ));
        }
        let y = &tree.nodes[members[0].value];
        let yp = self.child(
            path,
            PSeg::Member {
                object: x,
                index: 0,
            },
        );
        let Kind::Arr(ys) = &y.kind else {
            return Err(self.refuse(
                Code::InvalidEnvelope,
                yp,
                y.span,
                "the $ontos member's value is an array",
            ));
        };
        if ys.is_empty() {
            return Err(self.refuse(
                Code::InvalidEnvelope,
                yp,
                y.span,
                "the $ontos array is not empty",
            ));
        }
        let y0 = &tree.nodes[ys[0]];
        let Kind::Str(name) = &y0.kind else {
            let p0 = self.child(yp, PSeg::Index(0));
            return Err(self.refuse(
                Code::InvalidEnvelope,
                p0,
                y0.span,
                "the $ontos array starts with the tag name",
            ));
        };
        let (tag, arity) = match name.as_str() {
            "bytes" => (Tag::Bytes, 2),
            "int" => (Tag::Int, 2),
            "decimal" => (Tag::Decimal, 3),
            "map" => (Tag::Map, 2),
            "set" => (Tag::Set, 2),
            "compound" => (Tag::Compound, 3),
            "raw" => (Tag::Raw, 2),
            _ => {
                let p0 = self.child(yp, PSeg::Index(0));
                return Err(self.refuse(
                    Code::UnknownTag,
                    p0,
                    y0.span,
                    "the tag is none of bytes, int, decimal, map, set, compound and raw",
                ));
            }
        };
        if ys.len() != arity {
            return Err(self.refuse(Code::InvalidTag, yp, y.span, "the tag has the wrong arity"));
        }
        let y1 = &tree.nodes[ys[1]];
        let value = match tag {
            Tag::Bytes => {
                let s = self.tag_string(yp, 1, ys[1])?;
                let Some(bytes) = decode_base64(s) else {
                    let p1 = self.child(yp, PSeg::Index(1));
                    return Err(self.refuse(
                        Code::InvalidBase64,
                        p1,
                        y1.span,
                        "not canonical padded standard base64",
                    ));
                };
                self.check(at, d, None, [bytes.len()])?;
                Value::atom(bytes)
            }
            Tag::Int => {
                let s = self.tag_integer(yp, 1, ys[1])?;
                let (negative, digits) = split_sign(s);
                self.check_dad(at, d + 1, Some(2), Some(digits.len()))?;
                let magnitude = magnitude_of_digits(digits.as_bytes());
                self.check_atoms(at, [3, 1 + magnitude.len()])?;
                int_value(negative, &magnitude)
            }
            Tag::Decimal => {
                let m = self.tag_integer(yp, 1, ys[1])?;
                let e = self.tag_integer(yp, 2, ys[2])?;
                if m == "0" && e != "0" {
                    let p2 = self.child(yp, PSeg::Index(2));
                    return Err(self.refuse(
                        Code::NoncanonicalDecimal,
                        p2,
                        tree.nodes[ys[2]].span,
                        "the decimal zero is exactly \"0\", \"0\"",
                    ));
                }
                if m != "0" && m.ends_with('0') {
                    let p1 = self.child(yp, PSeg::Index(1));
                    return Err(self.refuse(
                        Code::NoncanonicalDecimal,
                        p1,
                        y1.span,
                        "a non-zero mantissa does not end in the digit 0",
                    ));
                }
                let (m_negative, m_digits) = split_sign(m);
                let (e_negative, e_digits) = split_sign(e);
                self.check_dad(at, d + 2, Some(3), Some(m_digits.len().max(e_digits.len())))?;
                let m_mag = magnitude_of_digits(m_digits.as_bytes());
                let e_mag = magnitude_of_digits(e_digits.as_bytes());
                self.check_atoms(at, [7, 3, 1 + m_mag.len(), 3, 1 + e_mag.len()])?;
                encode_decimal_bytes((m_negative, &m_mag), (e_negative, &e_mag))
                    .expect("canonical integer text and a canonical pair make a canonical decimal")
            }
            Tag::Map => {
                let Kind::Arr(entries) = &y1.kind else {
                    let p1 = self.child(yp, PSeg::Index(1));
                    return Err(self.refuse(
                        Code::InvalidTag,
                        p1,
                        y1.span,
                        "the map tag's payload is an array",
                    ));
                };
                let p1 = self.child(yp, PSeg::Index(1));
                for (j, &entry) in entries.iter().enumerate() {
                    let entry_node = &tree.nodes[entry];
                    if !matches!(&entry_node.kind, Kind::Arr(pair) if pair.len() == 2) {
                        let pj = self.child(p1, PSeg::Index(j));
                        return Err(self.refuse(
                            Code::InvalidTag,
                            pj,
                            entry_node.span,
                            "a map entry is an array of a key and a value",
                        ));
                    }
                }
                let n = entries.len();
                let arity = if n > 0 { (n + 1).max(2) } else { 1 };
                self.check(at, d + 1, Some(arity), [3])?;
                if n == 0 {
                    Value::tuple([label(b"map")])
                } else {
                    self.stack.push(Frame::MapTag {
                        at,
                        depth: d + 2,
                        entry_nodes: entries,
                        base: p1,
                        next: 0,
                        entry_path: ROOT,
                        key_path: ROOT,
                        key: None,
                        seen: HashSet::new(),
                        entries: Vec::with_capacity(n),
                    });
                    return Ok(None);
                }
            }
            Tag::Set => {
                let p1 = self.child(yp, PSeg::Index(1));
                let Kind::Arr(elems) = &y1.kind else {
                    return Err(self.refuse(
                        Code::InvalidTag,
                        p1,
                        y1.span,
                        "the set tag's payload is an array",
                    ));
                };
                self.check(at, d + 1, Some(elems.len() + 1), [3])?;
                if elems.is_empty() {
                    Value::tuple([label(b"set")])
                } else {
                    self.stack.push(Frame::Set {
                        at,
                        depth: d + 1,
                        children: elems,
                        base: p1,
                        next: 0,
                        current: ROOT,
                        seen: HashSet::new(),
                        elems: Vec::with_capacity(elems.len()),
                    });
                    return Ok(None);
                }
            }
            Tag::Compound => {
                let label_bytes = self.compound_label(yp, ys[1])?;
                let y2 = &tree.nodes[ys[2]];
                let p2 = self.child(yp, PSeg::Index(2));
                let Kind::Arr(args) = &y2.kind else {
                    return Err(self.refuse(
                        Code::InvalidTag,
                        p2,
                        y2.span,
                        "a compound's arguments are an array",
                    ));
                };
                self.check(at, d + 1, Some(args.len() + 1), [label_bytes.len()])?;
                let head = Value::atom(label_bytes);
                if args.is_empty() {
                    Value::tuple([head])
                } else {
                    let mut items = Vec::with_capacity(args.len() + 1);
                    items.push(head);
                    let mut kids = Vec::new();
                    if self.recording() {
                        kids.reserve(args.len() + 1);
                        kids.push(self.onode(at, None));
                    }
                    self.stack.push(Frame::Seq {
                        at,
                        depth: d + 1,
                        mode: Mode::Readable,
                        children: args,
                        base: p2,
                        next: 0,
                        items,
                        kids,
                    });
                    return Ok(None);
                }
            }
            Tag::Raw => {
                let p1 = self.child(yp, PSeg::Index(1));
                return self.visit_total(ys[1], d, p1);
            }
        };
        let origin = self.onode(at, None);
        Ok(Some((value, origin)))
    }

    /// `y[i]` is a string, else `invalid_tag` at it.
    fn tag_string(&mut self, yp: usize, i: usize, node: usize) -> Result<&'t str, Fault> {
        let tree = self.tree;
        match &tree.nodes[node].kind {
            Kind::Str(s) => Ok(s),
            _ => {
                let pi = self.child(yp, PSeg::Index(i));
                Err(self.refuse(
                    Code::InvalidTag,
                    pi,
                    tree.nodes[node].span,
                    "this tag element is a string",
                ))
            }
        }
    }

    /// `y[i]` is a string of canonical integer text, else `invalid_tag` or
    /// `invalid_integer` at it.
    fn tag_integer(&mut self, yp: usize, i: usize, node: usize) -> Result<&'t str, Fault> {
        let s = self.tag_string(yp, i, node)?;
        if !is_int_text(s) {
            let pi = self.child(yp, PSeg::Index(i));
            return Err(self.refuse(
                Code::InvalidInteger,
                pi,
                self.tree.nodes[node].span,
                "integer text is 0, or an optional - and digits without a leading zero",
            ));
        }
        Ok(s)
    }

    /// A compound's label (readable §4.4 "Labels"): a string, or `["bytes", base64]`.
    fn compound_label(&mut self, yp: usize, node: usize) -> Result<Vec<u8>, Fault> {
        let tree = self.tree;
        let y1 = &tree.nodes[node];
        let p1 = self.child(yp, PSeg::Index(1));
        match &y1.kind {
            Kind::Str(s) => Ok(s.as_bytes().to_vec()),
            Kind::Arr(parts) => {
                if parts.len() != 2 {
                    return Err(self.refuse(
                        Code::InvalidTag,
                        p1,
                        y1.span,
                        "a label array is [\"bytes\", base64]",
                    ));
                }
                let l0 = &tree.nodes[parts[0]];
                if !matches!(&l0.kind, Kind::Str(s) if s == "bytes") {
                    let p = self.child(p1, PSeg::Index(0));
                    return Err(self.refuse(
                        Code::InvalidTag,
                        p,
                        l0.span,
                        "a label array starts with \"bytes\"",
                    ));
                }
                let l1 = &tree.nodes[parts[1]];
                let Kind::Str(b64) = &l1.kind else {
                    let p = self.child(p1, PSeg::Index(1));
                    return Err(self.refuse(
                        Code::InvalidTag,
                        p,
                        l1.span,
                        "a label array's bytes are a base64 string",
                    ));
                };
                decode_base64(b64).ok_or_else(|| {
                    let p = self.child(p1, PSeg::Index(1));
                    self.refuse(
                        Code::InvalidBase64,
                        p,
                        l1.span,
                        "not canonical padded standard base64",
                    )
                })
            }
            _ => Err(self.refuse(
                Code::InvalidTag,
                p1,
                y1.span,
                "a compound's label is a string or [\"bytes\", base64]",
            )),
        }
    }
}

/// The typed segments of path `id` in `paths`.
pub(crate) fn materialize(tree: &Tree<'_>, paths: &[PathNode], mut id: usize) -> Vec<Segment> {
    let mut segments = Vec::new();
    while id != ROOT {
        let node = paths[id];
        segments.push(segment(tree, node.seg));
        id = node.parent;
    }
    segments.reverse();
    segments
}

pub(crate) fn segment(tree: &Tree<'_>, seg: PSeg) -> Segment {
    match seg {
        PSeg::Member { object, index } => match &tree.nodes[object].kind {
            Kind::Obj(members) => Segment::Name(members[index].name.clone()),
            _ => unreachable!("a member segment names an object"),
        },
        PSeg::Index(i) => Segment::Index(i),
    }
}
