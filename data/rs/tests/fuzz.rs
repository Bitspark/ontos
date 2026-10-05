//! Property / fuzz tests for the `ontos-data` (L2) recognizers.
//!
//! The recognizers consume **already-decoded** L0 `Value` trees that may be
//! adversarial (a hostile peer can hand a consumer any well-formed L0 value), so
//! the headline invariant is *recognition never panics*: on any `Value` each
//! `read_*` / `recognize_int` must return its datum or a typed [`DataError`], never
//! index out of bounds, never `unwrap` a `None`, never overflow-panic. These tests
//! drive that with a large volume of pseudo-random, embedding-biased `Value`s.
//!
//! Five properties are exercised (the L2 analogue of the codec's P1/P2/P3):
//!   * **D1 — total recognition.** Every recognizer returns `Ok`/`Err(DataError)` on
//!     any input, never panics. (Enforced implicitly: a panic aborts the test.)
//!   * **D2 — read is canonical.** Recognition is partial and accepts only the
//!     canonical form, so whenever `read_<kind>(v)` succeeds,
//!     `encode_<kind>(read_<kind>(v)) == v` must hold exactly.
//!   * **D3 — round-trip on produced data.** For a randomly generated typed datum,
//!     `read_<kind>(encode_<kind>(datum)) == datum`.
//!   * **D4 — recognize/read agreement (ontos-internal#67/#77).** Recognition is structural,
//!     so `recognize_int(v).is_ok()` iff `read_int(v)` is `Ok` *or* `IntOutOfRange`
//!     (a `>i128` int is recognized though it cannot materialize).
//!   * **D5 — at most one kind.** The eight labels are disjoint, so a value is a
//!     well-formed embedding of at most one kind.
//!
//! Everything here is **dependency-free** (the repo ethos): randomness comes from a
//! hand-rolled 64-bit LCG seeded from a constant (the same generator the codec fuzz
//! uses), so runs are fully deterministic and reproducible. No `proptest` /
//! `quickcheck` / `arbitrary`. The Go core adds a coverage-guided native `FuzzData`
//! target on top (see `data/go/fuzz_test.go` + `.github/workflows/fuzz.yml`); rs/ts
//! deliberately stop at these fixed-iteration property tests, exactly as the codec
//! layer does, so the cargo workspace and stable CI stay clean and nightly-free.

use ontos_codec::encode as codec_encode;
use ontos_core::Value;
use ontos_data::{
    encode_bool, encode_decimal, encode_int, encode_list, encode_map, encode_null, encode_set,
    encode_text, read_bool, read_decimal, read_int, read_list, read_map, read_null, read_set,
    read_text, recognize_decimal, recognize_int, recognize_null, DataError,
};

// ----- hand-rolled deterministic PRNG (64-bit LCG, MMIX constants) -----

struct Lcg {
    state: u64,
}

impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg { state: seed }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self
            .state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.state
    }

    fn next_byte(&mut self) -> u8 {
        (self.next_u64() >> 56) as u8
    }

    /// A value in `0..bound` (`bound` must be non-zero). High bits, modulo bound.
    fn below(&mut self, bound: u32) -> u32 {
        ((self.next_u64() >> 32) as u32) % bound
    }

    fn bool(&mut self) -> bool {
        (self.next_u64() >> 63) & 1 == 1
    }

    /// A full-range `i128` assembled from two 64-bit draws (covers negatives).
    fn next_i128(&mut self) -> i128 {
        let hi = u128::from(self.next_u64());
        let lo = u128::from(self.next_u64());
        ((hi << 64) | lo) as i128
    }
}

// ----- generators -----

/// The eight registered labels plus a sprinkling of near-miss / random labels, so the
/// embedding-biased generator produces both well-labeled and mislabeled compounds.
const LABELS: [&[u8]; 8] = [
    b"int",
    b"utf8-text",
    b"bool",
    b"list",
    b"map",
    b"set",
    b"decimal",
    b"null",
];

fn random_label(rng: &mut Lcg) -> Vec<u8> {
    // 75% a real registered label (reach the recognizers' validation paths), 25% a
    // random short atom (mislabeled / bare compounds that must be not-recognized).
    if rng.below(4) != 0 {
        LABELS[rng.below(LABELS.len() as u32) as usize].to_vec()
    } else {
        let len = rng.below(5) as usize;
        (0..len).map(|_| rng.next_byte()).collect()
    }
}

/// A random atom payload, drawn from a small alphabet half the time so that scalar
/// payloads (sign bytes, bool markers, short magnitudes) form *valid* canonical
/// forms often enough to keep D2 non-vacuous, and uniform bytes the other half for
/// breadth.
fn random_atom_bytes(rng: &mut Lcg) -> Vec<u8> {
    let len = rng.below(10) as usize;
    if rng.bool() {
        (0..len).map(|_| (rng.next_u64() & 0x03) as u8).collect()
    } else {
        (0..len).map(|_| rng.next_byte()).collect()
    }
}

/// A random, **embedding-biased** `Value`. Tuples are frequently label-headed (first
/// child a registered-or-random label atom) and their tails are a mix of plain
/// values and arity-2 `Tuple(key, value)` entries, so `read_map`'s entry/sort/dup
/// paths and `read_int`'s sign/magnitude paths are actually reached — a uniform-random
/// tree almost never starts with `Atom("map")`.
fn random_value(rng: &mut Lcg, depth: u32) -> Value {
    if depth == 0 || rng.below(5) < 2 {
        return Value::atom(random_atom_bytes(rng));
    }
    let labeled = rng.below(4) != 0; // 75% labeled compounds
    let arity = rng.below(5) as usize; // 0..=4 tail children
    let mut items = Vec::with_capacity(arity + usize::from(labeled));
    if labeled {
        items.push(Value::atom(random_label(rng)));
    }
    for _ in 0..arity {
        // Half the tail children are arity-2 entry tuples (map-entry shaped), half
        // are arbitrary sub-values.
        if rng.bool() {
            items.push(Value::tuple(vec![
                random_value(rng, depth - 1),
                random_value(rng, depth - 1),
            ]));
        } else {
            items.push(random_value(rng, depth - 1));
        }
    }
    Value::tuple(items)
}

/// A random valid UTF-8 string from a curated alphabet (ASCII + a few multi-byte
/// scalars) so `utf8-text` round-trips exactly.
fn random_string(rng: &mut Lcg) -> String {
    const ALPHABET: [char; 10] = ['a', 'Z', '0', ' ', '_', '\n', 'é', 'ß', '日', '😀'];
    let len = rng.below(12) as usize;
    (0..len)
        .map(|_| ALPHABET[rng.below(ALPHABET.len() as u32) as usize])
        .collect()
}

/// `n` pairwise-distinct atom keys (`[0], [1], …`), so `encode_map`/`encode_set` never
/// hit the duplicate precondition. `n` is bounded well under 256.
fn distinct_atoms(n: usize) -> Vec<Value> {
    (0..n).map(|i| Value::atom(vec![i as u8])).collect()
}

/// A freshly built, guaranteed-canonical embedding of a random kind. Feeding these
/// into the recognizer sweep keeps D2/D4 non-vacuous (a value that *is* recognized).
fn valid_embedding(rng: &mut Lcg) -> Value {
    match rng.below(8) {
        0 => encode_int(rng.next_i128()),
        1 => encode_text(&random_string(rng)),
        2 => encode_bool(rng.bool()),
        3 => {
            let arity = rng.below(5) as usize;
            let elems: Vec<Value> = (0..arity).map(|_| random_value(rng, 2)).collect();
            encode_list(&elems)
        }
        4 => {
            let arity = rng.below(5) as usize;
            let keys = distinct_atoms(arity);
            let entries: Vec<(Value, Value)> = keys
                .into_iter()
                .map(|k| (k, random_value(rng, 2)))
                .collect();
            encode_map(&entries).expect("distinct keys never collide")
        }
        5 => {
            let arity = rng.below(5) as usize;
            // Distinct elements: distinct single-byte atoms keep encode_set happy.
            encode_set(&distinct_atoms(arity)).expect("distinct elements never collide")
        }
        6 => encode_decimal(rng.next_i128(), random_small_exponent(rng))
            .expect("a -20..=20 exponent never overflows the i128 normalization"),
        // null: the single inhabitant Tuple(Atom("null")) (§5.10).
        _ => encode_null(),
    }
}

/// A small exponent in `-20..=20` for decimal generators. Kept small so the producer's
/// trailing-zero normalization (which can only *raise* the exponent, by < 40 for an
/// i128 mantissa) cannot overflow.
fn random_small_exponent(rng: &mut Lcg) -> i128 {
    (rng.below(41) as i128) - 20
}

/// A canonical `decimal` whose MANTISSA is wider than i128, so `recognize_decimal`
/// accepts it while `read_decimal` returns `IntOutOfRange` — the decimal-layer analog of
/// `wide_int`, exercising D4's `IntOutOfRange` arm for `decimal`. The mantissa's last
/// magnitude byte is forced odd, so the mantissa is odd and hence NOT divisible by 10
/// (canonical, not a trailing-zero reject).
fn wide_decimal(rng: &mut Lcg) -> Value {
    let sign = if rng.bool() { 0x01u8 } else { 0x00u8 };
    let extra = rng.below(4) as usize;
    let mut payload = vec![sign, 0x01];
    for _ in 0..(15 + extra) {
        payload.push(rng.next_byte());
    }
    payload.push(rng.next_byte() | 0x01); // odd => mantissa not divisible by 10
    let mantissa = Value::tuple(vec![Value::atom(b"int".to_vec()), Value::atom(payload)]);
    Value::tuple(vec![
        Value::atom(b"decimal".to_vec()),
        mantissa,
        encode_int(random_small_exponent(rng)),
    ])
}

/// A canonical `int` whose magnitude is WIDER than `i128` (17..=20 magnitude bytes),
/// built directly from raw bytes because `encode_int` is `i128`-typed and can never
/// produce one. The leading magnitude byte is non-zero (`0x01`), so the form is
/// minimal/canonical: `recognize_int` accepts it while `read_int` returns
/// `IntOutOfRange`. This is the only generator that exercises the recognize-vs-
/// materialize split (ontos-internal#67/#77); without it D4's `IntOutOfRange` arm is dead.
fn wide_int(rng: &mut Lcg) -> Value {
    let sign = if rng.bool() { 0x01u8 } else { 0x00u8 };
    let extra = rng.below(4) as usize; // magnitude length 17..=20 bytes (> 16 = u128)
    let mut payload = vec![sign, 0x01];
    for _ in 0..(16 + extra) {
        payload.push(rng.next_byte());
    }
    Value::tuple(vec![Value::atom(b"int".to_vec()), Value::atom(payload)])
}

// ----- shared checker -----

/// Run every recognizer on `v` and assert D1, D2, D4, D5. Returns the number of
/// kinds that recognized `v` (must be <= 1 by D5). Never panics for any `v` (D1):
/// reaching the end of this function *is* the D1 witness.
fn check_recognizers(v: &Value) -> u32 {
    let mut matched = 0u32;

    // int — D2 (encode∘read == v) and D4 (recognize iff read-or-resource-limit).
    let read = read_int(v);
    if let Ok(n) = read {
        assert_eq!(
            encode_int(n),
            *v,
            "D2: encode_int(read_int(v)) != v for {v}"
        );
        matched += 1;
    }
    let recognized_int = recognize_int(v).is_ok();
    let read_or_limit = matches!(read, Ok(_) | Err(DataError::IntOutOfRange));
    assert_eq!(
        recognized_int, read_or_limit,
        "D4: recognize_int disagrees with read_int (incl IntOutOfRange) for {v}"
    );

    // utf8-text
    if let Ok(s) = read_text(v) {
        assert_eq!(
            encode_text(&s),
            *v,
            "D2: encode_text(read_text(v)) != v for {v}"
        );
        matched += 1;
    }
    // bool
    if let Ok(b) = read_bool(v) {
        assert_eq!(
            encode_bool(b),
            *v,
            "D2: encode_bool(read_bool(v)) != v for {v}"
        );
        matched += 1;
    }
    // list
    if let Ok(elems) = read_list(v) {
        assert_eq!(
            encode_list(&elems),
            *v,
            "D2: encode_list(read_list(v)) != v for {v}"
        );
        matched += 1;
    }
    // map — read_map only succeeds on strictly-ascending, dup-free entries, so the
    // re-encode cannot hit DuplicateKey; an Err here would be a real defect.
    if let Ok(entries) = read_map(v) {
        let re = encode_map(&entries).expect("D2: re-encoding read_map output must not error");
        assert_eq!(re, *v, "D2: encode_map(read_map(v)) != v for {v}");
        matched += 1;
    }
    // set
    if let Ok(elems) = read_set(v) {
        let re = encode_set(&elems).expect("D2: re-encoding read_set output must not error");
        assert_eq!(re, *v, "D2: encode_set(read_set(v)) != v for {v}");
        matched += 1;
    }
    // decimal — D2 (encode∘read == v) and D4 (recognize iff read-or-resource-limit),
    // mirroring int: a > i128 mantissa/exponent is RECOGNIZED but read_decimal reports
    // IntOutOfRange. read_decimal succeeds => the value is a recognized canonical decimal.
    let read_dec = read_decimal(v);
    if let Ok((mantissa, exponent)) = read_dec {
        // Re-encoding a recognized canonical decimal: its mantissa is not divisible by 10,
        // so normalization strips nothing and the exponent carry never runs — no overflow.
        assert_eq!(
            encode_decimal(mantissa, exponent)
                .expect("re-encoding a canonical decimal cannot overflow"),
            *v,
            "D2: encode_decimal(read_decimal(v)) != v for {v}"
        );
        matched += 1;
    }
    let recognized_dec = recognize_decimal(v).is_ok();
    let dec_read_or_limit = matches!(read_dec, Ok(_) | Err(DataError::IntOutOfRange));
    assert_eq!(
        recognized_dec, dec_read_or_limit,
        "D4: recognize_decimal disagrees with read_decimal (incl IntOutOfRange) for {v}"
    );
    // null — D2 (encode_null() == v) and D4 (recognize iff read). null carries no payload,
    // so recognize and read coincide; a recognized null re-encodes to the single inhabitant.
    let read_null_ok = read_null(v).is_ok();
    if read_null_ok {
        assert_eq!(encode_null(), *v, "D2: encode_null() != v for {v}");
        matched += 1;
    }
    assert_eq!(
        recognize_null(v).is_ok(),
        read_null_ok,
        "D4: recognize_null disagrees with read_null for {v}"
    );

    assert!(
        matched <= 1,
        "D5: value recognized as {matched} kinds (labels must be disjoint) for {v}"
    );
    matched
}

// ----- the tests -----

/// **D1 + D2 + D4 + D5.** Throw ~30k embedding-biased random `Value`s — half freshly
/// built canonical embeddings, half arbitrary trees — at every recognizer. None may
/// panic; every successful read must re-encode to the exact value; recognize_int must
/// agree with read_int; and no value may be two kinds at once.
#[test]
fn recognizers_never_panic_and_reads_are_canonical() {
    const ITERATIONS: usize = 30_000;
    const MAX_DEPTH: u32 = 4;

    let mut rng = Lcg::new(0xDA7A_F022_5EED_0001);
    let mut recognized = 0usize;
    // Count values RECOGNIZED as int yet not MATERIALIZABLE (> i128) — the
    // recognize-vs-read split (ontos-internal#67/#77). D4 is only meaningful if this case is reached.
    let mut recognized_but_unmaterializable = 0usize;
    // The same split, at the decimal layer (a > i128 mantissa): recognize_decimal Ok
    // while read_decimal is IntOutOfRange (§5.9). Keeps decimal's D4 arm non-vacuous.
    let mut decimal_recognized_but_unmaterializable = 0usize;

    for i in 0..ITERATIONS {
        // Cycle four sources: a guaranteed-canonical embedding (keeps D2/D4 non-vacuous),
        // a > i128 "wide" int (drives read_int's IntOutOfRange arm, which the i128-typed
        // encode_int can never reach), a > i128 "wide" decimal (the same arm for
        // read_decimal), and an arbitrary embedding-biased tree (breadth).
        let v = match i % 4 {
            0 => valid_embedding(&mut rng),
            1 => wide_int(&mut rng),
            2 => wide_decimal(&mut rng),
            _ => random_value(&mut rng, MAX_DEPTH),
        };
        recognized += check_recognizers(&v) as usize;
        if recognize_int(&v).is_ok() && matches!(read_int(&v), Err(DataError::IntOutOfRange)) {
            recognized_but_unmaterializable += 1;
        }
        if recognize_decimal(&v).is_ok()
            && matches!(read_decimal(&v), Err(DataError::IntOutOfRange))
        {
            decimal_recognized_but_unmaterializable += 1;
        }
    }

    // Sanity: the canonical embeddings alone guarantee plenty of recognitions, so a
    // regression that rejects everything (making D2/D4 vacuous) trips this.
    assert!(
        recognized > 0,
        "expected some values to be recognized; got 0 of {ITERATIONS} (D2/D4 vacuous)"
    );
    // The > i128 recognize-Ok / read-IntOutOfRange case MUST be exercised, else D4's
    // IntOutOfRange arm is dead and certifies a tautology (it would still pass if
    // recognize_int wrongly REJECTED a > i128 int, diverging from §5.1).
    assert!(
        recognized_but_unmaterializable > 0,
        "D4: the recognize-Ok / read-IntOutOfRange (> i128) case was never exercised"
    );
    // The decimal-layer split must also be exercised, else decimal's D4 IntOutOfRange
    // arm is dead (it would still pass if recognize_decimal wrongly REJECTED a > i128
    // mantissa, diverging from §5.9).
    assert!(
        decimal_recognized_but_unmaterializable > 0,
        "D4: the decimal recognize-Ok / read-IntOutOfRange (> i128 mantissa) case was never exercised"
    );
    eprintln!(
        "recognizers_never_panic: {ITERATIONS} values, {recognized} recognized, \
         {recognized_but_unmaterializable} int + {decimal_recognized_but_unmaterializable} decimal \
         recognized-but-unmaterializable (> i128)"
    );
}

/// **D1.** Feed values built by `codec`-decoding arbitrary-but-tag-biased byte
/// buffers (the genuine "decoded untrusted bytes" path) into every recognizer. This
/// is the exact threat model — a peer hands you bytes, you decode them, then probe
/// for embeddings. Decode failures are skipped (that is the codec's own test); the
/// point here is that recognition of *whatever decoded* never panics.
#[test]
fn recognizers_total_on_decoded_untrusted_bytes() {
    use ontos_codec::decode;
    const ITERATIONS: usize = 30_000;
    const MAX_LEN: usize = 48;

    let mut rng = Lcg::new(0xDA7A_F022_5EED_0002);
    let mut decoded = 0usize;
    let mut recognized = 0usize;

    for i in 0..ITERATIONS {
        let buf = if i % 2 == 0 {
            // A real encoded embedding-biased value: always decodes, so the sweep
            // reaches the recognizers on genuinely recognizable structure (not just
            // D1 no-panic on garbage that decodes to a bare atom/tuple).
            codec_encode(&random_value(&mut rng, 4))
        } else {
            // Small-alphabet bytes: hit the 0x00/0x01 tags + short uvarints so plenty
            // decode, exercising D1 on arbitrary decoded structure.
            let len = rng.below(MAX_LEN as u32 + 1) as usize;
            (0..len).map(|_| (rng.next_u64() & 0x07) as u8).collect()
        };
        if let Ok(v) = decode(&buf) {
            decoded += 1;
            recognized += check_recognizers(&v) as usize;
        }
    }
    assert!(
        decoded > 0,
        "expected buffers to decode for the recognizer sweep"
    );
    assert!(
        recognized > 0,
        "expected some decoded values to be recognized (sweep not vacuous)"
    );
    eprintln!("recognizers_total_on_decoded_bytes: {decoded} decoded, {recognized} recognized");
}

/// **D3.** For each kind, generate a random typed datum, encode it, read it back, and
/// assert equality (and that re-encoding is a fixpoint, tying D3 to D2).
#[test]
fn produced_data_round_trips() {
    const ITERATIONS: usize = 10_000;
    let mut rng = Lcg::new(0xDA7A_F022_5EED_0003);

    for _ in 0..ITERATIONS {
        // int
        let n = rng.next_i128();
        let v = encode_int(n);
        assert_eq!(read_int(&v).unwrap(), n, "D3 int");
        assert_eq!(
            codec_encode(&encode_int(read_int(&v).unwrap())),
            codec_encode(&v)
        );

        // utf8-text
        let s = random_string(&mut rng);
        let v = encode_text(&s);
        assert_eq!(read_text(&v).unwrap(), s, "D3 text");

        // bool
        let b = rng.bool();
        assert_eq!(read_bool(&encode_bool(b)).unwrap(), b, "D3 bool");

        // list (elements are arbitrary L0 values, returned verbatim)
        let arity = rng.below(5) as usize;
        let elems: Vec<Value> = (0..arity).map(|_| random_value(&mut rng, 2)).collect();
        let v = encode_list(&elems);
        assert_eq!(read_list(&v).unwrap(), elems, "D3 list");

        // map (distinct keys; read returns canonical sorted order, so compare via
        // the canonical value: encode_map(read_map(v)) == v)
        let arity = rng.below(5) as usize;
        let entries: Vec<(Value, Value)> = distinct_atoms(arity)
            .into_iter()
            .map(|k| (k, random_value(&mut rng, 2)))
            .collect();
        let v = encode_map(&entries).unwrap();
        assert_eq!(encode_map(&read_map(&v).unwrap()).unwrap(), v, "D3 map");

        // set (distinct elements)
        let arity = rng.below(5) as usize;
        let v = encode_set(&distinct_atoms(arity)).unwrap();
        assert_eq!(encode_set(&read_set(&v).unwrap()).unwrap(), v, "D3 set");

        // decimal (read returns the producer-normalized pair, so compare via the
        // canonical value: encode_decimal(read_decimal(v)) == v)
        let v = encode_decimal(rng.next_i128(), random_small_exponent(&mut rng))
            .expect("a -20..=20 exponent never overflows the i128 normalization");
        let (m, e) = read_decimal(&v).unwrap();
        assert_eq!(
            encode_decimal(m, e).expect("re-encoding a canonical decimal cannot overflow"),
            v,
            "D3 decimal"
        );

        // null (the single inhabitant round-trips to itself)
        let v = encode_null();
        assert!(read_null(&v).is_ok(), "D3 null");
        assert_eq!(encode_null(), v, "D3 null");
    }
    eprintln!("produced_data_round_trips: {ITERATIONS} iterations across all eight kinds");
}
