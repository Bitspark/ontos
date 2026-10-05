//! ontos/core (L0) — the frozen value model.
//!
//! ```text
//! Bytes = finite octet strings
//!
//! Value = Atom(Bytes)
//!       | Tuple(Value*)
//! ```
//!
//! A value is finite, immutable, well-founded (a finite tree, never cyclic),
//! uninterpreted, and compared by **structural identity**. This crate defines
//! *what a value is* and *when two values are the same* — nothing else. There is
//! no byte encoding here (that is `ontos-codec`) and no interpretation of atoms
//! or shapes (that is `ontos/compound` / `ontos/data` / a consumer).
//!
//! See `docs/spec/ontos-core.md`.
//!
//! # Common Value API (all three cores)
//!
//! The Go, Rust, and TypeScript cores expose the same conceptual surface so a
//! developer who learns one can predict the others. Every core provides, by its
//! own naming convention:
//!
//! - **Construct** — `Value::atom(bytes)` / `Value::tuple(items)`
//!   (Go `NewAtom`/`NewTuple`, TS `atom`/`tuple`).
//! - **Atom bytes + length** — [`Atom::bytes`] and [`Atom::len`].
//! - **Tuple children + arity + indexed access** — [`Tuple::items`],
//!   [`Tuple::len`], and [`Tuple::at`] (matching Go `Tuple.At` / TS `Tuple.at`).
//! - **Structural equality** — `PartialEq`/`Eq` (Go `Equal`, TS `equals`).
//! - **Diagnostic string** — the [`fmt::Display`] impl (Go `String`, TS `toString`),
//!   which is *not* a canonical encoding.
//!
//! # Intentional per-language extras
//!
//! Some members exist in only one core because they are idiomatic to that
//! language and have no natural cross-core analogue; they are intentional, not
//! accidental gaps:
//!
//! - **Rust** — [`Value::is_atom`], [`Value::is_tuple`], [`Value::as_atom`], and
//!   [`Value::as_tuple`]. Rust models `Value` as a closed `enum`, so these
//!   classify/borrow the variant without a `match`. Go reaches the same end with
//!   a type switch / type assertion on the `Value` interface, and TS with
//!   `instanceof` plus the `kind` discriminant — so neither needs parallel
//!   methods.
//! - **TypeScript** — a `kind` discriminant and `toJSON()`/`toHex()`. JavaScript
//!   lacks Rust enums and Go interfaces, so the discriminant restores exhaustive
//!   narrowing and `toJSON` gives structured-clone/JSON consumers a stable shape.
//!   Rust and Go have no runtime JSON contract to honor and so omit them.

use core::fmt;
use core::hash::{Hash, Hasher};

/// A foundational ontos value: either opaque bytes (`Atom`) or a finite ordered
/// tuple of values (`Tuple`). These are the only two constructors.
///
/// Identity is structural: `PartialEq`/`Eq`/`Hash` compare atoms by exact
/// bytes and tuples elementwise by arity and order. `Atom` and `Tuple` are
/// disjoint, so `Atom(b)` is never equal to any `Tuple` (including
/// `Atom("") != Tuple()`).
///
/// `Clone`, `PartialEq`/`Eq`, `Hash`, `Debug`, `Display` and dropping all walk
/// with an explicit heap stack, never one native frame per nesting level, so a
/// value of any depth can be handled and dropped (ontos-internal#340). Their results are the
/// ones `#[derive]` would give.
pub enum Value {
    Atom(Atom),
    Tuple(Tuple),
}

/// An opaque finite byte string. The bytes have no built-in interpretation.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Atom {
    bytes: Vec<u8>,
}

/// A finite ordered tuple of values. Arity, order, and multiplicity are part of
/// the value's identity.
pub struct Tuple {
    items: Vec<Value>,
}

impl Value {
    /// Construct an atom from any byte source.
    pub fn atom<B: Into<Vec<u8>>>(bytes: B) -> Self {
        Self::Atom(Atom::new(bytes))
    }

    /// Construct a tuple from an iterator of child values.
    pub fn tuple<I>(items: I) -> Self
    where
        I: IntoIterator<Item = Value>,
    {
        Self::Tuple(Tuple::new(items))
    }

    /// Borrow as an `Atom`, or `None` if this is a `Tuple`.
    pub fn as_atom(&self) -> Option<&Atom> {
        match self {
            Self::Atom(atom) => Some(atom),
            Self::Tuple(_) => None,
        }
    }

    /// Borrow as a `Tuple`, or `None` if this is an `Atom`.
    pub fn as_tuple(&self) -> Option<&Tuple> {
        match self {
            Self::Atom(_) => None,
            Self::Tuple(tuple) => Some(tuple),
        }
    }

    /// True if this value is an atom.
    pub fn is_atom(&self) -> bool {
        matches!(self, Self::Atom(_))
    }

    /// True if this value is a tuple.
    pub fn is_tuple(&self) -> bool {
        matches!(self, Self::Tuple(_))
    }
}

impl Atom {
    pub fn new<B: Into<Vec<u8>>>(bytes: B) -> Self {
        Self {
            bytes: bytes.into(),
        }
    }

    /// The exact uninterpreted bytes of this atom.
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

impl Tuple {
    pub fn new<I>(items: I) -> Self
    where
        I: IntoIterator<Item = Value>,
    {
        Self {
            items: items.into_iter().collect(),
        }
    }

    /// The tuple's ordered children.
    pub fn items(&self) -> &[Value] {
        &self.items
    }

    /// The arity (number of children).
    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// Borrow child `i`, or `None` if `i` is out of range. The safe indexed
    /// accessor in the common core API, matching Go `Tuple.At` and TS
    /// `Tuple.at`; for the whole slice (and iteration) use [`items`](Self::items).
    pub fn at(&self, i: usize) -> Option<&Value> {
        self.items.get(i)
    }
}

// ── Iterative structural traits (ontos-internal#340) ───────────────────────────────────────
//
// `Value` is a tree whose depth is chosen by whoever builds it, so no trait on it may spend one
// native stack frame per nesting level: a derived `Drop`, `Clone`, `PartialEq`, `Hash` or
// `Debug` overflows the stack, and aborts the process, on a value nested deeper than the thread
// stack holds. That includes merely letting such a value go out of scope. Each impl below walks
// with an explicit heap stack instead. Every observable result is the derive's: the same
// equality, the same `Hash` write sequence (so the same hash, not merely one consistent with
// `Eq`), and the same `Debug` text under every format flag, pretty or not.
//
// `Atom` keeps its derives: it holds bytes, not values, so it cannot nest.

impl Drop for Tuple {
    /// Moves every descendant onto one heap stack before it is dropped, so each `Tuple`'s own
    /// drop sees an empty child list and dropping never recurses.
    fn drop(&mut self) {
        let mut pending: Vec<Value> = core::mem::take(&mut self.items);
        while let Some(value) = pending.pop() {
            if let Value::Tuple(mut tuple) = value {
                pending.append(&mut tuple.items);
            }
        }
    }
}

impl Clone for Value {
    fn clone(&self) -> Self {
        enum Step<'a> {
            Visit(&'a Value),
            Close(usize),
        }
        let mut steps = vec![Step::Visit(self)];
        let mut built: Vec<Value> = Vec::new();
        while let Some(step) = steps.pop() {
            match step {
                Step::Visit(Value::Atom(atom)) => built.push(Value::Atom(atom.clone())),
                Step::Visit(Value::Tuple(tuple)) => {
                    steps.push(Step::Close(tuple.items.len()));
                    steps.extend(tuple.items.iter().rev().map(Step::Visit));
                }
                Step::Close(arity) => {
                    let items = built.split_off(built.len() - arity);
                    built.push(Value::Tuple(Tuple { items }));
                }
            }
        }
        built
            .pop()
            .expect("a clone walk ends with exactly the cloned root")
    }
}

impl Clone for Tuple {
    fn clone(&self) -> Self {
        Self {
            items: self.items.iter().map(Value::clone).collect(),
        }
    }
}

impl PartialEq for Value {
    fn eq(&self, other: &Self) -> bool {
        let mut pairs = vec![(self, other)];
        while let Some(pair) = pairs.pop() {
            match pair {
                (Value::Atom(a), Value::Atom(b)) => {
                    if a != b {
                        return false;
                    }
                }
                (Value::Tuple(a), Value::Tuple(b)) => {
                    if a.items.len() != b.items.len() {
                        return false;
                    }
                    pairs.extend(a.items.iter().zip(&b.items).rev());
                }
                _ => return false,
            }
        }
        true
    }
}

impl Eq for Value {}

impl PartialEq for Tuple {
    fn eq(&self, other: &Self) -> bool {
        self.items.len() == other.items.len()
            && self.items.iter().zip(&other.items).all(|(a, b)| a == b)
    }
}

impl Eq for Tuple {}

impl Hash for Value {
    /// The derive's write sequence, in the derive's pre-order: each value writes its
    /// discriminant, then an atom its bytes (as `Vec<u8>` does) and a tuple its length followed
    /// by its items. A slice hashes its length with `write_length_prefix`, whose stable
    /// behaviour is `write_usize`; that is the call made here.
    fn hash<H: Hasher>(&self, state: &mut H) {
        let mut pending = vec![self];
        while let Some(value) = pending.pop() {
            core::mem::discriminant(value).hash(state);
            match value {
                Value::Atom(atom) => atom.hash(state),
                Value::Tuple(tuple) => {
                    state.write_usize(tuple.items.len());
                    pending.extend(tuple.items.iter().rev());
                }
            }
        }
    }
}

impl Hash for Tuple {
    fn hash<H: Hasher>(&self, state: &mut H) {
        state.write_usize(self.items.len());
        for item in &self.items {
            item.hash(state);
        }
    }
}

/// One piece of a derived-`Debug` rendering, written in order by [`debug_walk`].
enum Piece<'a> {
    Text(&'static str),
    /// A line break and `level` indents: what the derive's pretty printer emits before a nested
    /// element and before its parent's closing text.
    Break(usize),
    /// A `Vec<u8>` field rendered as a list, its elements at `level + 1`.
    Bytes(&'a [u8], usize),
    Value(&'a Value, usize),
    TupleBody(&'a Tuple, usize),
}

/// Writes `level` indents of four spaces, the derive's pretty-print indent.
fn indent(f: &mut fmt::Formatter<'_>, level: usize) -> fmt::Result {
    for _ in 0..level {
        f.write_str("    ")?;
    }
    Ok(())
}

/// Renders exactly what `#[derive(Debug)]` renders for `Value` and `Tuple`, without recursing.
/// Byte values go through `u8`'s own `Debug` with the caller's formatter, so every flag
/// (`{:x?}`, `{:#X?}`, a width) applies to them exactly as it does under the derive.
fn debug_walk(first: Piece<'_>, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    let pretty = f.alternate();
    let mut pending = vec![first];
    while let Some(piece) = pending.pop() {
        match piece {
            Piece::Text(text) => f.write_str(text)?,
            Piece::Break(level) => {
                f.write_str("\n")?;
                indent(f, level)?;
            }
            Piece::Bytes(bytes, level) => {
                if bytes.is_empty() {
                    f.write_str("[]")?;
                } else if pretty {
                    f.write_str("[")?;
                    for byte in bytes {
                        f.write_str("\n")?;
                        indent(f, level + 1)?;
                        fmt::Debug::fmt(byte, f)?;
                        f.write_str(",")?;
                    }
                    f.write_str("\n")?;
                    indent(f, level)?;
                    f.write_str("]")?;
                } else {
                    f.write_str("[")?;
                    for (index, byte) in bytes.iter().enumerate() {
                        if index != 0 {
                            f.write_str(", ")?;
                        }
                        fmt::Debug::fmt(byte, f)?;
                    }
                    f.write_str("]")?;
                }
            }
            // Each expansion is listed in writing order and pushed in reverse.
            Piece::Value(Value::Atom(atom), level) => {
                let seq: Vec<Piece<'_>> = if pretty {
                    vec![
                        Piece::Text("Atom("),
                        Piece::Break(level + 1),
                        Piece::Text("Atom {"),
                        Piece::Break(level + 2),
                        Piece::Text("bytes: "),
                        Piece::Bytes(atom.bytes(), level + 2),
                        Piece::Text(","),
                        Piece::Break(level + 1),
                        Piece::Text("},"),
                        Piece::Break(level),
                        Piece::Text(")"),
                    ]
                } else {
                    vec![
                        Piece::Text("Atom(Atom { bytes: "),
                        Piece::Bytes(atom.bytes(), level),
                        Piece::Text(" })"),
                    ]
                };
                pending.extend(seq.into_iter().rev());
            }
            Piece::Value(Value::Tuple(tuple), level) => {
                let seq: Vec<Piece<'_>> = if pretty {
                    vec![
                        Piece::Text("Tuple("),
                        Piece::Break(level + 1),
                        Piece::TupleBody(tuple, level + 1),
                        Piece::Text(","),
                        Piece::Break(level),
                        Piece::Text(")"),
                    ]
                } else {
                    vec![
                        Piece::Text("Tuple("),
                        Piece::TupleBody(tuple, level),
                        Piece::Text(")"),
                    ]
                };
                pending.extend(seq.into_iter().rev());
            }
            Piece::TupleBody(tuple, level) => {
                let mut seq: Vec<Piece<'_>> = Vec::with_capacity(tuple.items.len() * 3 + 8);
                if pretty {
                    seq.push(Piece::Text("Tuple {"));
                    seq.push(Piece::Break(level + 1));
                    seq.push(Piece::Text("items: "));
                } else {
                    seq.push(Piece::Text("Tuple { items: "));
                }
                if tuple.items.is_empty() {
                    seq.push(Piece::Text("[]"));
                } else if pretty {
                    seq.push(Piece::Text("["));
                    for item in &tuple.items {
                        seq.push(Piece::Break(level + 2));
                        seq.push(Piece::Value(item, level + 2));
                        seq.push(Piece::Text(","));
                    }
                    seq.push(Piece::Break(level + 1));
                    seq.push(Piece::Text("]"));
                } else {
                    seq.push(Piece::Text("["));
                    for (index, item) in tuple.items.iter().enumerate() {
                        if index != 0 {
                            seq.push(Piece::Text(", "));
                        }
                        seq.push(Piece::Value(item, level));
                    }
                    seq.push(Piece::Text("]"));
                }
                if pretty {
                    seq.push(Piece::Text(","));
                    seq.push(Piece::Break(level));
                    seq.push(Piece::Text("}"));
                } else {
                    seq.push(Piece::Text(" }"));
                }
                pending.extend(seq.into_iter().rev());
            }
        }
    }
    Ok(())
}

impl fmt::Debug for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        debug_walk(Piece::Value(self, 0), f)
    }
}

impl fmt::Debug for Tuple {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        debug_walk(Piece::TupleBody(self, 0), f)
    }
}

impl fmt::Display for Value {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        enum Step<'a> {
            Visit(&'a Value),
            Text(&'static str),
        }
        let mut steps = vec![Step::Visit(self)];
        while let Some(step) = steps.pop() {
            match step {
                Step::Text(text) => f.write_str(text)?,
                Step::Visit(Value::Atom(atom)) => {
                    write!(f, "Atom(0x")?;
                    for byte in atom.bytes() {
                        write!(f, "{byte:02x}")?;
                    }
                    write!(f, ")")?;
                }
                Step::Visit(Value::Tuple(tuple)) => {
                    steps.push(Step::Text(")"));
                    for (index, item) in tuple.items.iter().enumerate().rev() {
                        steps.push(Step::Visit(item));
                        if index != 0 {
                            steps.push(Step::Text(", "));
                        }
                    }
                    steps.push(Step::Text("Tuple("));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atoms_compare_by_exact_bytes() {
        assert_eq!(Value::atom(vec![1, 2, 3]), Value::atom(vec![1, 2, 3]));
        assert_ne!(Value::atom(vec![1, 2, 3]), Value::atom(vec![1, 2, 4]));
    }

    #[test]
    fn atom_length_is_significant() {
        assert_ne!(Value::atom(vec![1]), Value::atom(vec![0, 1]));
    }

    #[test]
    fn empty_atom_and_empty_tuple_are_distinct() {
        assert_ne!(
            Value::atom(Vec::<u8>::new()),
            Value::tuple(Vec::<Value>::new())
        );
    }

    #[test]
    fn tuples_compare_structurally() {
        let a = Value::tuple(vec![Value::atom(vec![0x61]), Value::atom(vec![0x62])]);
        let b = Value::tuple(vec![Value::atom(vec![0x61]), Value::atom(vec![0x62])]);
        let swapped = Value::tuple(vec![Value::atom(vec![0x62]), Value::atom(vec![0x61])]);
        assert_eq!(a, b);
        assert_ne!(a, swapped);
    }

    #[test]
    fn nesting_is_significant() {
        let nested = Value::tuple(vec![Value::tuple(vec![
            Value::atom(vec![0x61]),
            Value::atom(vec![0x62]),
        ])]);
        let flat = Value::tuple(vec![Value::atom(vec![0x61]), Value::atom(vec![0x62])]);
        assert_ne!(nested, flat);
    }

    #[test]
    fn tuple_at_returns_children_in_order() {
        let first = Value::atom(vec![0x61]);
        let second = Value::atom(vec![0x62]);
        let t = Tuple::new(vec![first.clone(), second.clone()]);
        assert_eq!(t.len(), 2);
        assert!(!t.is_empty());
        assert_eq!(t.at(0), Some(&first));
        assert_eq!(t.at(1), Some(&second));
        // at() agrees with the items() slice at the same index.
        assert_eq!(t.at(0), t.items().first());
    }

    #[test]
    fn tuple_at_out_of_range_is_none() {
        let t = Tuple::new(vec![Value::atom(vec![0x61])]);
        assert_eq!(t.at(1), None);
        let empty = Tuple::new(Vec::<Value>::new());
        assert!(empty.is_empty());
        assert_eq!(empty.len(), 0);
        assert_eq!(empty.at(0), None);
    }

    #[test]
    fn atom_len_and_is_empty() {
        let a = Atom::new(vec![1, 2, 3]);
        assert_eq!(a.len(), 3);
        assert!(!a.is_empty());
        let empty = Atom::new(Vec::<u8>::new());
        assert_eq!(empty.len(), 0);
        assert!(empty.is_empty());
    }

    #[test]
    fn reflection_helpers_classify_and_borrow() {
        let a = Value::atom(vec![0x61]);
        let t = Value::tuple(vec![Value::atom(vec![0x62])]);
        assert!(a.is_atom() && !a.is_tuple());
        assert!(t.is_tuple() && !t.is_atom());
        assert_eq!(a.as_atom().map(Atom::len), Some(1));
        assert!(a.as_tuple().is_none());
        assert_eq!(t.as_tuple().map(Tuple::len), Some(1));
        assert!(t.as_atom().is_none());
    }

    // ── ontos-internal#340: the iterative traits give the derive's results ─────────────────
    //
    // `mirror` is the type as it was before ontos-internal#340, with every trait DERIVED. The tests convert
    // shallow values to it and require identical results: the same Debug text under each format
    // flag, the same Hash write sequence, the same equality. The type and field names match the
    // real ones, because the derived Debug text spells them.
    mod mirror {
        #[derive(Clone, Debug, PartialEq, Eq, Hash)]
        pub enum Value {
            Atom(Atom),
            Tuple(Tuple),
        }
        #[derive(Clone, Debug, PartialEq, Eq, Hash)]
        pub struct Atom {
            pub bytes: Vec<u8>,
        }
        #[derive(Clone, Debug, PartialEq, Eq, Hash)]
        pub struct Tuple {
            pub items: Vec<Value>,
        }
    }

    fn to_mirror(v: &Value) -> mirror::Value {
        match v {
            Value::Atom(a) => mirror::Value::Atom(mirror::Atom {
                bytes: a.bytes().to_vec(),
            }),
            Value::Tuple(t) => mirror::Value::Tuple(mirror::Tuple {
                items: t.items().iter().map(to_mirror).collect(),
            }),
        }
    }

    /// A small deterministic generator (xorshift), so the corpus is fixed without a dependency.
    struct Gen(u64);
    impl Gen {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            self.0 = x;
            x
        }
        fn value(&mut self, depth: u32) -> Value {
            if depth == 0 || self.next().is_multiple_of(3) {
                let len = (self.next() % 4) as usize;
                Value::atom((0..len).map(|_| self.next() as u8).collect::<Vec<u8>>())
            } else {
                let arity = (self.next() % 4) as usize;
                Value::tuple(
                    (0..arity)
                        .map(|_| self.value(depth - 1))
                        .collect::<Vec<_>>(),
                )
            }
        }
    }

    fn corpus() -> Vec<Value> {
        let mut g = Gen(0x9e37_79b9_7f4a_7c15);
        let mut out: Vec<Value> = (0..300).map(|_| g.value(5)).collect();
        out.push(Value::atom(Vec::<u8>::new()));
        out.push(Value::tuple(Vec::<Value>::new()));
        out.push(Value::tuple(vec![Value::tuple(Vec::<Value>::new())]));
        out
    }

    /// Records every call a `Hash` impl makes, so two impls can be compared write for write.
    #[derive(Default, PartialEq, Debug)]
    struct Recorder(Vec<(&'static str, Vec<u8>)>);
    impl Hasher for Recorder {
        fn finish(&self) -> u64 {
            0
        }
        fn write(&mut self, bytes: &[u8]) {
            self.0.push(("write", bytes.to_vec()));
        }
        fn write_u8(&mut self, i: u8) {
            self.0.push(("u8", vec![i]));
        }
        fn write_usize(&mut self, i: usize) {
            self.0.push(("usize", i.to_le_bytes().to_vec()));
        }
        fn write_isize(&mut self, i: isize) {
            self.0.push(("isize", i.to_le_bytes().to_vec()));
        }
        fn write_u64(&mut self, i: u64) {
            self.0.push(("u64", i.to_le_bytes().to_vec()));
        }
        fn write_i64(&mut self, i: i64) {
            self.0.push(("i64", i.to_le_bytes().to_vec()));
        }
    }

    fn recorded<T: Hash>(t: &T) -> Recorder {
        let mut r = Recorder::default();
        t.hash(&mut r);
        r
    }

    fn std_hash<T: Hash>(t: &T) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        t.hash(&mut h);
        h.finish()
    }

    #[test]
    fn debug_text_is_the_derived_text_under_every_flag() {
        for v in corpus() {
            let m = to_mirror(&v);
            assert_eq!(format!("{v:?}"), format!("{m:?}"));
            assert_eq!(format!("{v:#?}"), format!("{m:#?}"));
            assert_eq!(format!("{v:x?}"), format!("{m:x?}"));
            assert_eq!(format!("{v:#X?}"), format!("{m:#X?}"));
            assert_eq!(format!("{v:5?}"), format!("{m:5?}"));
            assert_eq!(format!("{v:<#4x?}"), format!("{m:<#4x?}"));
            if let (Value::Tuple(t), mirror::Value::Tuple(mt)) = (&v, &m) {
                assert_eq!(format!("{t:?}"), format!("{mt:?}"));
                assert_eq!(format!("{t:#?}"), format!("{mt:#?}"));
            }
        }
    }

    #[test]
    fn hash_makes_the_derived_write_sequence() {
        for v in corpus() {
            let m = to_mirror(&v);
            assert_eq!(recorded(&v), recorded(&m), "write sequence for {v}");
            assert_eq!(std_hash(&v), std_hash(&m));
            if let (Value::Tuple(t), mirror::Value::Tuple(mt)) = (&v, &m) {
                assert_eq!(recorded(t), recorded(mt));
            }
        }
    }

    #[test]
    fn equality_and_clone_agree_with_the_derive() {
        let all = corpus();
        let mirrors: Vec<_> = all.iter().map(to_mirror).collect();
        for (i, a) in all.iter().enumerate() {
            for (j, b) in all.iter().enumerate() {
                assert_eq!(a == b, mirrors[i] == mirrors[j], "eq of #{i} and #{j}");
            }
            let c = a.clone();
            assert_eq!(&c, a);
            assert_eq!(to_mirror(&c), mirrors[i]);
            if let Value::Tuple(t) = a {
                let tc = t.clone();
                assert_eq!(&tc, t);
            }
        }
    }

    // ── ontos-internal#340: depth is never a property of the native stack ──────────────────

    const DEEP: usize = 1_000_000;

    /// DEEP one-element tuples around the atom "a", built without recursion.
    fn nested(depth: usize) -> Value {
        let mut v = Value::atom(vec![0x61]);
        for _ in 0..depth {
            v = Value::tuple([v]);
        }
        v
    }

    /// Counts bytes written without keeping them, so formatting a deep value costs no memory.
    struct Count(usize);
    impl fmt::Write for Count {
        fn write_str(&mut self, s: &str) -> fmt::Result {
            self.0 += s.len();
            Ok(())
        }
    }

    #[test]
    fn a_million_deep_value_survives_every_trait_on_the_default_stack() {
        use core::fmt::Write as _;

        let v = nested(DEEP);
        let c = v.clone();
        assert!(v == c);
        let mut wider = nested(DEEP);
        if let Value::Tuple(t) = &mut wider {
            t.items.push(Value::atom(Vec::<u8>::new()));
        }
        assert!(v != wider, "a difference at the root is still seen");
        assert_eq!(std_hash(&v), std_hash(&c));

        let mut n = Count(0);
        write!(n, "{v}").unwrap();
        assert_eq!(n.0, DEEP * "Tuple()".len() + "Atom(0x61)".len());

        let mut n = Count(0);
        write!(n, "{v:?}").unwrap();
        let per_level = "Tuple(Tuple { items: [".len() + "] })".len();
        assert_eq!(n.0, DEEP * per_level + "Atom(Atom { bytes: [97] })".len());

        drop(wider);
        drop(c);
        drop(v);
    }

    #[test]
    fn pretty_debug_of_a_deep_value_does_not_recurse() {
        use core::fmt::Write as _;
        // Pretty output grows with depth squared (each line is indented), so this depth is
        // bounded by output size, not by the stack.
        let v = nested(3_000);
        let mut n = Count(0);
        write!(n, "{v:#?}").unwrap();
        assert!(n.0 > 0);
    }
}
