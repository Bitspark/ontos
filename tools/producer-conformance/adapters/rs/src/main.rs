//! producer-conformance adapter — Rust. See `../../PROTOCOL.md`.
//!
//! ```text
//! ontos-producer-adapter <kind> <arg>   ->  one JSON line on stdout
//! ```
//!
//! Builds the host value NATIVELY from the recipe, runs the blessed producer, and
//! reports canonical bytes or a classified rejection.
//!
//! Rust is the language where the interesting answers are `unsupported`, and that is
//! the point of the host-profile split: `&str` carries the UTF-8 invariant, so an
//! inadmissible text value is not merely rejected here — it is **unconstructible**,
//! which `ontos-data.md` §4.1 counts as full conformance rather than an exemption.
//!
//! It is also where a MECHANISM genuinely differs: `encode_int` takes `i128`, so
//! values beyond that range go through `encode_int_bytes` (sign + minimal big-endian
//! magnitude). Same outcome, different route — exactly what §4.1 permits.

use ontos_data::DataError;

/// Decimal string -> (negative, minimal big-endian magnitude), with no bignum
/// dependency (ontos is zero-dep by policy). Repeated division of the decimal digits
/// by 256; each remainder is one magnitude byte, least-significant first.
fn decimal_to_sign_magnitude(s: &str) -> Result<(bool, Vec<u8>), String> {
    let (negative, digits) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s),
    };
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("bad decimal {s:?}"));
    }
    let mut acc: Vec<u8> = digits.bytes().map(|b| b - b'0').collect();
    let mut out = Vec::new();
    while acc.iter().any(|&d| d != 0) {
        let mut rem = 0u16;
        let mut next = Vec::with_capacity(acc.len());
        for &d in &acc {
            let cur = rem * 10 + u16::from(d);
            next.push((cur / 256) as u8);
            rem = cur % 256;
        }
        out.push(rem as u8);
        // strip leading zero digits so the loop terminates
        let first_nonzero = next.iter().position(|&d| d != 0).unwrap_or(next.len());
        acc = next[first_nonzero..].to_vec();
    }
    out.reverse(); // little-endian collected -> big-endian
    Ok((negative && !out.is_empty(), out))
}

fn nums(arg: &str) -> Result<Vec<u32>, String> {
    arg.split(',')
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<u32>().map_err(|_| format!("bad number {s:?}")))
        .collect()
}

enum Outcome {
    Ok(String),
    Err(String),
    Unsupported(String),
}

fn build_and_encode(kind: &str, arg: &str) -> Outcome {
    let value =
        match kind {
            "int" => match decimal_to_sign_magnitude(arg) {
                Err(e) => return Outcome::Unsupported(e),
                Ok((neg, mag)) => match ontos_data::encode_int_bytes(neg, &mag) {
                    Ok(v) => v,
                    Err(DataError::NonCanonicalPayload { kind }) => {
                        return Outcome::Err(format!("non_canonical_payload:{kind}"))
                    }
                    Err(e) => return Outcome::Err(format!("{e:?}")),
                },
            },
            "bool" => match arg {
                "true" => ontos_data::encode_bool(true),
                "false" => ontos_data::encode_bool(false),
                _ => return Outcome::Unsupported(format!("bad bool {arg:?}")),
            },
            "text" => {
                let cps = match nums(arg) {
                    Ok(v) => v,
                    Err(e) => return Outcome::Unsupported(e),
                };
                let mut s = String::new();
                for cp in cps {
                    // char::from_u32 REFUSES surrogates — the invariant is in the type, so
                    // an inadmissible value cannot be built rather than being rejected later.
                    match char::from_u32(cp) {
                        Some(c) => s.push(c),
                        None => {
                            return Outcome::Unsupported(format!(
                            "U+{cp:04X} is not a Unicode scalar value; a Rust char cannot hold it"
                        ))
                        }
                    }
                }
                ontos_data::encode_text(&s)
            }
            "utf16" => return Outcome::Unsupported(
                "a Rust &str is valid UTF-8 by construction; a lone surrogate is unrepresentable"
                    .into(),
            ),
            "bytes" => {
                return Outcome::Unsupported(
                    "a Rust &str cannot carry non-UTF-8 bytes; the invariant is in the type".into(),
                )
            }
            _ => return Outcome::Unsupported(format!("unknown kind {kind:?}")),
        };
    let bytes = ontos_codec::encode(&value);
    let mut hex = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        hex.push_str(&format!("{b:02x}"));
    }
    Outcome::Ok(hex)
}

fn json_escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '"' => "\\\"".chars().collect::<Vec<_>>(),
            '\\' => "\\\\".chars().collect(),
            '\n' => "\\n".chars().collect(),
            c => vec![c],
        })
        .collect()
}

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() != 3 {
        println!(r#"{{"status":"error","code":"adapter_usage"}}"#);
        std::process::exit(2);
    }
    match build_and_encode(&argv[1], &argv[2]) {
        Outcome::Ok(hex) => println!(r#"{{"status":"ok","hex":"{hex}"}}"#),
        Outcome::Err(code) => {
            println!(r#"{{"status":"error","code":"{}"}}"#, json_escape(&code))
        }
        Outcome::Unsupported(reason) => println!(
            r#"{{"status":"unsupported","reason":"{}"}}"#,
            json_escape(&reason)
        ),
    }
}
