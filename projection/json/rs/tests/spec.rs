//! Properties of both profiles beyond the vectors: the laws over generated values, the
//! writer as the reader's mirror under generated limits, depth far past the defaults with
//! no native recursion, contribution depths the vectors do not pin, and the error and
//! origins API.

use ontos_codec::encode;
use ontos_core::Value;
use ontos_data::{
    encode_bool, encode_decimal_bytes, encode_int, encode_int_bytes, encode_list, encode_map,
    encode_null, encode_set, encode_text,
};
use ontos_json::{readable, total, Code, LimitKind, Limits, Profile, Segment, Span, UNBOUNDED};

const OPEN: Limits = Limits {
    max_text_bytes: UNBOUNDED,
    max_json_depth: None,
    max_value_depth: UNBOUNDED,
    max_atom_bytes: UNBOUNDED,
    max_tuple_arity: UNBOUNDED,
    max_integer_digits: UNBOUNDED,
};

/// A small deterministic generator (no dependencies).
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    fn bytes(&mut self, max: u64) -> Vec<u8> {
        let len = self.below(max + 1);
        (0..len).map(|_| self.next() as u8).collect()
    }

    fn text(&mut self) -> String {
        const PIECES: [&str; 14] = [
            "a", "Z", "\"", "\\", "/", "\u{0}", "\u{1f}", "\n", "\u{7f}", "é", "\u{2028}", "😀",
            "$ontos", "\u{feff}",
        ];
        let len = self.below(5);
        (0..len)
            .map(|_| PIECES[self.below(PIECES.len() as u64) as usize])
            .collect()
    }

    /// A magnitude of up to 40 bytes, minimal, around the 2⁵³ window often.
    fn magnitude(&mut self) -> Vec<u8> {
        match self.below(4) {
            0 => Vec::new(),
            1 => {
                let m: u64 = (1u64 << 53) - 2 + self.below(4);
                let be = m.to_be_bytes();
                be[be.iter().position(|&b| b != 0).unwrap()..].to_vec()
            }
            _ => {
                let mut m = self.bytes(40);
                while m.first() == Some(&0) {
                    m.remove(0);
                }
                m
            }
        }
    }

    fn value(&mut self, depth: u32) -> Value {
        let leaf = depth == 0;
        match self.below(if leaf { 7 } else { 14 }) {
            0 => Value::atom(self.bytes(6)),
            1 => encode_null(),
            2 => encode_bool(self.below(2) == 1),
            3 => encode_text(&self.text()),
            4 => {
                let m = self.magnitude();
                encode_int_bytes(!m.is_empty() && self.below(2) == 1, &m).unwrap()
            }
            5 => {
                // A decimal: a mantissa not divisible by ten, any exponent.
                let m = self.magnitude();
                let e = self.magnitude();
                let (mn, en) = (self.below(2) == 1, self.below(2) == 1);
                encode_decimal_bytes((mn && !m.is_empty(), &m), (en && !e.is_empty(), &e))
                    .unwrap_or_else(|_| encode_decimal_bytes((false, &[]), (false, &[])).unwrap())
            }
            6 => {
                // Malformed registered-label tuples and other compounds.
                const LABELS: [&[u8]; 6] = [b"int", b"decimal", b"map", b"ok", b"\xff", b""];
                let label = LABELS[self.below(6) as usize];
                Value::tuple([Value::atom(label.to_vec()), Value::atom(self.bytes(3))])
            }
            7 => {
                let n = self.below(4);
                encode_list(&(0..n).map(|_| self.value(depth - 1)).collect::<Vec<_>>())
            }
            8 | 9 => {
                let n = self.below(4);
                let mut entries: Vec<(Value, Value)> = Vec::new();
                for _ in 0..n {
                    let key = if self.below(3) > 0 {
                        encode_text(&self.text())
                    } else {
                        self.value(depth - 1)
                    };
                    if entries.iter().all(|(k, _)| encode(k) != encode(&key)) {
                        entries.push((key, self.value(depth - 1)));
                    }
                }
                encode_map(&entries).unwrap()
            }
            10 => {
                let n = self.below(4);
                let mut elems: Vec<Value> = Vec::new();
                for _ in 0..n {
                    let e = self.value(depth - 1);
                    if elems.iter().all(|x| encode(x) != encode(&e)) {
                        elems.push(e);
                    }
                }
                encode_set(&elems).unwrap()
            }
            11 => {
                // A raw tuple: empty, or led by a tuple.
                let n = self.below(3);
                let mut items = vec![Value::tuple((0..self.below(2)).map(|_| self.value(0)))];
                items.extend((0..n).map(|_| self.value(depth - 1)));
                if self.below(4) == 0 {
                    Value::tuple([])
                } else {
                    Value::tuple(items)
                }
            }
            _ => {
                let label = self.text().into_bytes();
                let n = self.below(3);
                let mut items = vec![Value::atom(label)];
                items.extend((0..n).map(|_| self.value(depth - 1)));
                Value::tuple(items)
            }
        }
    }
}

fn values(seed: u64, count: usize) -> Vec<Value> {
    let mut rng = Rng(seed);
    (0..count).map(|_| rng.value(4)).collect()
}

#[test]
fn laws_hold_over_generated_values() {
    for value in values(1, 3000) {
        // Total: R(W(v)) = v, and the output is ASCII without whitespace.
        let text = total::render_utf8(&value, &OPEN).unwrap();
        assert!(
            text.iter().all(|&b| b.is_ascii_graphic()),
            "{}",
            String::from_utf8_lossy(&text)
        );
        assert_eq!(total::parse_utf8(&text, &OPEN).unwrap(), value);
        // Readable: R(W(v)) = v and W(R(W(v))) = W(v).
        let text = readable::render_utf8(&value, &OPEN).unwrap();
        let back = readable::parse_utf8(&text, &OPEN)
            .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&text)));
        assert_eq!(
            encode(&back),
            encode(&value),
            "{}",
            String::from_utf8_lossy(&text)
        );
        assert_eq!(readable::render_utf8(&back, &OPEN).unwrap(), text);
        // Origins cover every value node, in pre-order.
        let parsed = readable::parse_utf8_with_origins(&text, &OPEN).unwrap();
        assert_eq!(parsed.value, value);
        assert_eq!(parsed.origins.len(), count_nodes(&value));
        for (path, origin) in parsed.origins.iter() {
            assert!(origin.span.start < origin.span.end && origin.span.end <= text.len());
            assert_eq!(parsed.origins.get(&path), Some(origin));
        }
    }
}

fn count_nodes(value: &Value) -> usize {
    let mut stack = vec![value];
    let mut n = 0;
    while let Some(v) = stack.pop() {
        n += 1;
        if let Value::Tuple(t) = v {
            stack.extend(t.items());
        }
    }
    n
}

fn small_limits(rng: &mut Rng) -> Limits {
    let json_depth = [None, Some(3), Some(6), Some(12)][rng.below(4) as usize];
    let mut pick = |options: &[u64]| options[rng.below(options.len() as u64) as usize];
    Limits {
        max_text_bytes: pick(&[UNBOUNDED, 20, 60, 200]),
        max_json_depth: json_depth,
        max_value_depth: pick(&[UNBOUNDED, 2, 4, 6]),
        max_atom_bytes: pick(&[UNBOUNDED, 2, 5, 9]),
        max_tuple_arity: pick(&[UNBOUNDED, 1, 2, 4]),
        max_integer_digits: pick(&[UNBOUNDED, 3, 16, 40]),
    }
}

type Render = fn(&Value, &Limits) -> Result<Vec<u8>, ontos_json::Error>;
type Parse = fn(&[u8], &Limits) -> Result<Value, ontos_json::Error>;

#[test]
fn the_writer_mirrors_the_reader() {
    // Total §9.3: the writer checks what the reader checks, so it writes `v` under `L`
    // exactly when the reader accepts `v`'s text under `L`, and then it reads back as `v`.
    let mut rng = Rng(7);
    for value in values(2, 3000) {
        let limits = small_limits(&mut rng);
        let pairs: [(Render, Parse); 2] = [
            (total::render_utf8, total::parse_utf8),
            (readable::render_utf8, readable::parse_utf8),
        ];
        for (render, parse) in pairs {
            let free = render(&value, &OPEN).unwrap();
            let written = render(&value, &limits);
            let read = parse(&free, &limits);
            assert_eq!(
                written.is_ok(),
                read.is_ok(),
                "{limits:?} {}: {written:?} / {read:?}",
                String::from_utf8_lossy(&free)
            );
            match (written, read) {
                (Ok(text), Ok(back)) => {
                    assert_eq!(text, free);
                    assert_eq!(back, value);
                }
                (Err(w), Err(r)) => {
                    assert_eq!(w.code(), Code::LimitExceeded);
                    assert!(w.span().is_none());
                    if r.code() != Code::LimitExceeded {
                        panic!("the reader refused its writer's text: {r}");
                    }
                }
                _ => unreachable!(),
            }
        }
    }
}

#[test]
fn deep_values_need_no_native_recursion() {
    // 200 000 levels, far past the defaults, under unbounded limits: every step keeps an
    // explicit stack (total §9.2), so this runs on an ordinary test thread's stack.
    const N: usize = 200_000;
    let mut value = Value::tuple([]);
    for _ in 0..N {
        value = Value::tuple([value]);
    }
    let text = total::render_utf8(&value, &OPEN).unwrap();
    assert_eq!(text.len(), N * 12 + 12);
    assert_eq!(total::parse_utf8(&text, &OPEN).unwrap(), value);
    let text = readable::render_utf8(&value, &OPEN).unwrap();
    assert!(text.starts_with(br#"{"$ontos":["raw",{"tuple":[{"tuple":["#));
    assert_eq!(readable::parse_utf8(&text, &OPEN).unwrap(), value);

    // Built by hand: the data encoders copy their children, which is quadratic here.
    let mut list = encode_list(&[]);
    let mut compound = Value::tuple([Value::atom(*b"f")]);
    let mut map = encode_null();
    for _ in 0..N / 4 {
        list = Value::tuple([Value::atom(*b"list"), list]);
        compound = Value::tuple([Value::atom(*b"f"), compound]);
        map = Value::tuple([Value::atom(*b"map"), Value::tuple([encode_null(), map])]);
    }
    for value in [list, compound, map] {
        let parsed = readable::parse_utf8_with_origins(
            &readable::render_utf8(&value, &OPEN).unwrap(),
            &OPEN,
        )
        .unwrap();
        assert_eq!(parsed.value, value);
        assert_eq!(parsed.origins.len(), count_nodes(&value));
    }

    // The derived JSON depth is unbounded when the value depth is.
    let deep_array = "[".repeat(N) + &"]".repeat(N);
    assert!(readable::parse_utf8(deep_array.as_bytes(), &OPEN).is_ok());
}

/// A refusal's code, path, span and kind.
type Refusal = (
    Code,
    Vec<Segment>,
    Option<(usize, usize)>,
    Option<LimitKind>,
);

fn refusal(result: Result<Value, ontos_json::Error>) -> Refusal {
    let e = result.expect_err("refused");
    (
        e.code(),
        e.path().to_vec(),
        e.span().map(|s| (s.start, s.end)),
        e.kind(),
    )
}

#[test]
fn an_objects_keys_lie_two_and_three_levels_down() {
    // Readable §4.9: an object at depth d contributes its key texts' tuples at d + 2 and
    // their atoms at d + 3, so `{"a":1}` needs value depth 3, for the reader and the writer.
    let limits = |v| Limits {
        max_value_depth: v,
        ..readable::DEFAULT_LIMITS
    };
    assert!(readable::parse_utf8(br#"{"a":1}"#, &limits(3)).is_ok());
    assert_eq!(
        refusal(readable::parse_utf8(br#"{"a":1}"#, &limits(2))),
        (
            Code::LimitExceeded,
            vec![],
            Some((0, 7)),
            Some(LimitKind::DecodeDepth)
        )
    );
    let value = encode_map(&[(encode_text("a"), encode_int(1))]).unwrap();
    assert!(readable::render_utf8(&value, &limits(3)).is_ok());
    let e = readable::render_utf8(&value, &limits(2)).unwrap_err();
    assert_eq!(
        (e.code(), e.kind()),
        (Code::LimitExceeded, Some(LimitKind::DecodeDepth))
    );
    // The empty object contributes only the map tuple and its label, at d and d + 1.
    assert!(readable::parse_utf8(b"{}", &limits(1)).is_ok());
    assert!(readable::parse_utf8(b"{}", &limits(0)).is_err());
    // A map tag's entry tuples lie at d + 1; its keys and values are its children at d + 2.
    let tagged = br#"{"$ontos":["map",[[1,2]]]}"#;
    assert!(readable::parse_utf8(tagged, &limits(3)).is_ok());
    assert_eq!(
        refusal(readable::parse_utf8(tagged, &limits(2))),
        (
            Code::LimitExceeded,
            vec![
                Segment::Name("$ontos".into()),
                Segment::Index(1),
                Segment::Index(0),
                Segment::Index(0)
            ],
            Some((19, 20)),
            Some(LimitKind::DecodeDepth)
        )
    );
}

#[test]
fn contributions_by_node() {
    // One case per arm of readable §4.9 at the edge of max_value_depth: accepted at the
    // depth the arm's deepest node needs, refused one below it.
    let cases: [(&[u8], u64); 11] = [
        (b"null", 1),
        (b"true", 1),
        (br#""x""#, 1),
        (b"7", 1),
        (b"[]", 1),
        (br#"{"$ontos":["bytes","AA=="]}"#, 0),
        (br#"{"$ontos":["int","9007199254740993"]}"#, 1),
        (br#"{"$ontos":["decimal","1","2"]}"#, 2),
        (br#"{"$ontos":["set",[]]}"#, 1),
        (br#"{"$ontos":["compound","f",[]]}"#, 1),
        (br#"{"$ontos":["raw",{"tuple":[]}]}"#, 0),
    ];
    for (text, need) in cases {
        let limits = |v| Limits {
            max_value_depth: v,
            ..readable::DEFAULT_LIMITS
        };
        let value = readable::parse_utf8(text, &limits(need)).unwrap();
        assert_eq!(readable::render_utf8(&value, &limits(need)).unwrap(), text);
        if need > 0 {
            let (code, path, span, kind) = refusal(readable::parse_utf8(text, &limits(need - 1)));
            assert_eq!(
                (code, kind),
                (Code::LimitExceeded, Some(LimitKind::DecodeDepth))
            );
            assert_eq!((path, span), (vec![], Some((0, text.len()))));
            let e = readable::render_utf8(&value, &limits(need - 1)).unwrap_err();
            assert_eq!(e.kind(), Some(LimitKind::DecodeDepth));
        }
    }
}

#[test]
fn integers_beyond_every_host_width() {
    // 2^400 and its neighbours, spelled by repeated doubling in decimal text: nothing here
    // shares the crate's conversion.
    fn double(digits: &str) -> String {
        let mut out = Vec::new();
        let mut carry = 0;
        for c in digits.bytes().rev() {
            let d = (c - b'0') * 2 + carry;
            out.push(b'0' + d % 10);
            carry = d / 10;
        }
        if carry > 0 {
            out.push(b'0' + carry);
        }
        out.reverse();
        String::from_utf8(out).unwrap()
    }
    let mut digits = "1".to_owned();
    for bits in 1..=400 {
        digits = double(&digits);
        let mut magnitude = vec![0u8; bits / 8 + 1];
        magnitude[0] = 1 << (bits % 8);
        for negative in [false, true] {
            let value = encode_int_bytes(negative, &magnitude).unwrap();
            let sign = if negative { "-" } else { "" };
            let text = readable::render_utf8(&value, &readable::DEFAULT_LIMITS).unwrap();
            let want = if bits < 53 {
                format!("{sign}{digits}")
            } else {
                format!(r#"{{"$ontos":["int","{sign}{digits}"]}}"#)
            };
            assert_eq!(String::from_utf8(text).unwrap(), want);
            assert_eq!(
                readable::parse_utf8(want.as_bytes(), &readable::DEFAULT_LIMITS).unwrap(),
                value
            );
        }
    }
}

#[test]
fn integer_digits_are_bounded_both_ways() {
    let nines = "9".repeat(50);
    let tagged = format!(r#"{{"$ontos":["int","{nines}"]}}"#);
    let limits = |g| Limits {
        max_integer_digits: g,
        ..readable::DEFAULT_LIMITS
    };
    let value = readable::parse_utf8(tagged.as_bytes(), &limits(50)).unwrap();
    assert_eq!(
        readable::render_utf8(&value, &limits(50)).unwrap(),
        tagged.as_bytes()
    );
    for g in [0, 1, 15, 49] {
        let e = readable::render_utf8(&value, &limits(g)).unwrap_err();
        assert_eq!(e.kind(), Some(LimitKind::IntegerDigits));
        assert_eq!(
            refusal(readable::parse_utf8(tagged.as_bytes(), &limits(g))).3,
            Some(LimitKind::IntegerDigits)
        );
    }
    // A decimal counts the larger of its two components.
    let decimal = format!(r#"{{"$ontos":["decimal","7","-{nines}"]}}"#);
    let value = readable::parse_utf8(decimal.as_bytes(), &limits(50)).unwrap();
    assert_eq!(
        readable::render_utf8(&value, &limits(50)).unwrap(),
        decimal.as_bytes()
    );
    assert_eq!(
        readable::render_utf8(&value, &limits(49))
            .unwrap_err()
            .kind(),
        Some(LimitKind::IntegerDigits)
    );
    // The total profile never checks it.
    assert!(total::render_utf8(
        &value,
        &Limits {
            max_integer_digits: 0,
            ..total::DEFAULT_LIMITS
        }
    )
    .is_ok());
}

#[test]
fn text_bytes_bound_the_writer_at_the_last_byte() {
    for value in values(3, 300) {
        for (render, defaults) in [
            (
                total::render_utf8 as fn(&Value, &Limits) -> _,
                total::DEFAULT_LIMITS,
            ),
            (readable::render_utf8, readable::DEFAULT_LIMITS),
        ] {
            let free = render(&value, &OPEN).unwrap();
            let at = |n: usize| Limits {
                max_text_bytes: n as u64,
                max_value_depth: UNBOUNDED,
                ..defaults
            };
            assert_eq!(render(&value, &at(free.len())).unwrap(), free);
            let e = render(&value, &at(free.len() - 1)).unwrap_err();
            assert_eq!(e.kind(), Some(LimitKind::TextBytes));
        }
    }
}

#[test]
fn the_error_record() {
    let e = total::parse_utf8(b"[1,]", &total::DEFAULT_LIMITS).unwrap_err();
    assert_eq!(e.profile(), Profile::Total);
    assert_eq!(e.profile().id(), "ontos-total-json/1");
    assert_eq!(e.code(), Code::InvalidJson);
    assert_eq!(e.code().as_str(), "invalid_json");
    assert_eq!(e.path(), &[Segment::Index(1)]);
    assert_eq!(e.span(), Some(Span { start: 3, end: 4 }));
    assert_eq!(e.kind(), None);
    assert!(!e.message().is_empty());
    let shown = e.to_string();
    assert!(
        shown.starts_with("ontos-total-json/1: invalid_json at [1], bytes 3..4: "),
        "{shown}"
    );

    let e = readable::parse_utf8(br#"{"0":[1.5]}"#, &readable::DEFAULT_LIMITS).unwrap_err();
    assert_eq!(e.profile().id(), "ontos-readable-json/1");
    assert_eq!(e.code().as_str(), "invalid_number");
    // A member named "0" stays a name.
    assert_eq!(e.path(), &[Segment::Name("0".into()), Segment::Index(0)]);

    let e = readable::render_utf8(
        &encode_list(&[encode_null()]),
        &Limits {
            max_json_depth: Some(0),
            ..readable::DEFAULT_LIMITS
        },
    )
    .unwrap_err();
    assert_eq!(
        (e.code().as_str(), e.kind().map(LimitKind::as_str)),
        ("limit_exceeded", Some("json_depth"))
    );
    assert_eq!(e.span(), None);
    assert!(e.to_string().contains("(json_depth)"));
}

#[test]
fn origins_lookups() {
    let text = br#"{"b":[true],"a":{"$ontos":["bytes","AA=="]}}"#;
    let parsed = readable::parse_utf8_with_origins(text, &readable::DEFAULT_LIMITS).unwrap();
    // Entry 1 in codec order is "a" (shorter keys first, then bytewise): its value, the atom.
    let origin = parsed.origins.get(&[1, 1]).unwrap();
    assert_eq!(origin.path, vec![Segment::Name("a".into())]);
    assert_eq!(
        &text[origin.span.start..origin.span.end],
        br#"{"$ontos":["bytes","AA=="]}"#
    );
    // The list element `true` (entry 2, value, child 1).
    let origin = parsed.origins.get(&[2, 1, 1, 0]).unwrap();
    assert_eq!(
        origin.path,
        vec![Segment::Name("b".into()), Segment::Index(0)]
    );
    assert_eq!(&text[origin.span.start..origin.span.end], b"true");
    assert_eq!(parsed.origins.get(&[3]), None);
    assert_eq!(
        parsed.origins.get(&[1, 1, 0]),
        None,
        "an atom has no children"
    );
    assert_eq!(parsed.origins.iter().count(), parsed.origins.len());
    assert!(format!("{:?}", parsed.origins).starts_with("[([], Origin"));
}

#[test]
fn derived_json_depth_follows_the_value_depth() {
    // Total: 2v + 2. Readable: 3v + 4. An explicit bound overrides the derivation.
    let total_at = |v| Limits {
        max_value_depth: v,
        ..total::DEFAULT_LIMITS
    };
    let readable_at = |v| Limits {
        max_value_depth: v,
        ..readable::DEFAULT_LIMITS
    };
    for v in [0u64, 1, 5, 10] {
        let ok = "[".repeat(2 * v as usize + 2);
        let over = "[".repeat(2 * v as usize + 3);
        assert_ne!(
            refusal(total::parse_utf8(ok.as_bytes(), &total_at(v))).3,
            Some(LimitKind::JsonDepth)
        );
        assert_eq!(
            refusal(total::parse_utf8(over.as_bytes(), &total_at(v))).3,
            Some(LimitKind::JsonDepth)
        );
        let ok = "[".repeat(3 * v as usize + 4);
        let over = "[".repeat(3 * v as usize + 5);
        assert_ne!(
            refusal(readable::parse_utf8(ok.as_bytes(), &readable_at(v))).3,
            Some(LimitKind::JsonDepth)
        );
        assert_eq!(
            refusal(readable::parse_utf8(over.as_bytes(), &readable_at(v))).3,
            Some(LimitKind::JsonDepth)
        );
    }
    let explicit = Limits {
        max_json_depth: Some(1),
        ..readable::DEFAULT_LIMITS
    };
    assert_eq!(
        refusal(readable::parse_utf8(b"[[]]", &explicit)).3,
        Some(LimitKind::JsonDepth)
    );
    let explicit = Limits {
        max_json_depth: Some(UNBOUNDED),
        max_value_depth: 0,
        ..total::DEFAULT_LIMITS
    };
    // A higher explicit bound moves the refusal of a value too deep to stage 4.
    assert_eq!(
        refusal(total::parse_utf8(br#"{"tuple":[{"tuple":[]}]}"#, &explicit)).3,
        Some(LimitKind::DecodeDepth)
    );
}
