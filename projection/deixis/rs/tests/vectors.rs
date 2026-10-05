//! Replays the projection conformance vectors (`../vectors/ontos-projection.json`)
//! and pins byte preservation against the frozen codec vectors
//! (`../../../vectors/codec.json`). A self-contained minimal JSON reader keeps the
//! crate dependency-free, per the family discipline.

use ontos_core::Value;
use ontos_deixis_projection::{node_eq, project, recognize, BytesNode, Unrecognized};

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
        self.i += 1;
        let mut out = Vec::new();
        loop {
            self.ws();
            if self.b[self.i] == b'}' {
                self.i += 1;
                return Json::Obj(out);
            }
            let k = self.string();
            self.ws();
            self.i += 1; // :
            let v = self.value();
            out.push((k, v));
            self.ws();
            if self.b[self.i] == b',' {
                self.i += 1;
            }
        }
    }
    fn arr(&mut self) -> Json {
        self.i += 1;
        let mut out = Vec::new();
        loop {
            self.ws();
            if self.b[self.i] == b']' {
                self.i += 1;
                return Json::Arr(out);
            }
            out.push(self.value());
            self.ws();
            if self.b[self.i] == b',' {
                self.i += 1;
            }
        }
    }
    fn string(&mut self) -> String {
        self.ws();
        self.i += 1; // opening quote
        let mut out = String::new();
        while self.b[self.i] != b'"' {
            if self.b[self.i] == b'\\' {
                self.i += 1;
                match self.b[self.i] {
                    b'n' => out.push('\n'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let hex = std::str::from_utf8(&self.b[self.i + 1..self.i + 5]).unwrap();
                        out.push(char::from_u32(u32::from_str_radix(hex, 16).unwrap()).unwrap());
                        self.i += 4;
                    }
                    c => out.push(c as char),
                }
                self.i += 1;
            } else {
                // Multi-byte UTF-8: copy the whole code point.
                let start = self.i;
                self.i += 1;
                while self.i < self.b.len() && (self.b[self.i] & 0xc0) == 0x80 {
                    self.i += 1;
                }
                out.push_str(std::str::from_utf8(&self.b[start..self.i]).unwrap());
            }
        }
        self.i += 1; // closing quote
        out
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
        Json::Num(
            std::str::from_utf8(&self.b[start..self.i])
                .unwrap()
                .parse()
                .unwrap(),
        )
    }
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(items) => items,
            other => panic!("expected array, got {other:?}"),
        }
    }
    fn str(&self) -> &str {
        match self {
            Json::Str(s) => s,
            other => panic!("expected string, got {other:?}"),
        }
    }
    fn boolean(&self) -> bool {
        match self {
            Json::Bool(b) => *b,
            other => panic!("expected bool, got {other:?}"),
        }
    }
    fn index(&self) -> usize {
        match self {
            Json::Num(n) => *n as usize,
            other => panic!("expected a tuple index, got {other:?}"),
        }
    }
}

fn hex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd hex length in {s:?}");
    (0..s.len())
        .step_by(2)
        .map(|k| u8::from_str_radix(&s[k..k + 2], 16).unwrap())
        .collect()
}

/// Ontos vector notation: {"atom": hex} | {"tuple": [...]}.
fn value_of(json: &Json) -> Value {
    if let Some(atom) = json.get("atom") {
        Value::atom(hex(atom.str()))
    } else if let Some(items) = json.get("tuple") {
        Value::tuple(items.arr().iter().map(value_of))
    } else {
        panic!("not a value: {json:?}")
    }
}

/// Deixis node notation, mandatory-value model:
/// `{"own": hex | null, "children": [[key-hex, node], ...]}`.
///
/// `own` is the whole payload: a hex string is `Some(bytes)` — including `""` for
/// `Some(&[])` — and `null` is `None`. Every node carries both halves, so there is no
/// constructor to choose between.
fn node_of(json: &Json) -> BytesNode {
    let own = match json.get("own").expect("every node carries `own`") {
        Json::Null => None,
        some => Some(hex(some.str())),
    };
    let children = json
        .get("children")
        .expect("every node carries `children`")
        .arr();
    BytesNode::compose(
        own,
        children.iter().map(|pair| {
            let pair = pair.arr();
            (hex(pair[0].str()), node_of(&pair[1]))
        }),
    )
    .expect("vector nodes carry distinct keys")
}

/// The vector spelling of a refusal, so `kind` can be compared across faces.
fn kind_of(err: &Unrecognized) -> &'static str {
    match err {
        Unrecognized::KeyMismatch { .. } => "key_mismatch",
        Unrecognized::ValueWithChildren { .. } => "value_with_children",
    }
}

const PROJECTION: &str = include_str!("../../vectors/ontos-projection.json");
const CODEC: &str = include_str!("../../../../vectors/codec.json");

#[test]
fn project_cases_pin_p_and_r() {
    let doc = P::new(PROJECTION).value();
    let cases = doc.get("project").expect("project section").arr();
    assert!(cases.len() >= 10, "vector file shrank?");

    for case in cases {
        let name = case.get("name").unwrap().str().to_string();
        let value = value_of(case.get("value").unwrap());
        let node = node_of(case.get("node").unwrap());

        // P(value) = node, under deixis identity (authored entry order must not matter).
        assert!(node_eq(&project(&value), &node), "P mismatch: {name}");
        // R(node) = value, and R(P(value)) = value (laws 1-3).
        assert_eq!(recognize(&node).unwrap(), value, "R mismatch: {name}");
        assert_eq!(recognize(&project(&value)).unwrap(), value, "law 1: {name}");
    }
}

#[test]
fn value_pairs_pin_law_4() {
    // Law 4 is a claim about a PAIR, so it lives in the CORPUS rather than in this file.
    // It used to be a bespoke pairwise loop here, which meant a witness handed the spec and
    // the vectors could replay everything green having tested law 4 zero times (ontos-internal#286).
    let doc = P::new(PROJECTION).value();
    let cases = doc.get("value_pairs").expect("value_pairs section").arr();
    assert!(cases.len() >= 6, "vector file shrank?");

    let mut saw_equal = false;
    let mut saw_distinct = false;
    for case in cases {
        let name = case.get("name").unwrap().str();
        let left = value_of(case.get("left").unwrap());
        let right = value_of(case.get("right").unwrap());
        let equal = case.get("equal").unwrap().boolean();
        if equal {
            saw_equal = true
        } else {
            saw_distinct = true
        }

        assert_eq!(
            left == right,
            equal,
            "corpus claim is wrong about =O: {name}"
        );
        assert_eq!(
            node_eq(&project(&left), &project(&right)),
            equal,
            "law 4 fails: {name}"
        );
    }
    // Both directions of the `iff`, or the section only tests half a law.
    assert!(
        saw_equal && saw_distinct,
        "value_pairs must carry equal AND distinct cases"
    );
}

#[test]
fn d_equal_nodes_pin_law_5() {
    // Law 5: d =D e implies the same recognizer outcome, and equal outputs on success.
    // Needs two NODES, which no single-value case can carry.
    let doc = P::new(PROJECTION).value();
    let cases = doc
        .get("d_equal_nodes")
        .expect("d_equal_nodes section")
        .arr();
    assert!(!cases.is_empty(), "vector file shrank?");

    for case in cases {
        let name = case.get("name").unwrap().str();
        let left = node_of(case.get("left").unwrap());
        let right = node_of(case.get("right").unwrap());

        assert!(
            node_eq(&left, &right),
            "corpus claim is wrong about =D: {name}"
        );
        match (recognize(&left), recognize(&right)) {
            (Ok(a), Ok(b)) => assert_eq!(a, b, "law 5: equal nodes, different outputs: {name}"),
            (Err(_), Err(_)) => {}
            _ => panic!("law 5: equal nodes, different outcomes: {name}"),
        }
    }
}

/// Walk an ontos index path. `None` = the path does not resolve.
fn walk_value<'a>(value: &'a Value, path: &[usize]) -> Option<&'a Value> {
    let mut cur = value;
    for &i in path {
        cur = cur.as_tuple()?.items().get(i)?;
    }
    Some(cur)
}

/// Walk the corresponding deixis key path `(κ(i₀), …, κ(iₖ))`.
fn walk_node<'a>(node: &'a BytesNode, path: &[usize]) -> Option<&'a BytesNode> {
    let mut cur = node;
    for &i in path {
        cur = cur.get(&deixis_pos::key(i as u64))?;
    }
    Some(cur)
}

#[test]
fn paths_pin_law_7() {
    // Law 7: the index path resolves in `v` IFF the key path resolves in `P(v)`, and on
    // success it reaches `P` of the SAME subvalue. Both halves matter — a face could
    // agree on reachability everywhere and still land on the wrong node.
    //
    // Until ontos-internal#290 no section carried a path, so law 7 was the one law a witness could
    // replay the whole corpus without testing. `rs` alone tested the commutation, in its
    // own unit test, which is exactly the harness-not-artifact shape ontos-internal#286 removed
    // from laws 4 and 5.
    let doc = P::new(PROJECTION).value();
    let cases = doc.get("paths").expect("paths section").arr();
    assert!(cases.len() >= 6, "vector file shrank?");

    let mut saw_resolving = false;
    let mut saw_absent = false;
    for case in cases {
        let name = case.get("name").unwrap().str();
        let value = value_of(case.get("value").unwrap());
        let path: Vec<usize> = case
            .get("index_path")
            .unwrap()
            .arr()
            .iter()
            .map(|j| j.index())
            .collect();
        let resolves = case.get("resolves").unwrap().boolean();
        if resolves {
            saw_resolving = true
        } else {
            saw_absent = true
        }

        let by_index = walk_value(&value, &path);
        assert_eq!(
            by_index.is_some(),
            resolves,
            "the corpus claim about the INDEX path is wrong: {name}"
        );

        let node = project(&value);
        let by_keys = walk_node(&node, &path);
        assert_eq!(
            by_keys.is_some(),
            resolves,
            "law 7: the two paths disagree about reachability: {name}"
        );

        if resolves {
            let sub = value_of(case.get("subvalue").unwrap());
            assert_eq!(
                by_index.unwrap(),
                &sub,
                "the corpus claim about the SUBVALUE is wrong: {name}"
            );
            assert!(
                node_eq(by_keys.unwrap(), &project(&sub)),
                "law 7: the key path reaches a node that is not P(subvalue): {name}"
            );
        }
    }
    // Both directions of the `iff`, or the section pins half a law.
    assert!(
        saw_resolving && saw_absent,
        "paths must carry resolving AND non-resolving cases"
    );
}

#[test]
fn unrecognized_cases_pin_refusal() {
    let doc = P::new(PROJECTION).value();
    let cases = doc.get("unrecognized").expect("unrecognized section").arr();
    assert!(cases.len() >= 12, "vector file shrank?");

    let mut seen_shape = 0;
    for case in cases {
        let name = case.get("name").unwrap().str();
        let reason = case.get("reason").unwrap().str();
        let kind = case
            .get("kind")
            .expect("every refusal names its kind")
            .str();
        let node = node_of(case.get("node").unwrap());

        let err = match recognize(&node) {
            Err(err) => err,
            Ok(value) => panic!("{name} must be refused ({reason}), got {value:?}"),
        };
        // The KIND is normative, the prose is not: a node refused for its shape must not
        // be reported as a key problem, or the explanation names a culprit that is fine.
        assert_eq!(
            kind_of(&err),
            kind,
            "{name}: refused for the wrong reason — {err}"
        );
        if kind == "value_with_children" {
            seen_shape += 1;
        }
    }
    assert!(
        seen_shape >= 5,
        "the mandatory-value shape refusals are not being exercised"
    );
}

#[test]
fn d_distinct_nodes_pin_payload_equality() {
    // Equality is over the WHOLE Option<Vec<u8>> payload. These pairs are =D-DISTINCT,
    // and each names a way a lax relation would merge them: None vs Some(""), and two
    // Somes differing only in length.
    let doc = P::new(PROJECTION).value();
    let cases = doc
        .get("d_distinct_nodes")
        .expect("d_distinct_nodes section")
        .arr();
    assert!(!cases.is_empty(), "vector file shrank?");

    for case in cases {
        let name = case.get("name").unwrap().str();
        let reason = case.get("reason").unwrap().str();
        let left = node_of(case.get("left").unwrap());
        let right = node_of(case.get("right").unwrap());

        assert!(!node_eq(&left, &right), "{name}: merged by =D — {reason}");
        // Reflexivity, so a relation that simply answers "false" cannot pass this.
        assert!(node_eq(&left, &left), "{name}: =D is not reflexive on left");
        assert!(
            node_eq(&right, &right),
            "{name}: =D is not reflexive on right"
        );
    }
}

#[test]
fn frozen_codec_bytes_survive_the_round_trip() {
    // toOntosBytes(P(v)) = encodeOntosV1(v), byte for byte, over the frozen corpus:
    // decode each frozen encoding, project, recognize back, re-encode, compare.
    let doc = P::new(CODEC).value();
    let cases = doc.get("encode").expect("encode section").arr();
    assert!(cases.len() >= 5, "codec vector file shrank?");

    for case in cases {
        let name = case.get("name").unwrap().str();
        let frozen = hex(case.get("hex").unwrap().str());
        let value = ontos_codec::decode(&frozen).expect(name);

        let round_tripped = recognize(&project(&value)).unwrap();
        assert_eq!(
            ontos_codec::encode(&round_tripped),
            frozen,
            "codec bytes changed through the bridge: {name}"
        );
    }
}
