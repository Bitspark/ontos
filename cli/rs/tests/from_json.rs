//! Drives the built `ontos` binary to check the `--from-json` authoring input.
//!
//! The marquee contract (docs/spec/ontos-cli.md "Value input"): for every `encode`
//! vector in `vectors/codec.json` and `vectors/data.json`, the authoring JSON in
//! `value` round-trips through `canon --emit --from-json <value>` to exactly the
//! pinned canonical `hex`. The value is *built* from the notation (never decoded),
//! so it is canonical by construction — this asserts the Rust parser inverts the
//! `--format json` value rendering byte-for-byte across the whole vector corpus.
//!
//! Also pinned here: the reject grammar (malformed/non-authoring JSON ->
//! `invalid_json`, exit 2) and the mutual exclusion with a positional `<hex>`
//! (-> `usage_error`, exit 2). A self-contained minimal JSON reader keeps the CLI
//! and its tests dependency-free.

use std::process::Command;

// ----- tiny JSON reader (test-only; just enough for the vector files) ---------

#[derive(Debug, Clone)]
enum Json {
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
    Other,
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
                Json::Other
            }
            b'f' => {
                self.i += 5;
                Json::Other
            }
            b'n' => {
                self.i += 4;
                Json::Other
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
        while self.i < self.b.len()
            && matches!(
                self.b[self.i],
                b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E'
            )
        {
            self.i += 1;
        }
        Json::Other
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

/// Re-serialize a parsed `Json` value back to compact authoring JSON — exactly the
/// `{atom}|{tuple}` notation the CLI expects on `--from-json`. (The vectors already
/// store `value` in this shape; this round-trips it through our reader so the test
/// hands the CLI a clean, whitespace-free string.)
fn to_compact(j: &Json) -> String {
    if let Some(a) = j.get("atom") {
        format!(r#"{{"atom":"{}"}}"#, a.str())
    } else if let Some(t) = j.get("tuple") {
        let inner: Vec<String> = t.arr().iter().map(to_compact).collect();
        format!(r#"{{"tuple":[{}]}}"#, inner.join(","))
    } else {
        panic!("value is not {{atom}}|{{tuple}}: {j:?}");
    }
}

fn read_vectors(name: &str) -> Json {
    let path = format!("{}/../../vectors/{}", env!("CARGO_MANIFEST_DIR"), name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    P::new(&text).value()
}

// ----- driving the built binary ----------------------------------------------

/// The compiled `ontos` binary under test (provided by Cargo to integration tests).
fn ontos() -> Command {
    Command::new(env!("CARGO_BIN_EXE_ontos"))
}

struct Run {
    code: i32,
    stdout: String,
}

fn run(args: &[&str]) -> Run {
    let output = ontos()
        .args(args)
        .output()
        .expect("failed to spawn ontos binary");
    Run {
        code: output.status.code().expect("process killed by signal"),
        stdout: String::from_utf8(output.stdout).expect("stdout not utf-8"),
    }
}

// ----- the round-trip test (the marquee contract) ----------------------------

/// `canon --emit --from-json <value>` prints exactly `<hex>` for every `encode`
/// case in both vector files. The value is built from the authoring notation, so
/// this verifies the parser inverts the `--format json` rendering byte-for-byte.
fn assert_emit_roundtrip(file: &str) {
    let doc = read_vectors(file);
    let mut n = 0;
    for case in doc.get("encode").unwrap().arr() {
        let name = case.get("name").unwrap().str();
        let value_json = to_compact(case.get("value").unwrap());
        let want_hex = case.get("hex").unwrap().str();

        let out = run(&["canon", "--emit", "--from-json", &value_json]);
        assert_eq!(out.code, 0, "{file} case {name:?} exited {}", out.code);
        // `--emit` (human format) prints exactly the canonical hex + newline.
        assert_eq!(
            out.stdout.trim_end_matches('\n'),
            want_hex,
            "{file} case {name:?}: --from-json {value_json} emitted {:?}, want {want_hex}",
            out.stdout
        );
        n += 1;
    }
    assert!(n > 0, "no encode cases loaded from {file}");
}

#[test]
fn emit_from_json_roundtrips_codec_vectors() {
    assert_emit_roundtrip("codec.json");
}

#[test]
fn emit_from_json_roundtrips_data_vectors() {
    assert_emit_roundtrip("data.json");
}

// ----- a representative spot-check (the spec's worked example) ----------------

/// The exact example from docs/spec/ontos-cli.md "Value input".
#[test]
fn emit_from_json_matches_spec_example() {
    let out = run(&[
        "canon",
        "--emit",
        "--from-json",
        r#"{"tuple":[{"atom":"696e74"},{"atom":"00"}]}"#,
    ]);
    assert_eq!(out.code, 0);
    assert_eq!(out.stdout, "01020003696e74000100\n");
}

// ----- reject grammar: invalid_json, exit 2 ----------------------------------

#[test]
fn malformed_or_non_authoring_json_is_invalid_json() {
    // Each of these must be rejected as `invalid_json` with exit 2, in both the
    // human and json output formats (the json line carries the stable code).
    let bad = [
        r#"{"atom":"0"}"#,             // odd-length hex
        r#"{"atom":"AB"}"#,            // uppercase hex
        r#"{"atom":"zz"}"#,            // non-hex
        r#"{"foo":1}"#,                // unknown key
        r#"{"atom":"00","tuple":[]}"#, // both atom and tuple
        r#"{}"#,                       // neither
        r#"{"atom":123}"#,             // non-string atom
        r#"{"tuple":"00"}"#,           // non-array tuple
        r#"["atom"]"#,                 // value not an object
        r#"42"#,                       // value not an object
        r#"{"#,                        // malformed JSON
        r#"{"atom":"00"}garbage"#,     // trailing junk
    ];
    for input in bad {
        // human format -> stderr only, but exit code is the contract.
        let human = run(&["canon", "--emit", "--from-json", input]);
        assert_eq!(human.code, 2, "human reject {input:?} exit {}", human.code);

        // json format -> the stable error line + exit 2.
        let json = run(&["canon", "--emit", "--format", "json", "--from-json", input]);
        assert_eq!(json.code, 2, "json reject {input:?} exit {}", json.code);
        assert_eq!(
            json.stdout, "{\"ok\":false,\"command\":\"canon\",\"error\":\"invalid_json\"}\n",
            "json reject {input:?} stdout {:?}",
            json.stdout
        );
    }
}

// ----- mutual exclusion with a positional <hex>: usage_error, exit 2 ----------

#[test]
fn from_json_with_positional_hex_is_usage_error() {
    // `--from-json '...' <hex>` (both sources) is a usage error.
    let value = r#"{"atom":"00"}"#;
    let hex = "000100";

    let human = run(&["canon", "--emit", "--from-json", value, hex]);
    assert_eq!(human.code, 2, "human both-sources exit {}", human.code);

    let json = run(&[
        "canon",
        "--emit",
        "--format",
        "json",
        "--from-json",
        value,
        hex,
    ]);
    assert_eq!(json.code, 2, "json both-sources exit {}", json.code);
    assert_eq!(
        json.stdout, "{\"ok\":false,\"command\":\"canon\",\"error\":\"usage_error\"}\n",
        "json both-sources stdout {:?}",
        json.stdout
    );
}

/// `--from-json <value> -` — the `-` stdin sentinel is ALSO a positional and is a
/// usage error, exactly like a real hex positional (ontos-internal#45). Before ontos-internal#45 the Rust
/// core uniquely accepted this (it exempted `-`), diverging from go/ts; this pins the
/// stricter, tri-core rule so it cannot silently regress. The JSON-only conformance
/// harness is structurally blind to this case (no vector value is `-`).
#[test]
fn from_json_with_dash_positional_is_usage_error() {
    let value = r#"{"atom":"00"}"#;

    // `-` after --from-json, both orders, in human and json formats. (We pass empty
    // stdin so that if the rule ever regressed to "accept", the test would still
    // terminate rather than block reading stdin.)
    for args in [
        vec!["canon", "--emit", "--from-json", value, "-"],
        vec!["canon", "--emit", "-", "--from-json", value],
    ] {
        let human = run(&args);
        assert_eq!(human.code, 2, "human {args:?} exit {}", human.code);
    }

    let json = run(&[
        "canon",
        "--emit",
        "--format",
        "json",
        "--from-json",
        value,
        "-",
    ]);
    assert_eq!(json.code, 2, "json dash-positional exit {}", json.code);
    assert_eq!(
        json.stdout, "{\"ok\":false,\"command\":\"canon\",\"error\":\"usage_error\"}\n",
        "json dash-positional stdout {:?}",
        json.stdout
    );
}

// ----- the empty atom and empty tuple build correctly ------------------------

#[test]
fn empty_atom_and_empty_tuple_build() {
    // "" is the empty atom (Atom([])); [] is the empty tuple (Tuple()).
    let atom = run(&["canon", "--emit", "--from-json", r#"{"atom":""}"#]);
    assert_eq!(atom.code, 0);
    assert_eq!(atom.stdout, "0000\n"); // tag 0x00, uvarint len 0

    let tuple = run(&["canon", "--emit", "--from-json", r#"{"tuple":[]}"#]);
    assert_eq!(tuple.code, 0);
    assert_eq!(tuple.stdout, "0100\n"); // tag 0x01, uvarint arity 0
}

// ----- duplicate keys: last-value-wins (tri-core parity) ---------------------

#[test]
fn duplicate_keys_resolve_last_wins() {
    // A duplicate object key collapses last-value-wins, matching `encoding/json`
    // (Go) and `JSON.parse` (TS) — so go/rs/ts agree byte-for-byte. `00` then `01`
    // resolves to the atom `01` (0x00 ‖ uvarint(1) ‖ 0x01); three duplicates still
    // take the last. (Two DISTINCT keys, e.g. atom+tuple, remain a reject — covered
    // above — because the collapsed object then has two keys, not one.)
    let dup = run(&[
        "canon",
        "--emit",
        "--from-json",
        r#"{"atom":"00","atom":"01"}"#,
    ]);
    assert_eq!(dup.code, 0, "dup-key exit {}", dup.code);
    assert_eq!(dup.stdout, "000101\n");

    let three = run(&[
        "canon",
        "--emit",
        "--from-json",
        r#"{"atom":"00","atom":"01","atom":"02"}"#,
    ]);
    assert_eq!(three.stdout, "000102\n");
}

// ----- --from-json works with every command (not just canon) -----------------

#[test]
fn from_json_works_with_other_commands() {
    // decode renders the authored value back as the authoring JSON (round-trip),
    // and inspect reports it canonical by construction.
    let value = r#"{"tuple":[{"atom":"696e74"},{"atom":"00"}]}"#;

    let decode = run(&["decode", "--format", "json", "--from-json", value]);
    assert_eq!(decode.code, 0);
    assert_eq!(
        decode.stdout,
        "{\"ok\":true,\"command\":\"decode\",\"codec\":\"ontos-codec-v1\",\"value\":\
         {\"tuple\":[{\"atom\":\"696e74\"},{\"atom\":\"00\"}]}}\n"
    );

    let inspect = run(&["inspect", "--format", "json", "--from-json", value]);
    assert_eq!(inspect.code, 0);
    // built value is canonical by construction; int is the recognized embedding.
    assert!(
        inspect.stdout.contains("\"canonical\":true"),
        "inspect stdout {:?}",
        inspect.stdout
    );
    assert!(
        inspect.stdout.contains("\"recognized\":[\"int\"]"),
        "inspect stdout {:?}",
        inspect.stdout
    );

    // read --kind int recognizes the authored int embedding (exit 0).
    let read = run(&["read", "--kind", "int", "--from-json", value]);
    assert_eq!(read.code, 0, "read exit {}", read.code);
}
