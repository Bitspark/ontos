//! The writers of total §5 and readable §5, with the limit checks of total §9.3: the
//! writer is the reader's mirror.
//!
//! The output is a tree of JSON nodes, the tree the reader would build from it. Before the
//! first byte of each node the writer checks that node's contribution exactly as the
//! reader checks it (`decode_depth`, `tuple_arity`, `integer_digits`, `atom_bytes`), then
//! `max_json_depth` at an opening bracket, then the byte count. The writer keeps an
//! explicit work stack and never recurses (total §9.2).

use ontos_codec::encode;
use ontos_core::Value;
use ontos_data::{read_bool, read_decimal_bytes, read_int_bytes, recognize_null};

use crate::digits::{digits_within, push_base64, push_hex};
use crate::error::{Fault, LimitKind, Segment};
use crate::limits::Limits;

/// Writes `value` in the total form (`total == true`) or the readable profile.
pub(crate) fn render(
    value: &Value,
    limits: &Limits,
    max_json_depth: u64,
    total: bool,
) -> Result<Vec<u8>, Fault> {
    let mut writer = Writer {
        limits: *limits,
        max_json_depth,
        out: Vec::new(),
        depth: 0,
        paths: Vec::new(),
        work: Vec::new(),
    };
    writer.work.push(if total {
        Work::Total(value, 0, ROOT)
    } else {
        Work::Readable(value, 0, ROOT)
    });
    writer.run()?;
    Ok(writer.out)
}

const ROOT: usize = usize::MAX;

/// A segment of an output path. Paths of writer refusals are informative (total §9.3).
#[derive(Clone, Copy)]
enum WSeg<'v> {
    Name(&'v str),
    Fixed(&'static str),
    Index(usize),
}

enum Work<'v> {
    /// Write a value in the readable profile, at value depth and output path.
    Readable(&'v Value, u64, usize),
    /// Write a value in the total form.
    Total(&'v Value, u64, usize),
    /// Emit fixed bytes inside the node at the path.
    Emit(&'static [u8], usize),
    /// Open an array or object that is part of the node at the path.
    Open(u8, usize),
    /// Close an array or object.
    Close(u8, usize),
    /// A member name and its name separator.
    Name(&'v str, usize),
}

struct Writer<'v> {
    limits: Limits,
    max_json_depth: u64,
    out: Vec<u8>,
    depth: u64,
    paths: Vec<(usize, WSeg<'v>)>,
    work: Vec<Work<'v>>,
}

/// A value recognized as one of the eight `ontos/data` kinds (readable §2.3, step 1), by
/// its label and its canonical form (ontos-data §5).
enum Kind<'v> {
    Null,
    Bool(bool),
    Text(&'v str),
    Int(bool, &'v [u8]),
    List(&'v [Value]),
    /// The entries, each a `Tuple(key, value)`, already in strictly ascending key order.
    Map(&'v [Value]),
    Set(&'v [Value]),
    Decimal((bool, &'v [u8]), (bool, &'v [u8])),
}

/// Readable §2.3 step 1: the eight kinds exactly as ontos-data §5 defines their canonical
/// forms. A container is recognized by its own rules only; its children may be anything.
fn recognize(value: &Value) -> Option<Kind<'_>> {
    let tuple = value.as_tuple()?;
    let items = tuple.items();
    let label = items.first()?.as_atom()?.bytes();
    match label {
        b"null" => recognize_null(value).ok().map(|()| Kind::Null),
        b"bool" => read_bool(value).ok().map(Kind::Bool),
        b"utf8-text" => text(value).map(Kind::Text),
        b"int" => read_int_bytes(value)
            .ok()
            .map(|(negative, magnitude)| Kind::Int(negative, magnitude)),
        b"list" => Some(Kind::List(&items[1..])),
        b"map" => {
            let entries = &items[1..];
            let pairs = entries
                .iter()
                .all(|e| e.as_tuple().is_some_and(|t| t.len() == 2));
            (pairs
                && ascending(
                    entries
                        .iter()
                        .map(|e| &e.as_tuple().expect("a pair").items()[0]),
                ))
            .then_some(Kind::Map(entries))
        }
        b"set" => {
            let elems = &items[1..];
            ascending(elems.iter()).then_some(Kind::Set(elems))
        }
        b"decimal" => read_decimal_bytes(value)
            .ok()
            .map(|(m, e)| Kind::Decimal(m, e)),
        _ => None,
    }
}

/// A canonical `utf8-text` (ontos-data §5.2): `Tuple(Atom("utf8-text"), Atom(s))` with `s`
/// well-formed UTF-8, borrowed rather than copied.
fn text(value: &Value) -> Option<&str> {
    match value.as_tuple()?.items() {
        [Value::Atom(label), Value::Atom(payload)] if label.bytes() == b"utf8-text" => {
            core::str::from_utf8(payload.bytes()).ok()
        }
        _ => None,
    }
}

/// Whether the codec encodings of `values` are strictly ascending (ontos-data §5.7, §5.8).
fn ascending<'v>(values: impl Iterator<Item = &'v Value>) -> bool {
    let mut previous: Option<Vec<u8>> = None;
    for value in values {
        let enc = encode(value);
        if previous.as_ref().is_some_and(|p| *p >= enc) {
            return false;
        }
        previous = Some(enc);
    }
    true
}

/// Whether an `int`'s magnitude lies in the window ±(2⁵³ − 1): at most `1f ff…ff`, seven
/// bytes.
fn in_window(magnitude: &[u8]) -> bool {
    magnitude.len() < 7 || (magnitude.len() == 7 && magnitude[0] <= 0x1f)
}

/// Appends `s` as a JSON string, escaped as readable §5 fixes.
pub(crate) fn push_json_string(out: &mut Vec<u8>, s: &str) {
    out.reserve(s.len() + 2);
    out.push(b'"');
    for &c in s.as_bytes() {
        match c {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x09 => out.extend_from_slice(b"\\t"),
            0x0a => out.extend_from_slice(b"\\n"),
            0x0c => out.extend_from_slice(b"\\f"),
            0x0d => out.extend_from_slice(b"\\r"),
            0x00..=0x1f => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                out.extend_from_slice(b"\\u00");
                out.push(HEX[usize::from(c >> 4)]);
                out.push(HEX[usize::from(c & 0x0f)]);
            }
            // Every other byte as it stands: ASCII never occurs inside a multi-byte
            // sequence, so this writes every other scalar value as itself.
            _ => out.push(c),
        }
    }
    out.push(b'"');
}

impl<'v> Writer<'v> {
    fn run(&mut self) -> Result<(), Fault> {
        while let Some(work) = self.work.pop() {
            match work {
                Work::Readable(value, d, path) => self.readable(value, d, path)?,
                Work::Total(value, d, path) => self.total(value, d, path)?,
                Work::Emit(bytes, path) => self.emit(bytes, path)?,
                Work::Open(bracket, path) => self.open(bracket, path)?,
                Work::Close(bracket, path) => self.close(bracket, path)?,
                Work::Name(name, path) => {
                    let mut bytes = Vec::new();
                    push_json_string(&mut bytes, name);
                    bytes.push(b':');
                    self.emit(&bytes, path)?;
                }
            }
        }
        Ok(())
    }

    fn child(&mut self, parent: usize, seg: WSeg<'v>) -> usize {
        self.paths.push((parent, seg));
        self.paths.len() - 1
    }

    fn path_of(&self, mut id: usize) -> Vec<Segment> {
        let mut segments = Vec::new();
        while id != ROOT {
            let (parent, seg) = self.paths[id];
            segments.push(match seg {
                WSeg::Name(name) => Segment::Name(name.to_owned()),
                WSeg::Fixed(name) => Segment::Name(name.to_owned()),
                WSeg::Index(i) => Segment::Index(i),
            });
            id = parent;
        }
        segments.reverse();
        segments
    }

    fn limit(&self, kind: LimitKind, path: usize) -> Fault {
        Fault::limit(kind, self.path_of(path), None)
    }

    /// The first byte beyond `max_text_bytes` refuses.
    fn emit(&mut self, bytes: &[u8], path: usize) -> Result<(), Fault> {
        if (self.out.len() + bytes.len()) as u64 > self.limits.max_text_bytes {
            return Err(self.limit(LimitKind::TextBytes, path));
        }
        self.out.extend_from_slice(bytes);
        Ok(())
    }

    /// An opening bracket: its depth, then its byte.
    fn open(&mut self, bracket: u8, path: usize) -> Result<(), Fault> {
        if self.depth + 1 > self.max_json_depth {
            return Err(self.limit(LimitKind::JsonDepth, path));
        }
        self.depth += 1;
        self.emit(&[bracket], path)
    }

    fn close(&mut self, bracket: u8, path: usize) -> Result<(), Fault> {
        self.depth -= 1;
        self.emit(&[bracket], path)
    }

    /// `decode_depth`, `tuple_arity` and `integer_digits` of a node's contribution.
    fn check_dad(
        &self,
        path: usize,
        depth: u64,
        arity: Option<usize>,
        digits_ok: bool,
    ) -> Result<(), Fault> {
        let l = &self.limits;
        let kind = if depth > l.max_value_depth {
            LimitKind::DecodeDepth
        } else if arity.is_some_and(|a| a as u64 > l.max_tuple_arity) {
            LimitKind::TupleArity
        } else if !digits_ok {
            LimitKind::IntegerDigits
        } else {
            return Ok(());
        };
        Err(self.limit(kind, path))
    }

    fn check_atoms(&self, path: usize, lens: impl IntoIterator<Item = usize>) -> Result<(), Fault> {
        let max = self.limits.max_atom_bytes;
        if lens.into_iter().any(|len| len as u64 > max) {
            return Err(self.limit(LimitKind::AtomBytes, path));
        }
        Ok(())
    }

    fn check(
        &self,
        path: usize,
        depth: u64,
        arity: Option<usize>,
        atoms: impl IntoIterator<Item = usize>,
    ) -> Result<(), Fault> {
        self.check_dad(path, depth, arity, true)?;
        self.check_atoms(path, atoms)
    }

    /// Pushes `children` as the elements of an array, at value depth `d` and the paths
    /// `base + [i]`, with separators. The work stack is last in, first out.
    fn push_elements(&mut self, children: &'v [Value], d: u64, base: usize, total: bool) {
        for (i, child) in children.iter().enumerate().rev() {
            let path = self.child(base, WSeg::Index(i));
            self.work.push(if total {
                Work::Total(child, d, path)
            } else {
                Work::Readable(child, d, path)
            });
            if i > 0 {
                self.work.push(Work::Emit(b",", base));
            }
        }
    }

    /// Total §5: `{"atom":"<hex>"}` or `{"tuple":[…]}`.
    fn total(&mut self, value: &'v Value, d: u64, path: usize) -> Result<(), Fault> {
        match value {
            Value::Atom(atom) => {
                self.check(path, d, None, [atom.len()])?;
                self.open(b'{', path)?;
                let mut bytes = Vec::with_capacity(atom.len() * 2 + 10);
                bytes.extend_from_slice(b"\"atom\":\"");
                push_hex(&mut bytes, atom.bytes());
                bytes.push(b'"');
                self.emit(&bytes, path)?;
                self.close(b'}', path)
            }
            Value::Tuple(tuple) => {
                self.check(path, d, Some(tuple.len()), [])?;
                self.open(b'{', path)?;
                self.emit(b"\"tuple\":", path)?;
                let items = self.child(path, WSeg::Fixed("tuple"));
                self.open(b'[', items)?;
                self.work.push(Work::Close(b'}', path));
                self.work.push(Work::Close(b']', items));
                self.push_elements(tuple.items(), d + 1, items, true);
                Ok(())
            }
        }
    }

    /// Opens `{"$ontos":[` and writes the tag name and its separator; returns the path of
    /// the tag array.
    fn envelope(&mut self, tag: &'static [u8], path: usize) -> Result<usize, Fault> {
        self.open(b'{', path)?;
        self.emit(b"\"$ontos\":", path)?;
        let array = self.child(path, WSeg::Fixed("$ontos"));
        self.open(b'[', array)?;
        self.emit(tag, array)?;
        Ok(array)
    }

    /// Readable §2.3 and §5.
    fn readable(&mut self, value: &'v Value, d: u64, path: usize) -> Result<(), Fault> {
        let tuple = match value {
            Value::Atom(atom) => {
                self.check(path, d, None, [atom.len()])?;
                let array = self.envelope(b"\"bytes\",", path)?;
                let mut bytes = Vec::with_capacity(atom.len().div_ceil(3) * 4 + 2);
                bytes.push(b'"');
                push_base64(&mut bytes, atom.bytes());
                bytes.push(b'"');
                self.emit(&bytes, array)?;
                self.close(b']', array)?;
                return self.close(b'}', path);
            }
            Value::Tuple(tuple) => tuple,
        };
        match recognize(value) {
            Some(Kind::Null) => {
                self.check(path, d + 1, Some(1), [4])?;
                self.emit(b"null", path)
            }
            Some(Kind::Bool(b)) => {
                self.check(path, d + 1, Some(2), [4, 1])?;
                self.emit(if b { b"true" } else { b"false" }, path)
            }
            Some(Kind::Text(s)) => {
                self.check(path, d + 1, Some(2), [9, s.len()])?;
                let mut bytes = Vec::new();
                push_json_string(&mut bytes, s);
                self.emit(&bytes, path)
            }
            Some(Kind::Int(negative, magnitude)) => {
                self.check_dad(path, d + 1, Some(2), true)?;
                let digits = digits_within(magnitude, self.limits.max_integer_digits);
                self.check_dad(path, d + 1, Some(2), digits.is_some())?;
                let digits = digits.expect("checked above");
                self.check_atoms(path, [3, 1 + magnitude.len()])?;
                let sign: &str = if negative { "-" } else { "" };
                if in_window(magnitude) {
                    return self.emit(format!("{sign}{digits}").as_bytes(), path);
                }
                let array = self.envelope(b"\"int\",", path)?;
                self.emit(format!("\"{sign}{digits}\"").as_bytes(), array)?;
                self.close(b']', array)?;
                self.close(b'}', path)
            }
            Some(Kind::Decimal((m_negative, m_mag), (e_negative, e_mag))) => {
                self.check_dad(path, d + 2, Some(3), true)?;
                let max = self.limits.max_integer_digits;
                let m = digits_within(m_mag, max);
                let e = if m.is_some() {
                    digits_within(e_mag, max)
                } else {
                    None
                };
                self.check_dad(path, d + 2, Some(3), m.is_some() && e.is_some())?;
                let (m, e) = (m.expect("checked above"), e.expect("checked above"));
                self.check_atoms(path, [7, 3, 1 + m_mag.len(), 3, 1 + e_mag.len()])?;
                let array = self.envelope(b"\"decimal\",", path)?;
                let m_sign = if m_negative { "-" } else { "" };
                let e_sign = if e_negative { "-" } else { "" };
                self.emit(format!("\"{m_sign}{m}\",\"{e_sign}{e}\"").as_bytes(), array)?;
                self.close(b']', array)?;
                self.close(b'}', path)
            }
            Some(Kind::List(elems)) => {
                self.check(path, d + 1, Some(tuple.len()), [4])?;
                self.open(b'[', path)?;
                self.work.push(Work::Close(b']', path));
                self.push_elements(elems, d + 1, path, false);
                Ok(())
            }
            Some(Kind::Map(entries)) => self.map(entries, d, path),
            Some(Kind::Set(elems)) => {
                self.check(path, d + 1, Some(tuple.len()), [3])?;
                let array = self.envelope(b"\"set\",", path)?;
                let payload = self.child(array, WSeg::Index(1));
                self.open(b'[', payload)?;
                self.work.push(Work::Close(b'}', path));
                self.work.push(Work::Close(b']', array));
                self.work.push(Work::Close(b']', payload));
                self.push_elements(elems, d + 1, payload, false);
                Ok(())
            }
            None => match tuple.items().split_first() {
                Some((Value::Atom(label), args)) => {
                    // Readable §2.3 step 3: a compound.
                    self.check(path, d + 1, Some(tuple.len()), [label.len()])?;
                    let array = self.envelope(b"\"compound\",", path)?;
                    let label_path = self.child(array, WSeg::Index(1));
                    match core::str::from_utf8(label.bytes()) {
                        Ok(s) => {
                            let mut bytes = Vec::new();
                            push_json_string(&mut bytes, s);
                            bytes.push(b',');
                            self.emit(&bytes, label_path)?;
                        }
                        Err(_) => {
                            self.open(b'[', label_path)?;
                            let mut bytes = b"\"bytes\",\"".to_vec();
                            push_base64(&mut bytes, label.bytes());
                            bytes.push(b'"');
                            self.emit(&bytes, label_path)?;
                            self.close(b']', label_path)?;
                            self.emit(b",", array)?;
                        }
                    }
                    let payload = self.child(array, WSeg::Index(2));
                    self.open(b'[', payload)?;
                    self.work.push(Work::Close(b'}', path));
                    self.work.push(Work::Close(b']', array));
                    self.work.push(Work::Close(b']', payload));
                    self.push_elements(args, d + 1, payload, false);
                    Ok(())
                }
                _ => {
                    // Step 4: `Tuple()` and the tuples whose first child is a tuple, in
                    // the total form. The raw envelope contributes nothing of its own.
                    let array = self.envelope(b"\"raw\",", path)?;
                    let inner = self.child(array, WSeg::Index(1));
                    self.work.push(Work::Close(b'}', path));
                    self.work.push(Work::Close(b']', array));
                    self.work.push(Work::Total(value, d, inner));
                    Ok(())
                }
            },
        }
    }

    /// A canonical map: an object when every key is text other than `$ontos`, the `map`
    /// tag otherwise.
    fn map(&mut self, entries: &'v [Value], d: u64, path: usize) -> Result<(), Fault> {
        let n = entries.len();
        let arity = if n > 0 { (n + 1).max(2) } else { 1 };
        let pair = |entry: &'v Value| -> (&'v Value, &'v Value) {
            match entry.as_tuple().map(|t| t.items()) {
                Some([key, value]) => (key, value),
                _ => unreachable!("map entries were recognized as pairs"),
            }
        };
        let names: Option<Vec<&'v str>> = entries
            .iter()
            .map(|entry| text(pair(entry).0).filter(|name| *name != "$ontos"))
            .collect();
        if let Some(names) = names {
            let (depth, shared): (u64, &[usize]) = if n > 0 {
                (d + 3, &[3, 9])
            } else {
                (d + 1, &[3])
            };
            self.check(
                path,
                depth,
                Some(arity),
                shared
                    .iter()
                    .copied()
                    .chain(names.iter().map(|name| name.len())),
            )?;
            self.open(b'{', path)?;
            self.work.push(Work::Close(b'}', path));
            for (i, (entry, name)) in entries.iter().zip(names).enumerate().rev() {
                let member = self.child(path, WSeg::Name(name));
                self.work.push(Work::Readable(pair(entry).1, d + 2, member));
                self.work.push(Work::Name(name, member));
                if i > 0 {
                    self.work.push(Work::Emit(b",", path));
                }
            }
            return Ok(());
        }
        self.check(path, d + 1, Some(arity), [3])?;
        let array = self.envelope(b"\"map\",", path)?;
        let payload = self.child(array, WSeg::Index(1));
        self.open(b'[', payload)?;
        self.work.push(Work::Close(b'}', path));
        self.work.push(Work::Close(b']', array));
        self.work.push(Work::Close(b']', payload));
        for (j, entry) in entries.iter().enumerate().rev() {
            let (key, value) = pair(entry);
            let entry_path = self.child(payload, WSeg::Index(j));
            let key_path = self.child(entry_path, WSeg::Index(0));
            let value_path = self.child(entry_path, WSeg::Index(1));
            self.work.push(Work::Close(b']', entry_path));
            self.work.push(Work::Readable(value, d + 2, value_path));
            self.work.push(Work::Emit(b",", entry_path));
            self.work.push(Work::Readable(key, d + 2, key_path));
            self.work.push(Work::Open(b'[', entry_path));
            if j > 0 {
                self.work.push(Work::Emit(b",", payload));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ontos_data::{read_list, read_map, read_set, read_text};

    /// Candidates for every label, canonical and not: the recognizer must take exactly what
    /// ontos-data's own readers take.
    fn candidates() -> Vec<Value> {
        let a = |b: &[u8]| Value::atom(b.to_vec());
        let t = |items: Vec<Value>| Value::tuple(items);
        let text = |s: &[u8]| t(vec![a(b"utf8-text"), a(s)]);
        let mut out = vec![
            a(b""),
            t(vec![]),
            t(vec![t(vec![])]),
            text(b"ok"),
            text(b"\xff"),
            text(b""),
            t(vec![a(b"utf8-text")]),
            t(vec![a(b"utf8-text"), a(b"x"), a(b"y")]),
            t(vec![a(b"utf8-text"), t(vec![])]),
        ];
        let keys = [text(b"b"), text(b"aa"), a(b""), t(vec![]), text(b"b")];
        for label in [&b"list"[..], b"map", b"set"] {
            out.push(t(vec![a(label)]));
            for i in 0..keys.len() {
                for j in 0..keys.len() {
                    let pair = |k: &Value| t(vec![k.clone(), a(b"v")]);
                    out.push(t(vec![a(label), keys[i].clone(), keys[j].clone()]));
                    out.push(t(vec![a(label), pair(&keys[i]), pair(&keys[j])]));
                    out.push(t(vec![a(label), pair(&keys[i]), keys[j].clone()]));
                    out.push(t(vec![a(label), t(vec![keys[i].clone()]), pair(&keys[j])]));
                }
            }
        }
        out
    }

    #[test]
    fn recognition_agrees_with_ontos_data() {
        for v in candidates() {
            let kind = recognize(&v);
            assert_eq!(
                matches!(kind, Some(Kind::Text(_))),
                read_text(&v).is_ok(),
                "{v}"
            );
            if let Some(Kind::Text(s)) = kind {
                assert_eq!(s, read_text(&v).unwrap());
            }
            assert_eq!(
                matches!(kind, Some(Kind::List(_))),
                read_list(&v).is_ok(),
                "{v}"
            );
            assert_eq!(
                matches!(kind, Some(Kind::Map(_))),
                read_map(&v).is_ok(),
                "{v}"
            );
            assert_eq!(
                matches!(kind, Some(Kind::Set(_))),
                read_set(&v).is_ok(),
                "{v}"
            );
        }
    }

    #[test]
    fn json_strings_escape_exactly_the_fixed_set() {
        let mut out = Vec::new();
        push_json_string(&mut out, "\"\\/\u{8}\t\n\u{c}\r\u{0}\u{1f}\u{7f}\u{2028}é");
        assert_eq!(
            out,
            "\"\\\"\\\\/\\b\\t\\n\\f\\r\\u0000\\u001f\u{7f}\u{2028}é\"".as_bytes()
        );
    }
}
