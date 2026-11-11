//! Replays the shared, language-agnostic conformance vectors
//! (`../../vectors/identity.json` and `../../vectors/codec.json`) against this
//! Rust implementation. A self-contained minimal JSON reader is used here so that
//! `ontos-core` and `ontos-codec` stay dependency-free.

use ontos_codec::{
    decode, decode_with_limits, encode, encode_uvarint, measure, DecodeError, DecodeLimitKind,
    DecodeLimits, MeasureBounds, MeasureKind, Measures,
};
use ontos_core::Value;

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
    fn boolean(&self) -> bool {
        match self {
            Json::Bool(b) => *b,
            _ => panic!("expected bool"),
        }
    }
    fn int(&self) -> u64 {
        match self {
            Json::Num(n) => *n as u64,
            _ => panic!("expected number"),
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

// ----- the tests -----

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
    eprintln!("identity: {n} cases OK");
}

#[test]
fn codec_uvarint_vectors() {
    let doc = read_vectors("codec.json");
    for case in doc.get("uvarint").unwrap().arr() {
        let n = case.get("n").unwrap().int();
        let want = case.get("hex").unwrap().str();
        let mut out = Vec::new();
        encode_uvarint(n, &mut out);
        assert_eq!(bytes_to_hex(&out), want, "uvarint({n})");
    }
}

#[test]
fn codec_encode_and_roundtrip_vectors() {
    let doc = read_vectors("codec.json");
    for case in doc.get("encode").unwrap().arr() {
        let name = case.get("name").unwrap().str();
        let value = value_from_json(case.get("value").unwrap());
        let want = case.get("hex").unwrap().str();
        // encode is canonical/deterministic
        assert_eq!(bytes_to_hex(&encode(&value)), want, "encode {name:?}");
        // and decode round-trips
        let decoded = decode(&hex_to_bytes(want)).unwrap();
        assert_eq!(decoded, value, "roundtrip {name:?}");
    }
}

#[test]
fn data_embedding_vectors() {
    // ontos/data (L2) embeddings, pinned as full ontos-codec-v1 encodings of their
    // L0 values — same encode+roundtrip contract as codec.json's encode cases.
    let doc = read_vectors("data.json");
    let mut n = 0;
    for case in doc.get("encode").unwrap().arr() {
        let name = case.get("name").unwrap().str();
        let value = value_from_json(case.get("value").unwrap());
        let want = case.get("hex").unwrap().str();
        assert_eq!(bytes_to_hex(&encode(&value)), want, "data encode {name:?}");
        let decoded = decode(&hex_to_bytes(want)).unwrap();
        assert_eq!(decoded, value, "data roundtrip {name:?}");
        n += 1;
    }
    assert!(n > 0, "no data cases loaded");
}

#[test]
fn codec_reject_vectors() {
    let doc = read_vectors("codec.json");
    for case in doc.get("reject").unwrap().arr() {
        let name = case.get("name").unwrap().str();
        let bytes = hex_to_bytes(case.get("hex").unwrap().str());
        let want_code = case.get("code").unwrap().str();
        match decode(&bytes) {
            Ok(v) => panic!("reject case {name:?} unexpectedly decoded to {v}"),
            Err(e) => assert_eq!(e.code(), want_code, "reject case {name:?}"),
        }
    }
}

// ----- uvarint u64-domain boundary (the cross-core fix; spec §3.1) -----

/// `2^64 - 1`, the maximum canonical uvarint, encodes to exactly the 10-byte
/// shortest form `ffffffffffffffffff01`.
#[test]
fn uvarint_u64_max_encodes_canonically() {
    let mut buf = Vec::new();
    encode_uvarint(u64::MAX, &mut buf);
    assert_eq!(bytes_to_hex(&buf), "ffffffffffffffffff01");
    assert_eq!(buf.len(), 10);
}

/// A uvarint whose value would be `>= 2^64` is rejected as `uvarint_overflow`
/// (never `non_canonical_uvarint` or `limit_exceeded`). Each witness is framed as
/// an atom length behind tag `0x00`, so the decoder reads it as a uvarint.
#[test]
fn uvarint_ge_2_64_is_overflow() {
    let witnesses = [
        // 11-byte LEB128 reaching the 2^64 boundary (the shared >=2^64 vector).
        "008080808080808080808001",
        // 11 continuation bytes, no terminator: shift passes the 64-bit ceiling.
        "008080808080808080808080",
        // 11-byte all-ones uvarint (any 11-byte uvarint encodes >= 2^64).
        "00ffffffffffffffffffff01",
        // 10 bytes whose 10th byte value bits (0x7f) exceed the single bit that
        // fits below 2^64.
        "00ffffffffffffffffff7f",
    ];
    for w in witnesses {
        let bytes = hex_to_bytes(w);
        assert_eq!(
            decode(&bytes).unwrap_err().code(),
            "uvarint_overflow",
            "witness {w}"
        );
    }
}

/// On 32-bit targets a *valid* `u64` that exceeds `usize::MAX` must be
/// `limit_exceeded` (a resource-limit class), NOT `uvarint_overflow`. On 64-bit
/// targets `usize == u64`, so no such boundary exists and this test is gated out.
#[cfg(target_pointer_width = "32")]
#[test]
fn valid_u64_over_usize_is_limit_exceeded() {
    // 2^32 = 4294967296: a valid u64, but > usize::MAX on 32-bit. Framed as an
    // atom length behind tag 0x00.
    let mut uvarint = Vec::new();
    encode_uvarint(1u64 << 32, &mut uvarint);
    let mut framed = vec![0x00u8];
    framed.extend_from_slice(&uvarint);
    assert_eq!(decode(&framed).unwrap_err().code(), "limit_exceeded");
}

// ----- operational limit reporting (ontos-codec.md §4.2, ontos-internal#352) -----

/// An atom tag followed by a declared byte length and no bytes.
fn atom_of_length(length: u64) -> Vec<u8> {
    let mut framed = vec![0x00u8];
    encode_uvarint(length, &mut framed);
    framed
}

/// A case's limits: `DecodeLimits::default()` with its explicit bounds applied.
fn limits_of(name: &str, case: &Json) -> DecodeLimits {
    let mut limits = DecodeLimits::default();
    let Json::Obj(set) = case.get("limits").unwrap() else {
        panic!("{name}: limits is not an object");
    };
    for (key, bound) in set {
        let bound = bound.int() as usize;
        match key.as_str() {
            "maxDepth" => limits.max_depth = bound,
            "maxAtomBytes" => limits.max_atom_bytes = bound,
            "maxTupleArity" => limits.max_tuple_arity = bound,
            other => panic!("{name}: unknown limit {other}"),
        }
    }
    limits
}

/// A case's expectation: acceptance, or a rejection's code and kind.
enum Expect<'a> {
    Accept,
    Reject { code: &'a str, kind: &'a str },
}

fn expect_of<'a>(name: &str, expect: &'a Json) -> Expect<'a> {
    if let Json::Str(accept) = expect {
        assert_eq!(accept, "accept", "{name}: unknown expectation");
        return Expect::Accept;
    }
    Expect::Reject {
        code: expect.get("code").unwrap().str(),
        kind: expect.get("limitKind").unwrap().str(),
    }
}

/// Decodes `bytes` under `limits` and requires `expect`: acceptance of a value that
/// re-encodes to the same bytes, or a rejection with exactly the expected code and kind.
/// Anything else (another error, a missing kind, a different datum) fails. Returns the
/// outcome's label, `accept` or the kind.
fn judge_limit(name: &str, bytes: &[u8], limits: DecodeLimits, expect: &Expect) -> String {
    match (decode_with_limits(bytes, limits), expect) {
        (Ok(value), Expect::Accept) => {
            assert_eq!(encode(&value), bytes, "{name}: accepted a different datum");
            "accept".to_string()
        }
        (Err(e), Expect::Accept) => panic!("{name}: expected accept, got {e}"),
        (Ok(_), Expect::Reject { kind, .. }) => panic!("{name}: expected {kind}, got accept"),
        (Err(e), Expect::Reject { code, kind }) => {
            assert_eq!(e.code(), *code, "{name}: {e}");
            assert_eq!(
                e.limit_kind().map(DecodeLimitKind::as_str),
                Some(*kind),
                "{name}: {e}"
            );
            kind.to_string()
        }
    }
}

/// Replays `vectors/codec-limits.json`. A bound absent from a case's `limits` keeps
/// its `DecodeLimits::default()` value.
#[test]
fn codec_limit_vectors() {
    let doc = read_vectors("codec-limits.json");
    let cases = doc.get("cases").unwrap().arr();
    assert!(!cases.is_empty());
    for case in cases {
        let name = case.get("name").unwrap().str();
        let bytes = hex_to_bytes(case.get("hex").unwrap().str());
        let expect = expect_of(name, case.get("expect").unwrap());
        judge_limit(name, &bytes, limits_of(name, case), &expect);
    }
}

// ----- the generated limit-policy tests (Bitspark/ontos#13, docs/design/0009) -----

/// The committed `vectors/codec-limits.generated.json`, or the corpus that
/// `ONTOS_LIMIT_POLICY_CORPUS` names, which is how `scripts/check.sh fuzz` replays a fresh
/// seed. (wasmtime passes no environment, so the wasm32 leg reads the committed one.)
fn read_policy_corpus() -> (String, Json) {
    match std::env::var("ONTOS_LIMIT_POLICY_CORPUS") {
        Ok(path) if !path.is_empty() => {
            let text =
                std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
            let doc = P::new(&text).value();
            (path, doc)
        }
        _ => (
            "vectors/codec-limits.generated.json".to_string(),
            read_vectors("codec-limits.generated.json"),
        ),
    }
}

/// What a value needs from each bound: its depth (the root at 0), its longest atom and
/// its widest tuple, walked with an explicit stack.
#[derive(Clone, Copy)]
struct Needs {
    depth: usize,
    atom: usize,
    arity: usize,
}

fn needs_of(value: &Value) -> Needs {
    let mut needs = Needs {
        depth: 0,
        atom: 0,
        arity: 0,
    };
    let mut stack = vec![(value, 0usize)];
    while let Some((v, depth)) = stack.pop() {
        needs.depth = needs.depth.max(depth);
        match v {
            Value::Atom(atom) => needs.atom = needs.atom.max(atom.len()),
            Value::Tuple(tuple) => {
                needs.arity = needs.arity.max(tuple.len());
                stack.extend(tuple.items().iter().map(|item| (item, depth + 1)));
            }
        }
    }
    needs
}

/// The zone's three bounds: (key, kind, the need it is set against, its field).
type PolicyBound = (
    &'static str,
    DecodeLimitKind,
    fn(Needs) -> usize,
    fn(&mut DecodeLimits) -> &mut usize,
);

const POLICY_BOUNDS: [PolicyBound; 3] = [
    (
        "maxDepth",
        DecodeLimitKind::DecodeDepth,
        |n| n.depth,
        |l| &mut l.max_depth,
    ),
    (
        "maxAtomBytes",
        DecodeLimitKind::AtomBytes,
        |n| n.atom,
        |l| &mut l.max_atom_bytes,
    ),
    (
        "maxTupleArity",
        DecodeLimitKind::TupleArity,
        |n| n.arity,
        |l| &mut l.max_tuple_arity,
    ),
];

/// Every outcome at zero, so an outcome never seen still shows.
fn new_tally() -> Vec<(String, usize)> {
    let mut seen = vec![("accept".to_string(), 0)];
    seen.extend(POLICY_BOUNDS.iter().map(|b| (b.1.as_str().to_string(), 0)));
    seen
}

fn count(seen: &mut [(String, usize)], outcome: &str) {
    let slot = seen.iter_mut().find(|(k, _)| k == outcome);
    slot.unwrap_or_else(|| panic!("an outcome outside the zone: {outcome}"))
        .1 += 1;
}

fn show(seen: &[(String, usize)]) -> String {
    let parts: Vec<String> = seen.iter().map(|(k, n)| format!("{k} {n}")).collect();
    parts.join(", ")
}

/// Inside the agreement zone (a small valid encoding, one bound lowered, every other bound
/// absent or at least the value's need) each case has one outcome, and every face must
/// produce it.
#[test]
fn limit_policy_differential() {
    let (path, doc) = read_policy_corpus();
    let cases = doc.get("differential").unwrap().arr();
    let declared = doc
        .get("counts")
        .unwrap()
        .get("differential")
        .unwrap()
        .int();
    assert_eq!(
        cases.len() as u64,
        declared,
        "the corpus's differential count"
    );
    let mut seen = new_tally();
    for case in cases {
        let name = case.get("name").unwrap().str();
        let bytes = hex_to_bytes(case.get("hex").unwrap().str());
        let expect = expect_of(name, case.get("expect").unwrap());
        count(
            &mut seen,
            &judge_limit(name, &bytes, limits_of(name, case), &expect),
        );
    }
    for (outcome, n) in &seen {
        assert!(*n > 0, "no differential case expects {outcome}");
    }
    println!(
        "rs differential ({}-bit usize): {} cases judged ({}); {path} seed {}",
        usize::BITS,
        cases.len(),
        show(&seen),
        doc.get("seed").unwrap().str()
    );
}

/// A value the defaults accept is accepted with every bound at exactly its need, and
/// lowering one bound below its need (to need - 1 and to 0, the others at their defaults
/// or at their needs) names that bound.
#[test]
fn limit_policy_metamorphic() {
    let (path, doc) = read_policy_corpus();
    let values = doc.get("metamorphic").unwrap().arr();
    let declared = doc.get("counts").unwrap().get("metamorphic").unwrap().int();
    assert_eq!(
        values.len() as u64,
        declared,
        "the corpus's metamorphic count"
    );
    let mut seen = new_tally();
    for entry in values {
        let name = entry.get("name").unwrap().str();
        let bytes = hex_to_bytes(entry.get("hex").unwrap().str());
        // The precondition, observed here rather than assumed: the defaults accept it.
        let defaults = DecodeLimits::default();
        let label = judge_limit(
            &format!("{name} under the defaults"),
            &bytes,
            defaults,
            &Expect::Accept,
        );
        count(&mut seen, &label);
        let needs = needs_of(&decode(&bytes).unwrap());
        let tight = DecodeLimits {
            max_depth: needs.depth,
            max_atom_bytes: needs.atom,
            max_tuple_arity: needs.arity,
        };
        let label = judge_limit(
            &format!("{name} at its needs"),
            &bytes,
            tight,
            &Expect::Accept,
        );
        count(&mut seen, &label);
        for (key, kind, need_of, field) in POLICY_BOUNDS {
            let need = need_of(needs);
            if need == 0 {
                continue; // nothing to lower below
            }
            let lowered: &[usize] = if need > 1 { &[need - 1, 0] } else { &[0] };
            for &l in lowered {
                for (base_label, base) in [("defaults", defaults), ("needs", tight)] {
                    let mut limits = base;
                    *field(&mut limits) = l;
                    let case = format!("{name}: {key}={l} < {need}, others at {base_label}");
                    let expect = Expect::Reject {
                        code: "limit_exceeded",
                        kind: kind.as_str(),
                    };
                    count(&mut seen, &judge_limit(&case, &bytes, limits, &expect));
                }
            }
        }
    }
    for (outcome, n) in &seen {
        assert!(*n > 0, "the metamorphic relation never produced {outcome}");
    }
    let decodes: usize = seen.iter().map(|(_, n)| n).sum();
    println!(
        "rs metamorphic ({}-bit usize): {} values, {decodes} decodes judged ({}); {path} seed {}",
        usize::BITS,
        values.len(),
        show(&seen),
        doc.get("seed").unwrap().str()
    );
}

/// A kind belongs to `limit_exceeded` only.
#[test]
fn byte_contract_rejects_carry_no_limit_kind() {
    let doc = read_vectors("codec.json");
    for case in doc.get("reject").unwrap().arr() {
        let name = case.get("name").unwrap().str();
        let err = decode(&hex_to_bytes(case.get("hex").unwrap().str())).expect_err(name);
        assert_eq!(err.limit_kind(), None, "{name} ({})", err.code());
    }
}

/// The worked collision of §4.2: with an atom bound of 10, a declared 2^60-byte atom is
/// `atom_bytes` where `usize` holds 2^60 and `native_width` where it does not.
#[test]
fn the_worked_collision_depends_on_the_target() {
    let limits = DecodeLimits {
        max_atom_bytes: 10,
        ..DecodeLimits::default()
    };
    let err = decode_with_limits(&atom_of_length(1 << 60), limits).unwrap_err();
    let want = if cfg!(target_pointer_width = "64") {
        DecodeLimitKind::AtomBytes
    } else {
        DecodeLimitKind::NativeWidth
    };
    assert_eq!(
        (err.code(), err.limit_kind()),
        ("limit_exceeded", Some(want))
    );
}

/// On 64-bit, `usize` holds every `u64`, so the largest valid length fails as
/// truncation and no `native_width` exists.
#[cfg(target_pointer_width = "64")]
#[test]
fn native_width_is_absent_on_64_bit() {
    let err = decode(&atom_of_length(u64::MAX)).unwrap_err();
    assert_eq!((err.code(), err.limit_kind()), ("unexpected_eof", None));
}

/// On 32-bit (wasm32, logos's guest target) a valid length one past `usize::MAX` is
/// `native_width`, under its unchanged label; `usize::MAX` itself fits.
#[cfg(target_pointer_width = "32")]
#[test]
fn native_width_on_32_bit() {
    let err = decode(&atom_of_length(1u64 << 32)).unwrap_err();
    assert_eq!(
        (err.code(), err.limit_kind()),
        ("limit_exceeded", Some(DecodeLimitKind::NativeWidth))
    );
    assert!(matches!(
        err,
        DecodeError::LimitExceeded {
            limit: "atom byte length",
            ..
        }
    ));
    let tuple = decode(&[0x01, 0x80, 0x80, 0x80, 0x80, 0x10]).unwrap_err();
    assert_eq!(tuple.limit_kind(), Some(DecodeLimitKind::NativeWidth));
    let fits = decode(&atom_of_length(u32::MAX as u64)).unwrap_err();
    assert_eq!((fits.code(), fits.limit_kind()), ("unexpected_eof", None));
}

/// What ontos-internal#352 promised to keep: the variant, its three labels and numbers, `code()`,
/// `Display`, and exhaustive matching and destructuring of `DecodeError`.
#[test]
fn compatibility_of_decode_error() {
    let limits = DecodeLimits {
        max_depth: 0,
        ..DecodeLimits::default()
    };
    let err = decode_with_limits(&[0x01, 0x01, 0x00, 0x00], limits).unwrap_err();
    assert_eq!(
        err,
        DecodeError::LimitExceeded {
            limit: "decode depth",
            value: 1,
            max: 0
        }
    );
    assert_eq!(err.code(), "limit_exceeded");
    assert_eq!(err.to_string(), "decode depth value 1 exceeds maximum 0");

    // DecodeError gained no variant, so this match stays exhaustive without a wildcard.
    let label = match &err {
        DecodeError::UnexpectedEof
        | DecodeError::TrailingBytes { .. }
        | DecodeError::UnknownTag { .. }
        | DecodeError::NonCanonicalUvarint { .. }
        | DecodeError::UvarintOverflow { .. } => None,
        DecodeError::LimitExceeded {
            limit,
            value: _,
            max: _,
        } => Some(*limit),
    };
    assert_eq!(label, Some("decode depth"));

    // A LimitExceeded built elsewhere with a label this decoder never writes has no kind.
    let foreign = DecodeError::LimitExceeded {
        limit: "frame size",
        value: 2,
        max: 1,
    };
    assert_eq!(
        (foreign.code(), foreign.limit_kind()),
        ("limit_exceeded", None)
    );
    assert_eq!(DecodeLimitKind::TupleArity.to_string(), "tuple_arity");
}

/// Builds a `codec-measure.json` node table by copying: a Rust value owns its children, so
/// an index named twice becomes two equal subtrees. Only `expandable` cases are small enough.
fn measure_value_from_table(table: &Json) -> Value {
    let mut built: Vec<Value> = Vec::new();
    for (i, node) in table.get("nodes").unwrap().arr().iter().enumerate() {
        if let Some(a) = node.get("atom") {
            built.push(Value::atom(hex_to_bytes(a.str())));
        } else {
            let items: Vec<Value> = node
                .get("tuple")
                .unwrap()
                .arr()
                .iter()
                .map(|r| {
                    let r = r.int() as usize;
                    assert!(r < i, "node {i} names {r}, which is not an earlier node");
                    built[r].clone()
                })
                .collect();
            built.push(Value::tuple(items));
        }
    }
    built.swap_remove(table.get("root").unwrap().int() as usize)
}

/// Replays `vectors/codec-measure.json`: every case marked `expandable`, the ones whose
/// expanded tree a face without sharing can build (record 0008 §7).
#[test]
fn codec_measure_vectors() {
    let doc = read_vectors("codec-measure.json");
    let cases = doc.get("cases").unwrap().arr();
    assert_eq!(cases.len() as u64, doc.get("count").unwrap().int());
    let mut replayed = 0;
    for case in cases {
        let name = case.get("name").unwrap().str();
        if !case.get("expandable").unwrap().boolean() {
            continue;
        }
        replayed += 1;
        let value = measure_value_from_table(case.get("value").unwrap());
        let b = case.get("bounds").unwrap();
        let bounds = MeasureBounds {
            max_encoded_bytes: b.get("encoded_bytes").unwrap().int(),
            max_occurrences: b.get("occurrences").unwrap().int(),
            max_height: b.get("height").unwrap().int(),
        };
        let expect = case.get("expect").unwrap();
        if let Some(want) = expect.get("measures") {
            let want = Measures {
                encoded_bytes: want.get("encoded_bytes").unwrap().int(),
                occurrences: want.get("occurrences").unwrap().int(),
                height: want.get("height").unwrap().int(),
            };
            assert_eq!(measure(&value, bounds), Ok(want), "{name}");
            assert_eq!(encode(&value).len() as u64, want.encoded_bytes, "{name}");
        } else {
            let want: Vec<&str> = expect
                .get("exceeded")
                .unwrap()
                .arr()
                .iter()
                .map(Json::str)
                .collect();
            assert!(!want.is_empty(), "{name}: expects nothing");
            let err = measure(&value, bounds).expect_err(name);
            let got: Vec<&str> = err.exceeded().iter().map(|k| k.as_str()).collect();
            assert_eq!(got, want, "{name}");
        }
    }
    assert!(replayed >= 20, "only {replayed} expandable cases");
}

/// The identifiers are the spec's, and an over-limit error lists them in ascending order.
#[test]
fn measure_kind_identifiers() {
    assert_eq!(MeasureKind::EncodedBytes.as_str(), "encoded_bytes");
    assert_eq!(MeasureKind::Height.as_str(), "height");
    assert_eq!(MeasureKind::Occurrences.as_str(), "occurrences");
    let zero = MeasureBounds {
        max_encoded_bytes: 0,
        max_occurrences: 0,
        max_height: 0,
    };
    let deep = Value::tuple([Value::atom(vec![0])]);
    let err = measure(&deep, zero).unwrap_err();
    let got: Vec<&str> = err.exceeded().iter().map(|k| k.as_str()).collect();
    let mut sorted = got.clone();
    sorted.sort_unstable();
    assert_eq!(got, sorted);
    assert_eq!(got, ["encoded_bytes", "height", "occurrences"]);
}
