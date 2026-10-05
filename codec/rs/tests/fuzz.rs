//! Property / fuzz tests for the security-critical `ontos-codec` decoder.
//!
//! The codec decodes **untrusted** bytes, so the headline invariant is *decode
//! never panics*: on any input it must return `Ok(value)` or `Err(DecodeError)`,
//! never index out of bounds, never overflow-panic, never `unwrap` on a `None`.
//! These tests drive that with a large volume of pseudo-random input.
//!
//! Three properties are exercised:
//!   * **P1 — total decode.** `decode(arbitrary_bytes)` returns `Ok`/`Err`, never
//!     panics. (Enforced implicitly: a panic aborts the test process.)
//!   * **P2 — canonical idempotence.** The codec accepts *only* canonical bytes, so
//!     whenever `decode(b)` succeeds, `encode(decode(b)) == b` must hold exactly.
//!   * **P3 — round-trip.** For randomly generated valid `Value` trees,
//!     `decode(encode(v)) == v`.
//!
//! Everything here is **dependency-free** (the repo ethos): randomness comes from a
//! hand-rolled 64-bit LCG seeded from a constant, so runs are fully deterministic
//! and reproducible. No `proptest` / `quickcheck` / `arbitrary` / `fast-check`.
//!
//! These run on **stable** Rust with no extra crates. A coverage-guided
//! `cargo-fuzz` target (libFuzzer) could be added later under `codec/rs/fuzz` for
//! deeper, mutation-driven exploration; it is intentionally *not* added here so the
//! cargo workspace and stable CI stay clean and nightly-free.

use ontos_codec::{decode, encode};
use ontos_core::Value;

// ----- hand-rolled deterministic PRNG (64-bit LCG) -----

/// A tiny linear congruential generator. The multiplier/increment are the
/// well-known Knuth/MMIX 64-bit LCG constants; we only ever consume the high
/// bits, which is where an LCG has acceptable quality. Deterministic by design:
/// the same seed always replays the same sequence, so any failure is reproducible.
struct Lcg {
    state: u64,
}

impl Lcg {
    fn new(seed: u64) -> Self {
        Lcg { state: seed }
    }

    /// Advance and return the next raw 64-bit state.
    fn next_u64(&mut self) -> u64 {
        // MMIX by Knuth: state = state * a + c (mod 2^64), wrapping.
        self.state = self
            .state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.state
    }

    /// A byte drawn from the high bits (better mixed than the low bits).
    fn next_byte(&mut self) -> u8 {
        (self.next_u64() >> 56) as u8
    }

    /// A value in `0..bound` (`bound` must be non-zero). High bits, modulo bound.
    fn below(&mut self, bound: u32) -> u32 {
        ((self.next_u64() >> 32) as u32) % bound
    }
}

// ----- random generators -----

/// A random byte buffer of length `0..=max_len`, every byte uniform over
/// `0x00..=0xff`. This is the worst case for the decoder (arbitrary attacker
/// input) and the primary driver for **P1**.
fn random_bytes(rng: &mut Lcg, max_len: usize) -> Vec<u8> {
    let len = rng.below(max_len as u32 + 1) as usize;
    let mut buf = Vec::with_capacity(len);
    for _ in 0..len {
        buf.push(rng.next_byte());
    }
    buf
}

/// A random byte buffer drawn from a *small alphabet* (`0x00..=0x03`) of length
/// `0..=max_len`. The codec's structural bytes (tags `0x00`/`0x01`, short
/// canonical uvarint lengths) all live in this range, so these buffers form
/// valid canonical values far more often than uniform-random ones do. This keeps
/// the **P2** idempotence path exercised heavily instead of vacuously, while the
/// uniform buffers above keep **P1** broad. Still hits plenty of edge cases:
/// truncated tuples, trailing bytes, deep nesting, empty atoms.
fn small_alphabet_bytes(rng: &mut Lcg, max_len: usize) -> Vec<u8> {
    let len = rng.below(max_len as u32 + 1) as usize;
    let mut buf = Vec::with_capacity(len);
    for _ in 0..len {
        buf.push((rng.next_u64() & 0x03) as u8);
    }
    buf
}

/// A random valid `Value`: an atom of `0..16` random bytes, or a tuple of
/// `0..4` random children. `depth` bounds nesting; at the floor we only emit
/// atoms so the tree is always finite and shallow (max depth 4 from the caller).
fn random_value(rng: &mut Lcg, depth: u32) -> Value {
    // At the depth floor, or 50% of the time, emit an atom; otherwise a tuple.
    let make_atom = depth == 0 || (rng.next_u64() & 1) == 0;
    if make_atom {
        Value::atom(random_bytes(rng, 16))
    } else {
        let arity = rng.below(4) as usize; // 0..=3 children
        let mut items = Vec::with_capacity(arity);
        for _ in 0..arity {
            items.push(random_value(rng, depth - 1));
        }
        Value::tuple(items)
    }
}

// ----- the tests -----

/// **P1 + P2.** Throw ~50k arbitrary byte buffers (length `0..=64`) at the
/// decoder. It must never panic — only `Ok`/`Err`. And because the codec accepts
/// only canonical bytes, every successful decode must re-encode to the *exact*
/// input (`encode(decode(b)) == b`).
#[test]
fn decode_never_panics_and_is_idempotent() {
    const ITERATIONS: usize = 50_000;
    const MAX_LEN: usize = 64;

    let mut rng = Lcg::new(0x0DD_C0DE_5EED_1234);
    let mut ok_count = 0usize;
    let mut err_count = 0usize;

    for i in 0..ITERATIONS {
        // Alternate two generators: uniform-random bytes maximize P1 breadth
        // (the attacker's worst case), while small-alphabet bytes frequently
        // form valid canonical values so P2 idempotence is exercised in earnest.
        let bytes = if i % 2 == 0 {
            random_bytes(&mut rng, MAX_LEN)
        } else {
            small_alphabet_bytes(&mut rng, MAX_LEN)
        };
        match decode(&bytes) {
            // P1: a panic here would abort the process; reaching this match arm
            // proves decode was total for this input.
            Ok(value) => {
                // P2: canonical idempotence — re-encoding the decoded value must
                // reproduce the accepted bytes byte-for-byte.
                let reencoded = encode(&value);
                assert_eq!(
                    reencoded, bytes,
                    "canonical idempotence violated at iter {i}: \
                     decode accepted {bytes:02x?} but re-encoded to {reencoded:02x?}",
                );
                ok_count += 1;
            }
            Err(_) => {
                err_count += 1;
            }
        }
    }

    assert_eq!(ok_count + err_count, ITERATIONS);
    // Sanity: random bytes occasionally form valid canonical values (e.g. a lone
    // `0x00 0x00` atom), so at least one should have been accepted. This guards
    // against a regression that rejects everything and makes P2 vacuous.
    assert!(
        ok_count > 0,
        "expected some random buffers to decode; got 0 of {ITERATIONS} \
         (P2 idempotence would be vacuous)",
    );
    eprintln!(
        "decode_never_panics_and_is_idempotent: {ITERATIONS} buffers (len 0..=64), \
         {ok_count} decoded OK + idempotent, {err_count} rejected",
    );
}

/// **P3.** Generate ~20k random valid `Value` trees (atoms of `0..16` bytes,
/// tuples of `0..4` children, depth `<= 4`) and assert `decode(encode(v)) == v`.
#[test]
fn encode_decode_round_trips() {
    const ITERATIONS: usize = 20_000;
    const MAX_DEPTH: u32 = 4;

    let mut rng = Lcg::new(0xF0F0_BEEF_1357_9BDF);

    for i in 0..ITERATIONS {
        let value = random_value(&mut rng, MAX_DEPTH);
        let bytes = encode(&value);
        let decoded = decode(&bytes).unwrap_or_else(|e| {
            panic!("round-trip decode failed at iter {i}: {e} for value {value}")
        });
        assert_eq!(
            decoded, value,
            "round-trip mismatch at iter {i}: re-decoded value differs from original",
        );
    }

    eprintln!(
        "encode_decode_round_trips: {ITERATIONS} random values (atom 0..16 bytes, \
         tuple 0..4 children, depth <= {MAX_DEPTH}) all round-tripped",
    );
}
