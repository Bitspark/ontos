//! Package-local replay of the shared L0 structural-identity vectors
//! (`../../vectors/identity.json`) against `ontos-core`, the package that *defines*
//! the floor. The same vectors are also replayed inside the codec suite
//! (`codec/rs/tests/vectors.rs`), but pinning them here makes the published
//! `ontos-core` crate independently testable: identity is asserted at the layer
//! that owns it, using only the public `Value` / `equals` (`==`) API.
//!
//! A self-contained minimal JSON reader is used so that `ontos-core` stays
//! dependency-free (the frozen floor depends on nothing). It mirrors the reader in
//! `codec/rs/tests/vectors.rs`.

use ontos_core::Value;

// ----- tiny JSON parser (test-only; just enough for the vector file) -----

#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> P<'a> {
    fn new(s: &'a str) -> Self {
        P {
            b: s.as_bytes(),
            i: 0,
        }
    }
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\r' | b'\n') {
            self.i += 1;
        }
    }
    fn value(&mut self) -> Json {
        self.ws();
        match self.b[self.i] {
            b'{' => self.obj(),
            b'[' => self.arr(),
            b'"' => Json::Str(self.string()),
            b't' => {
                self.i += 4;
                Json::Bool(true)
            }
            b'f' => {
                self.i += 5;
                Json::Bool(false)
            }
            b'n' => {
                self.i += 4;
                Json::Null
            }
            _ => self.num(),
        }
    }
    fn obj(&mut self) -> Json {
        self.i += 1; // {
        let mut out = Vec::new();
        self.ws();
        if self.b[self.i] == b'}' {
            self.i += 1;
            return Json::Obj(out);
        }
        loop {
            self.ws();
            let k = self.string();
            self.ws();
            self.i += 1; // :
            let v = self.value();
            out.push((k, v));
            self.ws();
            let c = self.b[self.i];
            self.i += 1; // , or }
            if c == b'}' {
                break;
            }
        }
        Json::Obj(out)
    }
    fn arr(&mut self) -> Json {
        self.i += 1; // [
        let mut out = Vec::new();
        self.ws();
        if self.b[self.i] == b']' {
            self.i += 1;
            return Json::Arr(out);
        }
        loop {
            out.push(self.value());
            self.ws();
            let c = self.b[self.i];
            self.i += 1; // , or ]
            if c == b']' {
                break;
            }
        }
        Json::Arr(out)
    }
    fn string(&mut self) -> String {
        self.i += 1; // opening quote
        let mut s = String::new();
        while self.b[self.i] != b'"' {
            let c = self.b[self.i];
            if c == b'\\' {
                self.i += 1;
                let e = self.b[self.i];
                match e {
                    b'n' => s.push('\n'),
                    b't' => s.push('\t'),
                    b'r' => s.push('\r'),
                    b'"' => s.push('"'),
                    b'\\' => s.push('\\'),
                    b'/' => s.push('/'),
                    _ => s.push(e as char),
                }
                self.i += 1;
            } else {
                s.push(c as char);
                self.i += 1;
            }
        }
        self.i += 1; // closing quote
        s
    }
    fn num(&mut self) -> Json {
        let start = self.i;
        while self.i < self.b.len()
            && matches!(
                self.b[self.i],
                b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'
            )
        {
            self.i += 1;
        }
        let s = std::str::from_utf8(&self.b[start..self.i]).unwrap();
        Json::Num(s.parse().unwrap())
    }
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(kvs) => kvs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(a) => a,
            _ => panic!("expected array"),
        }
    }
    fn str(&self) -> &str {
        match self {
            Json::Str(s) => s,
            _ => panic!("expected string"),
        }
    }
    fn boolean(&self) -> bool {
        match self {
            Json::Bool(b) => *b,
            _ => panic!("expected bool"),
        }
    }
}

// ----- helpers -----

fn hex_to_bytes(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "hex must be even length: {s:?}");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// Build a core `Value` from the vector authoring notation
/// `{atom:hex}` | `{tuple:[...]}` (NOT ontos's canonical encoding).
fn value_from_json(j: &Json) -> Value {
    if let Some(a) = j.get("atom") {
        Value::atom(hex_to_bytes(a.str()))
    } else if let Some(t) = j.get("tuple") {
        Value::tuple(t.arr().iter().map(value_from_json).collect::<Vec<_>>())
    } else {
        panic!("value must be {{atom}} or {{tuple}}: {j:?}");
    }
}

fn read_vectors(name: &str) -> Json {
    let path = format!("{}/../../vectors/{}", env!("CARGO_MANIFEST_DIR"), name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    P::new(&text).value()
}

// ----- the test -----

/// Every L0 identity vector: `equals(left, right) == expected`, asserted directly
/// against `ontos-core`'s `PartialEq` (`==`) — the structural identity the floor
/// defines (docs/spec/ontos-core.md §3).
#[test]
fn identity_vectors() {
    let doc = read_vectors("identity.json");
    let mut n = 0;
    for case in doc.get("cases").unwrap().arr() {
        let name = case.get("name").unwrap().str();
        let left = value_from_json(case.get("left").unwrap());
        let right = value_from_json(case.get("right").unwrap());
        let want = case.get("equal").unwrap().boolean();
        assert_eq!(left == right, want, "identity case {name:?}");
        n += 1;
    }
    assert!(n > 0, "no identity cases loaded");
    eprintln!("core identity: {n} cases OK");
}
