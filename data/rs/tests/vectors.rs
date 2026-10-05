//! Replays the shared, language-agnostic ontos/data conformance vectors
//! (`../../vectors/data.json`) against this Rust implementation, and adds local
//! recognition (negative) and round-trip (positive) tests beyond the vectors.
//!
//! A self-contained minimal JSON reader is used here (copied from
//! `codec/rs/tests/vectors.rs`) to keep the test's own parsing dependency-free.
//! `ontos-codec` is a runtime dependency of `ontos-data` (the `map` entry order is
//! codec byte order, §5.7); the full byte chain (datum -> Value -> bytes) is also
//! asserted with it here.

use ontos_codec::encode as codec_encode;
use ontos_core::Value;
use ontos_data::{
    encode_bool, encode_decimal, encode_int, encode_list, encode_map, encode_null, encode_set,
    encode_text, read_bool, read_decimal, read_int, read_list, read_map, read_null, read_set,
    read_text, recognize_decimal, recognize_int, recognize_null, DataError,
};

// ----- tiny JSON parser (test-only; just enough for the vector files) -----

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
}

// ----- helpers -----

fn hex_to_bytes(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "hex must be even length: {s:?}");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn bytes_to_hex(b: &[u8]) -> String {
    let mut s = String::new();
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

/// Build a core `Value` from the vector authoring notation
/// `{atom:hex}` | `{tuple:[...]}`.
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

/// The embedding label of a value (the first child atom of its tuple), as bytes.
fn label_of(v: &Value) -> Vec<u8> {
    v.as_tuple()
        .and_then(|t| t.items().first())
        .and_then(Value::as_atom)
        .map(|a| a.bytes().to_vec())
        .unwrap_or_else(|| panic!("vector value has no label: {v}"))
}

/// The children of a labeled tuple after the label (the embedding's payload slots).
fn children_after_label(v: &Value) -> Vec<Value> {
    let items = v.as_tuple().expect("tuple").items();
    items[1..].to_vec()
}

/// The `(key, value)` entries of a `map` value, derived structurally: each child
/// after the `map` label must be an exactly-arity-2 `Tuple(key, value)`.
fn map_entries_of(v: &Value) -> Vec<(Value, Value)> {
    children_after_label(v)
        .into_iter()
        .map(|entry| {
            let items = entry.as_tuple().expect("map entry is a tuple").items();
            assert_eq!(items.len(), 2, "map entry is an arity-2 (key, value) tuple");
            (items[0].clone(), items[1].clone())
        })
        .collect()
}

/// The single payload atom's bytes of a scalar embedding `Tuple(label, Atom(p))`.
fn scalar_payload_bytes(v: &Value) -> Vec<u8> {
    let kids = children_after_label(v);
    assert_eq!(kids.len(), 1, "scalar embedding has one payload child");
    kids[0]
        .as_atom()
        .expect("scalar payload is an atom")
        .bytes()
        .to_vec()
}

// ----- (A) replay the frozen vectors/data.json -----

#[test]
fn data_vectors() {
    let doc = read_vectors("data.json");
    let mut n = 0;
    for case in doc.get("encode").unwrap().arr() {
        let name = case.get("name").unwrap().str();
        let value = value_from_json(case.get("value").unwrap());
        let want_hex = case.get("hex").unwrap().str();

        // Dispatch on the embedding's label (child0 of the vector value).
        match label_of(&value).as_slice() {
            b"int" => {
                // datum: the base-10 integer. A datum within i128 round-trips through
                // this binding's host type; a datum BEYOND i128 (e.g. 2^128) is still a
                // canonical int — RECOGNIZED structurally — but read_int reports it as a
                // resource limit (IntOutOfRange), never a not-recognized rejection
                // (ontos-data.md §5.1, the int-layer analog of ontos-codec §3.1). The
                // full byte chain is asserted below for every case regardless.
                match case.get("datum").unwrap().str().parse::<i128>() {
                    Ok(datum) => {
                        assert_eq!(encode_int(datum), value, "encode int {name:?}");
                        assert_eq!(read_int(&value).unwrap(), datum, "read int {name:?}");
                        assert_eq!(
                            encode_int(read_int(&value).unwrap()),
                            value,
                            "round-trip int {name:?}"
                        );
                    }
                    Err(_) => {
                        // Beyond i128: recognized, but not materializable in this binding.
                        assert_eq!(recognize_int(&value), Ok(()), "recognize int {name:?}");
                        assert_eq!(
                            read_int(&value),
                            Err(DataError::IntOutOfRange),
                            "read int {name:?} is a resource limit, not a reject"
                        );
                    }
                }
            }
            b"bool" => {
                // datum: "true"/"false".
                let datum = match case.get("datum").unwrap().str() {
                    "true" => true,
                    "false" => false,
                    other => panic!("bool datum {name:?}: {other:?}"),
                };
                assert_eq!(encode_bool(datum), value, "encode bool {name:?}");
                assert_eq!(read_bool(&value).unwrap(), datum, "read bool {name:?}");
                assert_eq!(
                    encode_bool(read_bool(&value).unwrap()),
                    value,
                    "round-trip bool {name:?}"
                );
            }
            b"utf8-text" => {
                // datum is display-only; derive the text from V structurally.
                let datum =
                    String::from_utf8(scalar_payload_bytes(&value)).expect("text payload is UTF-8");
                assert_eq!(encode_text(&datum), value, "encode text {name:?}");
                assert_eq!(read_text(&value).unwrap(), datum, "read text {name:?}");
                assert_eq!(
                    encode_text(&read_text(&value).unwrap()),
                    value,
                    "round-trip text {name:?}"
                );
            }
            b"list" => {
                // datum is display-only; derive the elements from V structurally.
                let datum = children_after_label(&value);
                assert_eq!(encode_list(&datum), value, "encode list {name:?}");
                assert_eq!(read_list(&value).unwrap(), datum, "read list {name:?}");
                assert_eq!(
                    encode_list(&read_list(&value).unwrap()),
                    value,
                    "round-trip list {name:?}"
                );
            }
            b"map" => {
                // datum is display-only; derive the entries from V structurally: each
                // child after the label is an arity-2 Tuple(key, value).
                let entries = map_entries_of(&value);

                // encode_map(entries) == V (the vector is already canonical/sorted).
                assert_eq!(encode_map(&entries).unwrap(), value, "encode map {name:?}");

                // encode_map SORTS: feeding the entries REVERSED still yields V. (For a
                // 0/1-entry map this is trivially the same list, which is fine.)
                let mut reversed = entries.clone();
                reversed.reverse();
                assert_eq!(
                    encode_map(&reversed).unwrap(),
                    value,
                    "encode map sorts (reversed) {name:?}"
                );

                // read_map(V) == those entries, and round-trips.
                assert_eq!(read_map(&value).unwrap(), entries, "read map {name:?}");
                assert_eq!(
                    encode_map(&read_map(&value).unwrap()).unwrap(),
                    value,
                    "round-trip map {name:?}"
                );
            }
            b"set" => {
                // datum is display-only; derive the elements from V structurally: each
                // child after the `set` label is a single element value (NOT an entry).
                let elems = children_after_label(&value);

                // encode_set(elems) == V (the vector is already canonical/sorted).
                assert_eq!(encode_set(&elems).unwrap(), value, "encode set {name:?}");

                // encode_set SORTS: feeding the elements REVERSED still yields V. (For a
                // 0/1-element set this is trivially the same list, which is fine.)
                let mut reversed = elems.clone();
                reversed.reverse();
                assert_eq!(
                    encode_set(&reversed).unwrap(),
                    value,
                    "encode set sorts (reversed) {name:?}"
                );

                // read_set(V) == those elements, and round-trips.
                assert_eq!(read_set(&value).unwrap(), elems, "read set {name:?}");
                assert_eq!(
                    encode_set(&read_set(&value).unwrap()).unwrap(),
                    value,
                    "round-trip set {name:?}"
                );
            }
            b"decimal" => {
                // datum is display-only; derive (mantissa, exponent) from V via
                // read_decimal and round-trip. A mantissa/exponent BEYOND i128
                // (decimal_2pow128_mantissa) is still a canonical decimal — RECOGNIZED
                // structurally — but read_decimal reports the int-layer resource limit
                // (IntOutOfRange), exactly as int_2pow128 does (ontos-data.md §5.9). The
                // full byte chain is asserted below for every case regardless.
                match read_decimal(&value) {
                    Ok((mantissa, exponent)) => {
                        // The vector is already canonical, so encoding the read pair
                        // (which read_decimal returns already normalized) reproduces V.
                        assert_eq!(
                            encode_decimal(mantissa, exponent).unwrap(),
                            value,
                            "round-trip decimal {name:?}"
                        );
                    }
                    Err(DataError::IntOutOfRange) => {
                        assert_eq!(
                            recognize_decimal(&value),
                            Ok(()),
                            "recognize decimal {name:?} (beyond host width)"
                        );
                    }
                    Err(e) => panic!("decimal vector {name:?} not recognized: {e:?}"),
                }
            }
            b"null" => {
                // null is the single inhabitant; there is no datum to derive — encode_null()
                // must reproduce V, and recognize/read both accept it.
                assert_eq!(encode_null(), value, "encode null {name:?}");
                assert_eq!(recognize_null(&value), Ok(()), "recognize null {name:?}");
                assert_eq!(read_null(&value), Ok(()), "read null {name:?}");
            }
            other => panic!("unrecognized embedding label in vector {name:?}: {other:?}"),
        }

        // FULL byte chain: datum -> Value -> bytes (via ontos-codec) == case.hex.
        assert_eq!(
            bytes_to_hex(&codec_encode(&value)),
            want_hex,
            "byte chain {name:?}"
        );
        n += 1;
    }
    assert!(n > 0, "no data vectors loaded");
    eprintln!("data: {n} vectors OK");
}

// ----- (A2) replay the shared reject cases (cross-language recognition pin) -----

#[test]
fn data_reject_vectors() {
    // Each `reject` case is valid at L0 but NOT a well-formed embedding of its
    // `kind`; read_<kind> must reject it. The reject DECISION is pinned across
    // go/rs/ts here; the specific DataError variant stays implementation-local.
    let doc = read_vectors("data.json");
    let cases = doc.get("reject").expect("reject array").arr();
    assert!(!cases.is_empty(), "no data reject cases");
    for case in cases {
        let name = case.get("name").unwrap().str();
        let kind = case.get("kind").unwrap().str();
        let value = value_from_json(case.get("value").unwrap());
        let rejected = match kind {
            "int" => read_int(&value).is_err(),
            "bool" => read_bool(&value).is_err(),
            "utf8-text" => read_text(&value).is_err(),
            "list" => read_list(&value).is_err(),
            "map" => read_map(&value).is_err(),
            "set" => read_set(&value).is_err(),
            "decimal" => read_decimal(&value).is_err(),
            "null" => read_null(&value).is_err(),
            other => panic!("reject case {name:?}: unknown kind {other:?} — update this test"),
        };
        assert!(
            rejected,
            "reject case {name:?} (kind {kind}) was not rejected"
        );
    }
}

// ----- (B) local recognition (negative) tests, authored here -----

fn atom(bytes: &[u8]) -> Value {
    Value::atom(bytes.to_vec())
}

fn label_atom(label: &[u8]) -> Value {
    Value::atom(label.to_vec())
}

#[test]
fn read_int_rejects_malformed() {
    // non-tuple
    assert!(read_int(&atom(&[0x00])).is_err());
    // wrong arity (arity 3 with the int label)
    let arity3 = Value::tuple(vec![label_atom(b"int"), atom(&[0x00]), atom(&[0x01])]);
    assert!(read_int(&arity3).is_err());
    // label child is not an atom (a tuple sits in the label slot)
    let non_atom_label = Value::tuple(vec![Value::tuple(Vec::<Value>::new()), atom(&[0x00])]);
    assert_eq!(
        read_int(&non_atom_label),
        Err(DataError::NotRecognized { kind: "int" })
    );
    // payload child is not an atom (a tuple sits in the payload slot)
    let non_atom_payload =
        Value::tuple(vec![label_atom(b"int"), Value::tuple(Vec::<Value>::new())]);
    assert_eq!(
        read_int(&non_atom_payload),
        Err(DataError::NotRecognized { kind: "int" })
    );
    // wrong label (a bool value)
    assert!(read_int(&encode_bool(true)).is_err());
    // empty payload atom
    let empty = Value::tuple(vec![label_atom(b"int"), atom(&[])]);
    assert_eq!(
        read_int(&empty),
        Err(DataError::NonCanonicalPayload { kind: "int" })
    );
    // sign byte 0x02
    let bad_sign = Value::tuple(vec![label_atom(b"int"), atom(&[0x02, 0x01])]);
    assert_eq!(
        read_int(&bad_sign),
        Err(DataError::NonCanonicalPayload { kind: "int" })
    );
    // negative-zero payload [0x01] (sign neg, empty magnitude)
    let neg_zero = Value::tuple(vec![label_atom(b"int"), atom(&[0x01])]);
    assert_eq!(
        read_int(&neg_zero),
        Err(DataError::NonCanonicalPayload { kind: "int" })
    );
    // leading-zero magnitude [0x00, 0x00, 0x01]
    let leading_zero = Value::tuple(vec![label_atom(b"int"), atom(&[0x00, 0x00, 0x01])]);
    assert_eq!(
        read_int(&leading_zero),
        Err(DataError::NonCanonicalPayload { kind: "int" })
    );
}

#[test]
fn read_int_rejects_cross_kind_list() {
    // readInt on a list value rejects (not-recognized).
    let list = encode_list(&[encode_int(1)]);
    assert_eq!(
        read_int(&list),
        Err(DataError::NotRecognized { kind: "int" })
    );
}

#[test]
fn read_bool_rejects_malformed() {
    // wrong label (an int value)
    assert!(read_bool(&encode_int(0)).is_err());
    // empty payload
    let empty = Value::tuple(vec![label_atom(b"bool"), atom(&[])]);
    assert_eq!(
        read_bool(&empty),
        Err(DataError::NonCanonicalPayload { kind: "bool" })
    );
    // payload 0x02
    let two = Value::tuple(vec![label_atom(b"bool"), atom(&[0x02])]);
    assert_eq!(
        read_bool(&two),
        Err(DataError::NonCanonicalPayload { kind: "bool" })
    );
    // 2-byte payload
    let twobyte = Value::tuple(vec![label_atom(b"bool"), atom(&[0x00, 0x00])]);
    assert_eq!(
        read_bool(&twobyte),
        Err(DataError::NonCanonicalPayload { kind: "bool" })
    );
}

#[test]
fn read_text_rejects_and_accepts() {
    // wrong label (an int value)
    assert!(read_text(&encode_int(0)).is_err());
    // invalid UTF-8 payload [0xff]
    let bad_utf8 = Value::tuple(vec![label_atom(b"utf8-text"), atom(&[0xff])]);
    assert_eq!(
        read_text(&bad_utf8),
        Err(DataError::NonCanonicalPayload { kind: "utf8-text" })
    );
    // ACCEPTS the empty string
    let empty = encode_text("");
    assert_eq!(read_text(&empty).unwrap(), "");
}

#[test]
fn read_list_rejects_and_accepts() {
    // bare tuple (two atoms, no "list" label) is NOT a list
    let bare = Value::tuple(vec![atom(&[0x61]), atom(&[0x62])]);
    assert_eq!(
        read_list(&bare),
        Err(DataError::NotRecognized { kind: "list" })
    );
    // non-tuple
    assert_eq!(
        read_list(&atom(&[0x61])),
        Err(DataError::NotRecognized { kind: "list" })
    );
    // arity-0 empty Tuple is not a list (no label)
    let empty_tuple = Value::tuple(Vec::<Value>::new());
    assert_eq!(
        read_list(&empty_tuple),
        Err(DataError::NotRecognized { kind: "list" })
    );
    // ACCEPTS the empty list Tuple(Atom("list")) -> []
    let empty_list = encode_list(&[]);
    assert_eq!(read_list(&empty_list).unwrap(), Vec::<Value>::new());
}

// ----- (C) positive round-trips beyond the vectors -----

#[test]
fn int_round_trips_beyond_vectors() {
    for n in [0i128, 1, -1, 255, 256, -256, i128::MAX, i128::MIN] {
        assert_eq!(read_int(&encode_int(n)).unwrap(), n, "int round-trip {n}");
    }
}

#[test]
fn bool_round_trips() {
    for b in [false, true] {
        assert_eq!(read_bool(&encode_bool(b)).unwrap(), b);
    }
}

#[test]
fn text_round_trips() {
    for s in ["", "hi", "héllo", "日本語", "emoji 🦀 mix"] {
        assert_eq!(
            read_text(&encode_text(s)).unwrap(),
            s,
            "text round-trip {s:?}"
        );
    }
}

#[test]
fn list_round_trips_nested_and_heterogeneous() {
    // heterogeneous: a bare atom, an int embedding, a text embedding
    let hetero = vec![
        Value::atom(vec![0x61]),
        encode_int(1),
        encode_text("hi"),
        encode_bool(true),
    ];
    let list = encode_list(&hetero);
    assert_eq!(read_list(&list).unwrap(), hetero);

    // nested: a list containing the empty list and a list of one byte-atom
    let nested = vec![encode_list(&[]), encode_list(&[Value::atom(vec![0x61])])];
    let list = encode_list(&nested);
    assert_eq!(read_list(&list).unwrap(), nested);

    // empty list
    assert_eq!(read_list(&encode_list(&[])).unwrap(), Vec::<Value>::new());
}

// ----- map: local recognition + round-trip tests, authored here -----

/// An entry tuple `Tuple(key, value)` (arity 2), used to author reject fixtures.
fn entry(key: Value, value: Value) -> Value {
    Value::tuple(vec![key, value])
}

/// A `map` value built directly from already-positioned entry tuples (NOT via
/// `encode_map`), so we can author non-canonical/malformed forms for `read_map`.
fn raw_map(children: Vec<Value>) -> Value {
    let mut items = vec![label_atom(b"map")];
    items.extend(children);
    Value::tuple(items)
}

#[test]
fn map_round_trips_spread() {
    // empty
    assert_eq!(
        read_map(&encode_map(&[]).unwrap()).unwrap(),
        Vec::<(Value, Value)>::new()
    );

    // single
    let single = vec![(encode_int(1), encode_text("hi"))];
    assert_eq!(read_map(&encode_map(&single).unwrap()).unwrap(), single);

    // several heterogeneous keys, incl. a nested map VALUE and a map-as-KEY.
    let several = vec![
        (Value::atom(vec![0x61]), encode_bool(true)),
        (encode_int(1), encode_list(&[encode_int(2)])),
        // a map used as a value
        (
            encode_text("k"),
            encode_map(&[(Value::atom(vec![0x6b]), encode_map(&[]).unwrap())]).unwrap(),
        ),
        // a map used as a key
        (
            encode_map(&[(Value::atom(vec![0x61]), encode_int(1))]).unwrap(),
            encode_bool(false),
        ),
    ];
    let m = encode_map(&several).unwrap();
    // round-trips exactly, and the read-back entries re-encode to the same value.
    let read_back = read_map(&m).unwrap();
    assert_eq!(encode_map(&read_back).unwrap(), m, "map round-trip");
    // sorting is real: a reversed input still produces the identical canonical map.
    let mut rev = several.clone();
    rev.reverse();
    assert_eq!(encode_map(&rev).unwrap(), m, "encode_map sorts");
}

#[test]
fn map_accepts_noncanonical_int_key_no_recursion() {
    // A key shaped like a NON-canonical int (leading-zero magnitude 00 00 01) is a
    // perfectly good KEY — read_map does NOT recurse into key canonicality (§5.7).
    let noncanon_int_key = Value::tuple(vec![label_atom(b"int"), atom(&[0x00, 0x00, 0x01])]);
    // sanity: it really is rejected as an int
    assert!(read_int(&noncanon_int_key).is_err());

    let entries = vec![(noncanon_int_key.clone(), atom(&[0x00]))];
    let m = encode_map(&entries).unwrap();
    assert_eq!(
        read_map(&m).unwrap(),
        entries,
        "non-canonical-int key accepted"
    );
}

#[test]
fn encode_map_rejects_duplicate_keys() {
    // Two entries with the SAME key (equal encodings) — encode_map must fail rather
    // than pick a winner.
    let dup = vec![
        (Value::atom(vec![0x61]), encode_int(0)),
        (Value::atom(vec![0x61]), encode_int(1)),
    ];
    assert_eq!(encode_map(&dup), Err(DataError::DuplicateKey));

    // also with structurally-equal embedding keys
    let dup2 = vec![
        (encode_int(7), encode_bool(true)),
        (encode_int(7), encode_bool(false)),
    ];
    assert_eq!(encode_map(&dup2), Err(DataError::DuplicateKey));
}

#[test]
fn read_map_rejects_malformed_and_unsorted() {
    // unsorted: 0x62 before 0x61 (encode(0x62) > encode(0x61))
    let unsorted = raw_map(vec![
        entry(atom(&[0x62]), atom(&[0x00])),
        entry(atom(&[0x61]), atom(&[0x00])),
    ]);
    assert_eq!(read_map(&unsorted), Err(DataError::UnsortedEntries));

    // duplicate key 0x61
    let duplicate = raw_map(vec![
        entry(atom(&[0x61]), atom(&[0x00])),
        entry(atom(&[0x61]), atom(&[0x01])),
    ]);
    assert_eq!(read_map(&duplicate), Err(DataError::DuplicateKey));

    // arity-3 entry
    let arity3 = raw_map(vec![Value::tuple(vec![
        atom(&[0x61]),
        atom(&[0x00]),
        atom(&[0x01]),
    ])]);
    assert_eq!(read_map(&arity3), Err(DataError::MalformedEntry));

    // arity-1 entry
    let arity1 = raw_map(vec![Value::tuple(vec![atom(&[0x61])])]);
    assert_eq!(read_map(&arity1), Err(DataError::MalformedEntry));

    // flat (non-tuple child): a bare atom sits where an entry tuple is required
    let flat = raw_map(vec![atom(&[0x61]), atom(&[0x00])]);
    assert_eq!(read_map(&flat), Err(DataError::MalformedEntry));

    // unlabeled: first child is an entry tuple, not Atom("map")
    let unlabeled = Value::tuple(vec![entry(atom(&[0x61]), atom(&[0x00]))]);
    assert_eq!(
        read_map(&unlabeled),
        Err(DataError::NotRecognized { kind: "map" })
    );

    // arity-0 empty tuple is not a map (no label)
    let empty_tuple = Value::tuple(Vec::<Value>::new());
    assert_eq!(
        read_map(&empty_tuple),
        Err(DataError::NotRecognized { kind: "map" })
    );

    // bare atom (even the bytes of "map") is not a map
    assert_eq!(
        read_map(&atom(b"map")),
        Err(DataError::NotRecognized { kind: "map" })
    );

    // cross-kind: a well-formed list read as a map
    let list = encode_list(&[atom(&[0x61])]);
    assert_eq!(
        read_map(&list),
        Err(DataError::NotRecognized { kind: "map" })
    );
}

#[test]
fn read_map_accepts_empty_and_is_distinct_from_empty_list() {
    let empty_map = encode_map(&[]).unwrap();
    assert_eq!(read_map(&empty_map).unwrap(), Vec::<(Value, Value)>::new());
    // empty map != empty list at L0
    assert_ne!(empty_map, encode_list(&[]));
}

// ----- set: local recognition + round-trip tests, authored here -----

/// A `set` value built directly from already-positioned element values (NOT via
/// `encode_set`), so we can author non-canonical/malformed forms for `read_set`.
fn raw_set(children: Vec<Value>) -> Value {
    let mut items = vec![label_atom(b"set")];
    items.extend(children);
    Value::tuple(items)
}

#[test]
fn set_round_trips_spread() {
    // empty
    assert_eq!(
        read_set(&encode_set(&[]).unwrap()).unwrap(),
        Vec::<Value>::new()
    );

    // single
    let single = vec![encode_int(1)];
    assert_eq!(read_set(&encode_set(&single).unwrap()).unwrap(), single);

    // several heterogeneous elements, incl. a nested set element.
    let several = vec![
        Value::atom(vec![0x61]),
        encode_int(1),
        encode_text("hi"),
        encode_bool(true),
        // a set used as an element (set-of-sets)
        encode_set(&[Value::atom(vec![0x61]), encode_int(2)]).unwrap(),
    ];
    let s = encode_set(&several).unwrap();
    // round-trips exactly, and the read-back elements re-encode to the same value.
    let read_back = read_set(&s).unwrap();
    assert_eq!(encode_set(&read_back).unwrap(), s, "set round-trip");
    // sorting is real: a reversed input still produces the identical canonical set.
    let mut rev = several.clone();
    rev.reverse();
    assert_eq!(encode_set(&rev).unwrap(), s, "encode_set sorts");
}

#[test]
fn set_accepts_noncanonical_int_elem_no_recursion() {
    // An element shaped like a NON-canonical int (leading-zero magnitude 00 00 01) is a
    // perfectly good ELEMENT — read_set does NOT recurse into element canonicality (§5.8).
    let noncanon_int = Value::tuple(vec![label_atom(b"int"), atom(&[0x00, 0x00, 0x01])]);
    // sanity: it really is rejected as an int
    assert!(read_int(&noncanon_int).is_err());

    let elems = vec![noncanon_int.clone()];
    let s = encode_set(&elems).unwrap();
    assert_eq!(
        read_set(&s).unwrap(),
        elems,
        "non-canonical-int element accepted"
    );
}

#[test]
fn encode_set_rejects_duplicate_elements() {
    // Two equal bare-atom elements — encode_set must fail rather than drop one.
    let dup = vec![Value::atom(vec![0x61]), Value::atom(vec![0x61])];
    assert_eq!(encode_set(&dup), Err(DataError::DuplicateElement));

    // also with structurally-equal embedding elements
    let dup2 = vec![encode_int(7), encode_int(7)];
    assert_eq!(encode_set(&dup2), Err(DataError::DuplicateElement));
}

#[test]
fn read_set_rejects_unsorted_duplicate_unlabeled_and_bare() {
    // unsorted: 0x62 before 0x61 (encode(0x62) > encode(0x61))
    let unsorted = raw_set(vec![atom(&[0x62]), atom(&[0x61])]);
    assert_eq!(read_set(&unsorted), Err(DataError::UnsortedElements));

    // duplicate element 0x61
    let duplicate = raw_set(vec![atom(&[0x61]), atom(&[0x61])]);
    assert_eq!(read_set(&duplicate), Err(DataError::DuplicateElement));

    // unlabeled: first child is an element, not Atom("set")
    let unlabeled = Value::tuple(vec![atom(&[0x61]), atom(&[0x62])]);
    assert_eq!(
        read_set(&unlabeled),
        Err(DataError::NotRecognized { kind: "set" })
    );

    // arity-0 empty tuple is not a set (no label)
    let empty_tuple = Value::tuple(Vec::<Value>::new());
    assert_eq!(
        read_set(&empty_tuple),
        Err(DataError::NotRecognized { kind: "set" })
    );

    // bare atom (even the bytes of "set") is not a set
    assert_eq!(
        read_set(&atom(b"set")),
        Err(DataError::NotRecognized { kind: "set" })
    );

    // cross-kind: a well-formed list read as a set
    let list = encode_list(&[atom(&[0x61])]);
    assert_eq!(
        read_set(&list),
        Err(DataError::NotRecognized { kind: "set" })
    );
}

#[test]
fn read_set_accepts_empty_and_is_distinct_from_empty_list_and_map() {
    let empty_set = encode_set(&[]).unwrap();
    assert_eq!(read_set(&empty_set).unwrap(), Vec::<Value>::new());
    // empty set != empty list != empty map at L0
    assert_ne!(empty_set, encode_list(&[]));
    assert_ne!(empty_set, encode_map(&[]).unwrap());
}
