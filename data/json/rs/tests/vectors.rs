//! The cross-impl lock: `vectors/data-json.json` is the frozen byte-contract for
//! ontos-data-json/1. These tests project each valid doc with `project` and assert
//! the resulting bytes against the locked digests — the inner ontos-codec-v1 digest
//! of the projected value, and the era-2 domain-separated digest of the structural
//! wrap `Tuple(Atom(tag), value)`. Reject cases assert the path-named rejection
//! verbatim. Drift here is a real cross-language conformance break.
//!
//! This mirrors `data/json/go/datajson_test.go` and `data/json/ts/test/vectors.test.ts`
//! case-for-case, deliberately: the three faces are peers, so their suites should
//! fail on the same inputs. The one mirrored-but-divergent corner is the defective
//! object KEY's path (representation-bound: Go WTF-8 / TS lone code unit / Rust
//! lossy) — reasons stay exact, paths there are unpinnable.
//!
//! Two self-contained helpers keep the workspace dependency-free:
//! - a minimal JSON parser that keeps number literals VERBATIM (a `f64` round-trip
//!   would corrupt the corpus's 2^127 integer — the exact literal-destruction this
//!   profile exists to refuse), plus a serializer emitting those literals back, so
//!   a valid case's `doc` re-serializes losslessly at any magnitude;
//! - a SHA-256 (FIPS 180-4). It is self-checking here: all six pinned valid-case
//!   digests (cross-verified by the Go and TS suites) must reproduce, so a defect
//!   in the hash cannot pass silently.

use ontos_codec::encode as codec_encode;
use ontos_core::Value;
use ontos_data::{
    encode_bool, encode_int, encode_int_bytes, encode_list, encode_map, encode_null, encode_text,
};
use ontos_data_json::{
    era2_preimage, project, project_with, DuplicateKeys, Options, ProjectionError, MAX_DEPTH,
};

// ----- tiny JSON parser (test-only; literal-preserving) -----

#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    /// A number kept as its raw source literal.
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn str(&self, key: &str) -> &str {
        match self.get(key) {
            Some(Json::Str(s)) => s,
            other => panic!("expected string at {key:?}, got {other:?}"),
        }
    }
    fn arr(&self, key: &str) -> &[Json] {
        match self.get(key) {
            Some(Json::Arr(v)) => v,
            other => panic!("expected array at {key:?}, got {other:?}"),
        }
    }
}

struct P<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> P<'a> {
    fn new(s: &'a [u8]) -> Self {
        P { b: s, i: 0 }
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
            b'[' => self.array(),
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
        self.i += 1;
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
            assert_eq!(self.b[self.i], b':');
            self.i += 1;
            let v = self.value();
            out.push((k, v));
            self.ws();
            match self.b[self.i] {
                b',' => self.i += 1,
                b'}' => {
                    self.i += 1;
                    return Json::Obj(out);
                }
                c => panic!("bad object at {}: {}", self.i, c as char),
            }
        }
    }
    fn array(&mut self) -> Json {
        self.i += 1;
        let mut out = Vec::new();
        self.ws();
        if self.b[self.i] == b']' {
            self.i += 1;
            return Json::Arr(out);
        }
        loop {
            out.push(self.value());
            self.ws();
            match self.b[self.i] {
                b',' => self.i += 1,
                b']' => {
                    self.i += 1;
                    return Json::Arr(out);
                }
                c => panic!("bad array at {}: {}", self.i, c as char),
            }
        }
    }
    fn string(&mut self) -> String {
        assert_eq!(self.b[self.i], b'"');
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            match self.b[self.i] {
                b'"' => {
                    self.i += 1;
                    return String::from_utf8(out).expect("vector file strings are UTF-8");
                }
                b'\\' => {
                    self.i += 1;
                    match self.b[self.i] {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'n' => out.push(b'\n'),
                        b't' => out.push(b'\t'),
                        b'r' => out.push(b'\r'),
                        b'b' => out.push(0x08),
                        b'f' => out.push(0x0C),
                        b'u' => {
                            let hex = std::str::from_utf8(&self.b[self.i + 1..self.i + 5]).unwrap();
                            let cu = u32::from_str_radix(hex, 16).unwrap();
                            self.i += 4;
                            // The vector FILE itself never carries escaped lone
                            // surrogates (docSource escapes them behind a literal
                            // backslash), so a plain BMP decode suffices here.
                            let ch = char::from_u32(cu)
                                .expect("vector file \\u escapes are non-surrogate BMP");
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                        }
                        c => panic!("unsupported escape \\{}", c as char),
                    }
                    self.i += 1;
                }
                c => {
                    out.push(c);
                    self.i += 1;
                }
            }
        }
    }
    fn num(&mut self) -> Json {
        let start = self.i;
        if self.b[self.i] == b'-' {
            self.i += 1;
        }
        while self.i < self.b.len()
            && matches!(
                self.b[self.i],
                b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-'
            )
        {
            self.i += 1;
        }
        Json::Num(String::from_utf8(self.b[start..self.i].to_vec()).unwrap())
    }
}

/// Serializes a parsed tree back to JSON source, emitting number literals
/// verbatim — the lossless round-trip the corpus's arbitrary-precision integers
/// require (the TS suite guards the same seam with a 2^53 check; keeping the
/// literal makes the guard unnecessary here).
fn serialize(j: &Json, out: &mut String) {
    match j {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Num(lit) => out.push_str(lit),
        Json::Str(s) => {
            out.push('"');
            for ch in s.chars() {
                match ch {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\t' => out.push_str("\\t"),
                    '\r' => out.push_str("\\r"),
                    c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out.push('"');
        }
        Json::Arr(elems) => {
            out.push('[');
            for (i, e) in elems.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                serialize(e, out);
            }
            out.push(']');
        }
        Json::Obj(entries) => {
            out.push('{');
            for (i, (k, v)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                serialize(&Json::Str(k.clone()), out);
                out.push(':');
                serialize(v, out);
            }
            out.push('}');
        }
    }
}

// ----- SHA-256 (test-only, FIPS 180-4; self-checked against the pinned digests) -----

fn sha256(data: &[u8]) -> [u8; 32] {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    let mut w = [0u32; 64];
    // as_chunks over chunks_exact: the 64 is a compile-time constant, so each block
    // arrives as &[u8; 64] and the length is checked by the type rather than asserted at
    // runtime. msg is padded to a multiple of 64 above, so the remainder half is empty.
    for chunk in msg.as_chunks::<64>().0 {
        for (t, word) in w.iter_mut().take(16).enumerate() {
            *word = u32::from_be_bytes([
                chunk[4 * t],
                chunk[4 * t + 1],
                chunk[4 * t + 2],
                chunk[4 * t + 3],
            ]);
        }
        for t in 16..64 {
            let s0 = w[t - 15].rotate_right(7) ^ w[t - 15].rotate_right(18) ^ (w[t - 15] >> 3);
            let s1 = w[t - 2].rotate_right(17) ^ w[t - 2].rotate_right(19) ^ (w[t - 2] >> 10);
            w[t] = w[t - 16]
                .wrapping_add(s0)
                .wrapping_add(w[t - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for t in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[t])
                .wrapping_add(w[t]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ----- the lock -----

fn load_vectors() -> Json {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../vectors/data-json.json"
    );
    let raw = std::fs::read(path).expect("read vectors/data-json.json");
    let vf = P::new(&raw).value();
    assert!(
        !vf.arr("valid").is_empty() && !vf.arr("reject").is_empty(),
        "empty vector file"
    );
    vf
}

#[test]
fn vectors_valid_documents_project_to_the_locked_digests() {
    for case in load_vectors().arr("valid") {
        let value = case.get("value").expect("case value");
        let key = value.str("corpusKey");

        let mut src = String::new();
        serialize(value.get("doc").expect("doc"), &mut src);
        let v = project(src.as_bytes()).unwrap_or_else(|e| panic!("{key}: project: {e}"));

        // (b) inner ontos-codec-v1 digest of the projected value.
        let inner = hex(&sha256(&codec_encode(&v)));
        assert_eq!(
            inner,
            value.get("expect").unwrap().str("codecSha256"),
            "{key}: inner codecSha256"
        );

        // (c) era-2 domain-separated digest: SHA-256(encode(Tuple(Atom(tag), value))).
        let era2 = value.get("expect").unwrap().get("era2").expect("era2");
        let tag = era2.str("tag");
        assert_eq!(
            hex(tag.as_bytes()),
            era2.str("tagAtomBytesHex"),
            "{key}: era-2 tag atom bytes"
        );
        let digest = hex(&sha256(&codec_encode(&era2_preimage(tag, v))));
        let want = era2.str("digest").trim_start_matches("sha256:");
        assert_eq!(digest, want, "{key}: era-2 digest");
    }
}

#[test]
fn vectors_reject_cases_fail_path_named_with_the_pinned_reason() {
    for (i, case) in load_vectors().arr("reject").iter().enumerate() {
        let value = case.get("value").expect("case value");
        let src = value.str("docSource");
        let expect = value.get("expect").unwrap().get("reject").expect("reject");
        let err =
            project(src.as_bytes()).expect_err(&format!("reject{i}: expected rejection for {src}"));
        let ProjectionError::Rejected { path, reason } = err else {
            panic!("reject{i}: expected the Rejected class, got {err:?}");
        };
        assert_eq!(path, expect.str("path"), "reject{i}: path");
        assert_eq!(reason, expect.str("reason"), "reject{i}: reason");
    }
}

// ----- mirrored unit suites -----

fn assert_bytes(input: &str, want: &Value) {
    let v = project(input.as_bytes()).unwrap_or_else(|e| panic!("project({input}): {e}"));
    assert_eq!(
        hex(&codec_encode(&v)),
        hex(&codec_encode(want)),
        "project({input}) bytes"
    );
}

fn assert_reject(input: &[u8], path: &str, reason: &str) {
    let err = project(input).expect_err(&format!(
        "expected rejection for {:?}",
        String::from_utf8_lossy(input)
    ));
    assert_eq!(
        err,
        ProjectionError::Rejected {
            path: path.to_string(),
            reason: reason.to_string()
        }
    );
}

/// Proves each projection arm composes the frozen data primitive rather than
/// re-deriving a byte form — mirrors Go's TestArms plus the escape/fidelity
/// accept-side cases.
#[test]
fn arms_compose_the_frozen_data_primitives_byte_for_byte() {
    let map = |entries: &[(Value, Value)]| encode_map(entries).expect("test map");
    assert_bytes("null", &encode_null());
    assert_bytes("true", &encode_bool(true));
    assert_bytes("false", &encode_bool(false));
    assert_bytes(r#""soil""#, &encode_text("soil"));
    assert_bytes(r#""""#, &encode_text(""));
    assert_bytes("0", &encode_int(0));
    assert_bytes("-0", &encode_int(0));
    assert_bytes("-14", &encode_int(-14));
    // 2^127 — one past i128::MAX, so it must route through the unbounded byte
    // form: sign 0x00, magnitude 0x80 followed by fifteen 0x00.
    let mut big = vec![0x80u8];
    big.extend([0u8; 15]);
    assert_bytes(
        "170141183460469231731687303715884105728",
        &encode_int_bytes(false, &big).expect("2^127"),
    );
    assert_bytes("[]", &encode_list(&[]));
    assert_bytes("{}", &map(&[]));
    assert_bytes(
        r#"{"b":[true,null],"a":"x"}"#,
        &map(&[
            (encode_text("a"), encode_text("x")),
            (
                encode_text("b"),
                encode_list(&[encode_bool(true), encode_null()]),
            ),
        ]),
    );
    // Duplicate keys collapse last-wins, matching the Go and TS peers.
    assert_bytes(
        r#"{"a":1,"a":2}"#,
        &map(&[(encode_text("a"), encode_int(2))]),
    );
    // Escapes decode per RFC 8259.
    assert_bytes(r#""a\n\tb\"\\\/c""#, &encode_text("a\n\tb\"\\/c"));
    assert_bytes(r#""A""#, &encode_text("A"));
    // A PAIRED surrogate escape is one code point and ACCEPTS.
    assert_bytes(r#""😀""#, &encode_text("\u{1F600}"));
    // An AUTHENTIC U+FFFD — escaped or raw in the input — is an ordinary
    // character, not a fidelity defect.
    assert_bytes(r#""�""#, &encode_text("\u{FFFD}"));
    assert_bytes("\"\u{FFFD}\"", &encode_text("\u{FFFD}"));
}

/// The reserved decimal arm rejects by literal FORM, not numeric value — mirrors
/// Go's TestDecimalArmReject.
#[test]
fn reserved_decimal_arm_rejects_by_literal_form_path_named() {
    let reason = |lit: &str| {
        format!(
            "non-integer number literal \"{lit}\" — fraction/exponent rejected under ontos-data-json/1 (reserved decimal arm ungraduated)"
        )
    };
    assert_reject(b"1.5", "$", &reason("1.5"));
    assert_reject(b"1.0", "$", &reason("1.0"));
    assert_reject(b"1e3", "$", &reason("1e3"));
    assert_reject(b"2E2", "$", &reason("2E2"));
    assert_reject(b"[1, 2.5]", "$[1]", &reason("2.5"));
    assert_reject(br#"{"threshold": 3.14}"#, "$.threshold", &reason("3.14"));
}

/// The ontos-data.md §4.1 fidelity law (ontos-internal#216) — mirrors Go's
/// TestUTF8FidelityReject. The index in the reason counts UTF-16 code units.
#[test]
fn utf8_fidelity_unpaired_surrogates_reject_path_named() {
    let reason = |unit: u16, index: usize| {
        format!(
            "unpaired surrogate 0x{unit:04x} at UTF-16 index {index} — the string has no UTF-8 encoding, rejected under ontos-data-json/1 (U+FFFD coercion violates the ontos-data.md §4.1 fidelity law)"
        )
    };
    assert_reject(br#""\ud800""#, "$", &reason(0xd800, 0));
    assert_reject(br#""\udc00""#, "$", &reason(0xdc00, 0));
    assert_reject(br#""\ud800\ud801""#, "$", &reason(0xd800, 0));
    assert_reject(br#"{"note": "x\udfff"}"#, "$.note", &reason(0xdfff, 1));
    assert_reject(br#"["ok", "\ud800abc"]"#, "$[1]", &reason(0xd800, 0));
    // soil- is 5 UTF-16 units, the PAIRED emoji escape combines to one code
    // point of 2 units, the hyphen 1 — so the lone surrogate sits at index 8.
    assert_reject(
        "\"soil-\u{1F600}-\\ud800\"".as_bytes(),
        "$",
        &reason(0xd800, 8),
    );
    // A defective KEY rejects at the member path. The path interpolates the key
    // as this face can hold it (lossy — Rust String cannot carry the WTF-8
    // bytes); the Go peer interpolates WTF-8, the TS peer the lone code unit —
    // representation-bound, unpinnable. The REASON is exact in every face.
    let err = project(br#"{"a\ud800": 1}"#).expect_err("defective key");
    let ProjectionError::Rejected { path, reason: got } = err else {
        panic!("defective key: expected the Rejected class, got {err:?}");
    };
    assert!(path.starts_with("$.a"), "key path: {path}");
    assert_eq!(got, reason(0xd800, 1), "key reason");
}

/// The byte-level form of the same defect: raw invalid UTF-8 inside a string
/// literal (unrepresentable in the JSON-hosted vector file, hence pinned here) —
/// mirrors Go's TestRawInvalidUTF8Reject, wording matched to the Go peer's
/// data-layer refusal so the two byte-input faces fail identically.
#[test]
fn raw_invalid_utf8_rejects_path_named() {
    let reason = "ontos/data: not a well-formed utf8-text: producer: string is not valid UTF-8";
    assert_reject(&[b'"', 0x80, b'"'], "$", reason);
    let mut in_obj: Vec<u8> = br#"{"k": ""#.to_vec();
    in_obj.push(0xFF);
    in_obj.extend_from_slice(br#""}"#);
    assert_reject(&in_obj, "$.k", reason);
    // e2 82 is a 3-byte sequence cut short.
    assert_reject(&[b'"', 0xE2, 0x82, b'"'], "$", reason);
    // A defect AFTER a surrogate is still the surrogate's rejection (first defect
    // wins, in UTF-16 order), and vice versa.
    assert_reject(
        &[b'"', 0xFF, b'\\', b'u', b'd', b'8', b'0', b'0', b'"'],
        "$",
        reason,
    );
}

/// Project reads exactly one document — mirrors Go's TestTrailingDataReject,
/// including `01` (reads as `0` + trailing `1` in all three faces).
#[test]
fn trailing_data_rejects() {
    for input in ["{} {}", "1 2", "true false", "[] junk", "01"] {
        assert_reject(input.as_bytes(), "$", "trailing data after JSON document");
    }
}

/// Mirrors Go's TestEmptyInputReject.
#[test]
fn empty_input_rejects_distinctly() {
    for input in ["", "   ", "\n\t"] {
        assert_reject(
            input.as_bytes(),
            "$",
            "empty input: expected one JSON document",
        );
    }
}

/// Malformed JSON is rejected `$`-rooted through the projection's own reader,
/// never thrown raw and never silently repaired. Only the CLASSIFICATION is
/// asserted (root path + the `invalid JSON: ` prefix): `vectors/data-json.json`
/// pins no syntax-error wording, so the faces are required to agree on WHICH
/// bucket an input falls in, not on the prose. Each input below was checked
/// against the Go and TS peers and lands in this bucket there too.
#[test]
fn malformed_json_rejects_at_the_root() {
    for input in [
        "{",
        "[1,]",
        r#"{"a":}"#,
        r#"{"a" 1}"#,
        r#"{"a":1,}"#,
        "-",
        "1e",
        "1.",
        "+1",
        r#""abc"#,
        r#""\x""#,
        r#""\u12g4""#,
        "\"\x01\"",
        "tru",
        "fals",
        "nul",
    ] {
        let err = project(input.as_bytes())
            .expect_err(&format!("expected syntax rejection for {input:?}"));
        let ProjectionError::Rejected { path, reason } = err else {
            panic!("{input:?}: expected the Rejected class, got {err:?}");
        };
        assert_eq!(path, "$", "{input:?}: path");
        assert!(
            reason.starts_with("invalid JSON: "),
            "{input:?}: reason {reason:?}"
        );
    }
}

/// The resource-limit posture (ontos-internal#236): the spec's floor (512) must be accepted;
/// above this face's ceiling the reader returns the LIMIT class —
/// `ProjectionError::DepthLimit`, deliberately distinct from `Rejected` — fast,
/// instead of overflowing the stack (in Rust, a process abort, before this
/// bound existed). Mirrors Go's TestDepthLimit and the TS depth test.
#[test]
fn nesting_depth_floor_accepts_and_past_ceiling_is_the_limit_class() {
    let deep = |n: usize| format!("{}1{}", "[".repeat(n), "]".repeat(n));
    project(deep(512).as_bytes()).expect("depth 512 (the spec floor) must accept");
    project(deep(MAX_DEPTH).as_bytes()).expect("this face's stated ceiling must accept");
    // Siblings at one level must NOT accumulate depth.
    let siblings = format!("[{}]", vec!["[1]"; 1000].join(","));
    project(siblings.as_bytes()).expect("1000 siblings at depth 2 must accept");
    for n in [MAX_DEPTH + 1, 100_000] {
        let err = project(deep(n).as_bytes()).expect_err("past the ceiling must fail");
        assert_eq!(
            err,
            ProjectionError::DepthLimit { limit: MAX_DEPTH },
            "depth {n}: want the limit class"
        );
    }
    // Deep OBJECTS are bounded by the same counter.
    let deep_obj = format!(
        "{}1{}",
        "{\"a\":".repeat(MAX_DEPTH + 1),
        "}".repeat(MAX_DEPTH + 1)
    );
    let err = project(deep_obj.as_bytes()).expect_err("deep objects past the ceiling must fail");
    assert_eq!(err, ProjectionError::DepthLimit { limit: MAX_DEPTH });
}

// ----- duplicateKeys: reject — the opt-in source-admission policy (ontos-internal#322) -----

const STRICT: Options = Options {
    duplicate_keys: DuplicateKeys::Reject,
};

fn bytes_with(src: &str, opts: Options) -> Vec<u8> {
    let v = project_with(src.as_bytes(), opts)
        .unwrap_or_else(|e| panic!("project_with({src}, {opts:?}): {e}"));
    codec_encode(&v)
}

/// The strict mode refuses each repeat at the pinned member with the pinned key, as
/// the `DuplicateKey` class — never `Rejected` (a /1 domain rejection) and never
/// `DepthLimit`. The default mode accepts the same document and projects it to the
/// bytes of its hand-written last-wins equivalent, which the strict mode also accepts.
#[test]
fn duplicate_keys_vectors_reject_under_strict_and_collapse_last_wins_by_default() {
    let vf = load_vectors();
    let section = vf.get("duplicateKeys").expect("duplicateKeys section");
    let cases = section.arr("reject");
    assert!(!cases.is_empty(), "empty duplicateKeys.reject");
    for (i, case) in cases.iter().enumerate() {
        let value = case.get("value").expect("case value");
        let src = value.str("docSource");
        let expect = value.get("expect").expect("expect");
        let want = expect.get("reject").expect("reject");
        let equivalent = expect.str("lastWinsEquivalent");

        let err = project_with(src.as_bytes(), STRICT)
            .expect_err(&format!("reject{i}: strict must refuse {src}"));
        let ProjectionError::DuplicateKey { path, key } = &err else {
            panic!("reject{i}: expected the DuplicateKey class, got {err:?}");
        };
        assert_eq!(path, want.str("path"), "reject{i}: path");
        assert_eq!(key, want.str("key"), "reject{i}: key");
        assert!(
            err.to_string().contains(path.as_str()),
            "reject{i}: Display carries the path"
        );

        let default = bytes_with(src, Options::default());
        let collapsed = bytes_with(equivalent, Options::default());
        assert_eq!(
            hex(&default),
            hex(&collapsed),
            "reject{i}: default mode is last-wins"
        );
        assert_eq!(
            hex(&bytes_with(equivalent, STRICT)),
            hex(&collapsed),
            "reject{i}: strict accepts the collapsed equivalent identically"
        );
    }
}

/// Duplicate-free documents project byte-identically in both modes.
#[test]
fn duplicate_keys_vectors_accept_identically_in_both_modes() {
    let vf = load_vectors();
    let cases = vf.get("duplicateKeys").expect("section").arr("accept");
    assert!(!cases.is_empty(), "empty duplicateKeys.accept");
    for (i, case) in cases.iter().enumerate() {
        let src = case.get("value").expect("value").str("docSource");
        assert_eq!(
            hex(&bytes_with(src, STRICT)),
            hex(&bytes_with(src, Options::default())),
            "accept{i}: {src}"
        );
    }
}

/// The policy is a stricter admission over the SAME mapping: every locked valid case
/// reproduces its digest through the strict mode and every locked reject case keeps
/// its path-named /1 rejection.
#[test]
fn strict_mode_preserves_every_locked_outcome() {
    let vf = load_vectors();
    for case in vf.arr("valid") {
        let value = case.get("value").expect("case value");
        let key = value.str("corpusKey");
        let mut src = String::new();
        serialize(value.get("doc").expect("doc"), &mut src);
        let v = project_with(src.as_bytes(), STRICT)
            .unwrap_or_else(|e| panic!("{key}: strict project: {e}"));
        assert_eq!(
            hex(&sha256(&codec_encode(&v))),
            value.get("expect").unwrap().str("codecSha256"),
            "{key}: strict inner codecSha256"
        );
    }
    for (i, case) in vf.arr("reject").iter().enumerate() {
        let value = case.get("value").expect("case value");
        let expect = value.get("expect").unwrap().get("reject").expect("reject");
        let err = project_with(value.str("docSource").as_bytes(), STRICT)
            .expect_err(&format!("reject{i}: strict must still reject"));
        assert_eq!(
            err,
            ProjectionError::Rejected {
                path: expect.str("path").to_string(),
                reason: expect.str("reason").to_string()
            },
            "reject{i}: strict keeps the /1 rejection"
        );
    }
}

/// Stage order and class boundaries: the reader refuses a repeat before the walk
/// runs, so a document with both a repeat and a /1 defect is refused for the repeat
/// under strict and for the defect under default; the depth bound is still the
/// limit class; a repeated key with no UTF-8 reading is still a repeat.
#[test]
fn strict_mode_class_boundaries() {
    let both = br#"{"a": 1, "a": 2, "b": 1.5}"#;
    assert!(
        matches!(project_with(both, STRICT), Err(ProjectionError::DuplicateKey { ref path, .. }) if path == "$.a"),
        "strict: the reader precedes the walk"
    );
    assert!(
        matches!(project(both), Err(ProjectionError::Rejected { ref path, .. }) if path == "$.b"),
        "default: the /1 decimal-arm rejection at $.b"
    );

    let deep = format!(
        "{}1{}",
        "{\"a\":".repeat(MAX_DEPTH + 1),
        "}".repeat(MAX_DEPTH + 1)
    );
    assert_eq!(
        project_with(deep.as_bytes(), STRICT),
        Err(ProjectionError::DepthLimit { limit: MAX_DEPTH })
    );

    let lone = br#"{"\ud800": 1, "\ud800": 2}"#;
    assert!(matches!(
        project_with(lone, STRICT),
        Err(ProjectionError::DuplicateKey { .. })
    ));
    assert!(matches!(
        project(lone),
        Err(ProjectionError::Rejected { .. })
    ));

    // Options::default() is project, spelled out.
    project_with(br#"{"k": 1, "k": 2}"#, Options::default()).expect("default is last-wins");
}
