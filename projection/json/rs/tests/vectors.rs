//! Replays every case of `projection/json/vectors/{total,readable}.json` (the README there
//! gives the format) against this crate: reads, refusals (code, path, span, kind), writes,
//! write refusals (code, kind), origins, and the laws on every case with an output.
//!
//! The vector files are read with the small JSON reader below, not with this crate, so a
//! defect in the crate's reader cannot hide in how its own vectors are loaded.

use ontos_codec::{decode, encode};
use ontos_core::Value;
use ontos_json::{readable, total, Error, Limits, Segment};

// ----- a minimal JSON reader for the vector files (test-only) -------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\r' | b'\n') {
            self.i += 1;
        }
    }

    fn eat(&mut self, c: u8) {
        self.ws();
        assert_eq!(
            self.b[self.i], c,
            "vector file: expected {:?} at byte {}",
            c as char, self.i
        );
        self.i += 1;
    }

    fn value(&mut self) -> Json {
        self.ws();
        match self.b[self.i] {
            b'{' => {
                self.i += 1;
                let mut members = Vec::new();
                self.ws();
                if self.b[self.i] == b'}' {
                    self.i += 1;
                    return Json::Obj(members);
                }
                loop {
                    self.ws();
                    let name = self.string();
                    self.eat(b':');
                    members.push((name, self.value()));
                    self.ws();
                    self.i += 1;
                    if self.b[self.i - 1] == b'}' {
                        return Json::Obj(members);
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.b[self.i] == b']' {
                    self.i += 1;
                    return Json::Arr(items);
                }
                loop {
                    items.push(self.value());
                    self.ws();
                    self.i += 1;
                    if self.b[self.i - 1] == b']' {
                        return Json::Arr(items);
                    }
                }
            }
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
            _ => {
                let start = self.i;
                while self.i < self.b.len() && matches!(self.b[self.i], b'-' | b'0'..=b'9') {
                    self.i += 1;
                }
                let lexeme = std::str::from_utf8(&self.b[start..self.i]).unwrap();
                Json::Int(lexeme.parse().expect("vector numbers are integers"))
            }
        }
    }

    fn hex4(&mut self) -> u32 {
        let s = std::str::from_utf8(&self.b[self.i..self.i + 4]).unwrap();
        self.i += 4;
        u32::from_str_radix(s, 16).unwrap()
    }

    fn string(&mut self) -> String {
        assert_eq!(self.b[self.i], b'"');
        self.i += 1;
        let mut out = String::new();
        loop {
            let c = self.b[self.i];
            match c {
                b'"' => {
                    self.i += 1;
                    return out;
                }
                b'\\' => {
                    let e = self.b[self.i + 1];
                    self.i += 2;
                    match e {
                        b'u' => {
                            let mut cp = self.hex4();
                            if (0xd800..0xdc00).contains(&cp) {
                                assert_eq!(&self.b[self.i..self.i + 2], b"\\u");
                                self.i += 2;
                                let low = self.hex4();
                                cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
                            }
                            out.push(char::from_u32(cp).expect("vector strings are scalar values"));
                        }
                        b'n' => out.push('\n'),
                        b't' => out.push('\t'),
                        b'r' => out.push('\r'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        other => out.push(other as char),
                    }
                }
                _ => {
                    let start = self.i;
                    while !matches!(self.b[self.i], b'"' | b'\\') {
                        self.i += 1;
                    }
                    out.push_str(std::str::from_utf8(&self.b[start..self.i]).unwrap());
                }
            }
        }
    }
}

impl Json {
    fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(members) => members.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(items) => items,
            other => panic!("not an array: {other:?}"),
        }
    }

    fn str(&self) -> &str {
        match self {
            Json::Str(s) => s,
            other => panic!("not a string: {other:?}"),
        }
    }

    fn int(&self) -> i64 {
        match self {
            Json::Int(n) => *n,
            other => panic!("not an integer: {other:?}"),
        }
    }

    fn count(&self) -> usize {
        usize::try_from(self.int()).expect("a count")
    }
}

/// A text field, or `{"runs": [[piece, count], …]}` (README, "Runs").
fn text_field(field: &Json) -> String {
    match field.get("runs") {
        None => field.str().to_owned(),
        Some(runs) => runs
            .arr()
            .iter()
            .map(|run| run.arr()[0].str().repeat(run.arr()[1].count()))
            .collect(),
    }
}

/// A path, or runs of path pieces.
fn path_field(field: &Json) -> Vec<Json> {
    match field.get("runs") {
        None => field.arr().to_vec(),
        Some(runs) => {
            let mut out = Vec::new();
            for run in runs.arr() {
                for _ in 0..run.arr()[1].count() {
                    out.extend(run.arr()[0].arr().iter().cloned());
                }
            }
            out
        }
    }
}

fn hex(s: &str) -> Vec<u8> {
    assert!(s.len().is_multiple_of(2), "odd hex");
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn segments(path: &[Json]) -> Vec<Segment> {
    path.iter()
        .map(|seg| match seg {
            Json::Str(name) => Segment::Name(name.clone()),
            Json::Int(i) => Segment::Index(usize::try_from(*i).unwrap()),
            other => panic!("bad path segment {other:?}"),
        })
        .collect()
}

/// One pinned origin: value path, JSON path, span.
type OriginRow = (Vec<usize>, Vec<Segment>, (usize, usize));

// ----- the replay ----------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Face {
    Total,
    Readable,
}

impl Face {
    fn file(self) -> &'static str {
        match self {
            Face::Total => "total.json",
            Face::Readable => "readable.json",
        }
    }

    fn id(self) -> &'static str {
        match self {
            Face::Total => total::PROFILE,
            Face::Readable => readable::PROFILE,
        }
    }

    fn defaults(self) -> Limits {
        match self {
            Face::Total => total::DEFAULT_LIMITS,
            Face::Readable => readable::DEFAULT_LIMITS,
        }
    }

    fn parse(self, input: &[u8], limits: &Limits) -> Result<Value, Error> {
        match self {
            Face::Total => total::parse_utf8(input, limits),
            Face::Readable => readable::parse_utf8(input, limits),
        }
    }

    fn parse_str(self, input: &str, limits: &Limits) -> Result<Value, Error> {
        match self {
            Face::Total => total::parse_str(input, limits),
            Face::Readable => readable::parse_str(input, limits),
        }
    }

    fn render(self, value: &Value, limits: &Limits) -> Result<Vec<u8>, Error> {
        match self {
            Face::Total => total::render_utf8(value, limits),
            Face::Readable => readable::render_utf8(value, limits),
        }
    }
}

#[derive(Default, Debug)]
struct Tally {
    cases: usize,
    reads: usize,
    refusals: usize,
    writes: usize,
    write_refusals: usize,
    origins: usize,
    laws: usize,
}

fn limits_of(face: Face, case: &Json) -> Limits {
    let mut limits = face.defaults();
    if let Some(Json::Obj(fields)) = case.get("limits") {
        for (name, value) in fields {
            let v = u64::try_from(value.int()).expect("a non-negative bound");
            match name.as_str() {
                "max_text_bytes" => limits.max_text_bytes = v,
                "max_json_depth" => limits.max_json_depth = Some(v),
                "max_value_depth" => limits.max_value_depth = v,
                "max_atom_bytes" => limits.max_atom_bytes = v,
                "max_tuple_arity" => limits.max_tuple_arity = v,
                "max_integer_digits" => limits.max_integer_digits = v,
                other => panic!("unknown limit {other}"),
            }
        }
    }
    limits
}

fn describe(e: &Error) -> String {
    format!(
        "{} {:?} {:?} {:?} ({})",
        e.code(),
        e.path(),
        e.span().map(|s| (s.start, s.end)),
        e.kind().map(|k| k.as_str()),
        e.message()
    )
}

/// Replays one case; returns the problems found.
fn replay(face: Face, case: &Json, tally: &mut Tally) -> Vec<String> {
    let mut problems = Vec::new();
    let limits = limits_of(face, case);
    let input = case.get("input_hex").map(|h| hex(&text_field(h)));
    let value_hex = case.get("value_hex").map(text_field);

    if let Some(refusal) = case.get("refusal") {
        let input = input.as_ref().expect("a refusal case has an input");
        match face.parse(input, &limits) {
            Ok(v) => problems.push(format!("read accepted, value {}", to_hex(&encode(&v)))),
            Err(e) => {
                let want_code = refusal.get("code").unwrap().str();
                let want_path = segments(&path_field(refusal.get("path").unwrap()));
                let span = refusal.get("span").unwrap().arr();
                let want_span = (span[0].count(), span[1].count());
                let want_kind = refusal.get("kind").map(|k| k.str().to_owned());
                let got_span = e.span().map(|s| (s.start, s.end));
                let ok = e.profile().id() == face.id()
                    && e.code().as_str() == want_code
                    && e.path() == want_path.as_slice()
                    && got_span == Some(want_span)
                    && e.kind().map(|k| k.as_str().to_owned()) == want_kind;
                if ok {
                    tally.refusals += 1;
                } else {
                    let want_path_short: Vec<_> = want_path.iter().take(8).collect();
                    problems.push(format!(
                        "refusal differs: got {}, want {want_code} {want_path_short:?}… {want_span:?} {want_kind:?}",
                        describe(&e)
                    ));
                }
            }
        }
        // The host-string reader reads a well-formed input the same way.
        if let Ok(text) = std::str::from_utf8(input) {
            let by_str = face.parse_str(text, &limits);
            let by_bytes = face.parse(input, &limits);
            if by_str != by_bytes {
                problems.push("parse_str and parse_utf8 disagree".to_owned());
            }
        }
        return problems;
    }

    let value_hex = value_hex.expect("a case without a refusal has value_hex");
    let value = decode(&hex(&value_hex)).expect("value_hex decodes");

    if let Some(input) = &input {
        match face.parse(input, &limits) {
            Ok(v) if to_hex(&encode(&v)) == value_hex => tally.reads += 1,
            Ok(v) => problems.push(format!("read value differs: {}", to_hex(&encode(&v)))),
            Err(e) => problems.push(format!("read refused: {}", describe(&e))),
        }
        if let Ok(text) = std::str::from_utf8(input) {
            match face.parse_str(text, &limits) {
                Ok(v) if v == value => {}
                other => problems.push(format!(
                    "parse_str differs: {:?}",
                    other.map(|v| to_hex(&encode(&v)))
                )),
            }
        }
        if let Some(want) = case.get("origins") {
            assert_eq!(
                face,
                Face::Readable,
                "origins are a readable-profile result"
            );
            match readable::parse_utf8_with_origins(input, &limits) {
                Err(e) => problems.push(format!("origins reader refused: {}", describe(&e))),
                Ok(parsed) => {
                    let got: Vec<OriginRow> = parsed
                        .origins
                        .iter()
                        .map(|(vp, o)| (vp, o.path, (o.span.start, o.span.end)))
                        .collect();
                    let want: Vec<OriginRow> = want
                        .arr()
                        .iter()
                        .map(|entry| {
                            let e = entry.arr();
                            let vp = e[0].arr().iter().map(Json::count).collect();
                            let span = e[2].arr();
                            (vp, segments(e[1].arr()), (span[0].count(), span[1].count()))
                        })
                        .collect();
                    let lookups_agree = want.iter().all(|(vp, path, span)| {
                        parsed
                            .origins
                            .get(vp)
                            .is_some_and(|o| &o.path == path && (o.span.start, o.span.end) == *span)
                    });
                    if parsed.value != value {
                        problems.push("origins reader's value differs".to_owned());
                    } else if got != want || !lookups_agree || parsed.origins.len() != want.len() {
                        problems.push(format!("origins differ: got {got:?}"));
                    } else {
                        tally.origins += 1;
                    }
                }
            }
        }
    }

    if let Some(refusal) = case.get("render_refusal") {
        match face.render(&value, &limits) {
            Ok(out) => problems.push(format!("write accepted: {}", String::from_utf8_lossy(&out))),
            Err(e) => {
                let ok = e.profile().id() == face.id()
                    && e.code().as_str() == refusal.get("code").unwrap().str()
                    && e.kind().map(|k| k.as_str()) == refusal.get("kind").map(Json::str)
                    && e.span().is_none();
                if ok {
                    tally.write_refusals += 1;
                } else {
                    problems.push(format!("write refusal differs: {}", describe(&e)));
                }
            }
        }
        return problems;
    }

    let output = text_field(
        case.get("output")
            .expect("a case with a value has an output or a write refusal"),
    );
    match face.render(&value, &limits) {
        Ok(out) if out == output.as_bytes() => tally.writes += 1,
        Ok(out) => problems.push(format!("output differs: {}", String::from_utf8_lossy(&out))),
        Err(e) => problems.push(format!("write refused: {}", describe(&e))),
    }
    // The laws (total §7): R(W(v)) = v, and W(R(j)) = j on the writer's image.
    match face.parse(output.as_bytes(), &limits) {
        Ok(back) if back == value => match face.render(&back, &limits) {
            Ok(again) if again == output.as_bytes() => tally.laws += 1,
            _ => problems.push("law W(R(j)) = j fails".to_owned()),
        },
        Ok(_) => problems.push("law R(W(v)) = v fails: another value".to_owned()),
        Err(e) => problems.push(format!("law R(W(v)) = v fails: {}", describe(&e))),
    }
    problems
}

fn replay_file(face: Face) -> Tally {
    let path = format!("{}/../vectors/{}", env!("CARGO_MANIFEST_DIR"), face.file());
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    let doc = Reader {
        b: text.as_bytes(),
        i: 0,
    }
    .value();
    assert_eq!(doc.get("profile").unwrap().str(), face.id());
    assert_eq!(doc.get("codec").unwrap().str(), "ontos-codec-v1");
    let mut tally = Tally::default();
    let mut failures = Vec::new();
    for case in doc.get("cases").unwrap().arr() {
        tally.cases += 1;
        let name = case.get("name").unwrap().str();
        for problem in replay(face, case, &mut tally) {
            failures.push(format!("{} {name}: {problem}", face.file()));
        }
    }
    println!("{}: {tally:?}", face.file());
    assert!(
        failures.is_empty(),
        "{} failure(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
    tally
}

#[test]
fn total_vectors() {
    let tally = replay_file(Face::Total);
    // Every case is accounted for: a refusal, or a value written (or refused in writing).
    assert_eq!(
        tally.cases,
        tally.refusals + tally.writes + tally.write_refusals
    );
    assert!(tally.cases >= 89, "{tally:?}");
}

#[test]
fn readable_vectors() {
    let tally = replay_file(Face::Readable);
    assert_eq!(
        tally.cases,
        tally.refusals + tally.writes + tally.write_refusals
    );
    assert!(tally.cases >= 186, "{tally:?}");
    assert!(tally.origins >= 5, "{tally:?}");
}
