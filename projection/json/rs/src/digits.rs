//! Byte-level spellings the profiles use: lowercase hexadecimal (total §2), canonical
//! base64 (readable §4.7) and canonical decimal integer text (readable §4.5).
//!
//! Decimal text converts to and from the sign-magnitude bytes of ontos-data §5.1 at any
//! magnitude, in base-10⁹ chunks over 32-bit limbs with 64-bit intermediates. No integer
//! passes through `i128` or any other bounded host integer (readable §4.5); the cost is
//! quadratic in the digit count, which `max_integer_digits` bounds (readable §9).

// ---- hexadecimal --------------------------------------------------------------------------

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Appends `bytes` as lowercase hexadecimal, two digits per byte.
pub(crate) fn push_hex(out: &mut Vec<u8>, bytes: &[u8]) {
    out.reserve(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[usize::from(byte >> 4)]);
        out.push(HEX[usize::from(byte & 0x0f)]);
    }
}

/// Whether `s` matches `hex-content` (total §3): even length, `0`–`9` and `a`–`f` only.
pub(crate) fn is_lower_hex(s: &str) -> bool {
    s.len().is_multiple_of(2) && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// Decodes text that [`is_lower_hex`] accepted.
pub(crate) fn decode_lower_hex(s: &str) -> Vec<u8> {
    let nibble = |c: u8| if c <= b'9' { c - b'0' } else { c - b'a' + 10 };
    s.as_bytes()
        .chunks_exact(2)
        .map(|pair| (nibble(pair[0]) << 4) | nibble(pair[1]))
        .collect()
}

// ---- base64 -------------------------------------------------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Appends `bytes` in canonical base64: the standard alphabet, padded with `=`.
pub(crate) fn push_base64(out: &mut Vec<u8>, bytes: &[u8]) {
    out.reserve(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).map_or(0, |&b| u32::from(b));
        let b2 = chunk.get(2).map_or(0, |&b| u32::from(b));
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63]);
        out.push(B64[(n >> 12) as usize & 63]);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63]
        } else {
            b'='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63]
        } else {
            b'='
        });
    }
}

fn b64_value(c: u8) -> Option<u32> {
    let v = match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => return None,
    };
    Some(u32::from(v))
}

/// Decodes canonical base64 (readable §4.7), or `None` for any other text: a length that
/// is not a multiple of four, a character outside the standard alphabet, padding anywhere
/// but at the end, or unused bits that are not zero. A string is canonical exactly when
/// decoding it and encoding the result gives it back.
pub(crate) fn decode_base64(s: &str) -> Option<Vec<u8>> {
    let b = s.as_bytes();
    if !b.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(b.len() / 4 * 3);
    let groups = b.len() / 4;
    for (g, quad) in b.chunks_exact(4).enumerate() {
        let last = g + 1 == groups;
        let pads = match (quad[2], quad[3]) {
            (b'=', b'=') if last => 2,
            (_, b'=') if last => 1,
            _ => 0,
        };
        let mut n = 0u32;
        for &c in &quad[..4 - pads] {
            n = (n << 6) | b64_value(c)?;
        }
        n <<= 6 * pads as u32;
        out.push((n >> 16) as u8);
        if pads < 2 {
            out.push((n >> 8) as u8);
        }
        if pads < 1 {
            out.push(n as u8);
        }
        // The unused bits of the last character must be zero.
        if (pads == 2 && n & 0xffff != 0) || (pads == 1 && n & 0xff != 0) {
            return None;
        }
    }
    Some(out)
}

// ---- canonical decimal integer text ---------------------------------------------------------

/// Whether `s` matches `int-text` (readable §3): `0`, or an optional `-` and a non-zero
/// ASCII digit followed by ASCII digits. Decided on the text alone.
pub(crate) fn is_int_text(s: &str) -> bool {
    let digits = s.strip_prefix('-').unwrap_or(s).as_bytes();
    match digits {
        [] => false,
        [b'0'] => s.len() == 1,
        [first, rest @ ..] => (b'1'..=b'9').contains(first) && rest.iter().all(u8::is_ascii_digit),
    }
}

const CHUNK: u64 = 1_000_000_000; // 10⁹, the largest power of ten below 2³²
const CHUNK_DIGITS: usize = 9;

/// The big-endian minimal magnitude (empty for zero) of canonical ASCII decimal digits
/// without a sign.
pub(crate) fn magnitude_of_digits(digits: &[u8]) -> Vec<u8> {
    debug_assert!(digits.iter().all(u8::is_ascii_digit));
    // Little-endian 32-bit limbs.
    let mut limbs: Vec<u32> = Vec::with_capacity(digits.len() / CHUNK_DIGITS + 1);
    let head = match digits.len() % CHUNK_DIGITS {
        0 => CHUNK_DIGITS.min(digits.len()),
        r => r,
    };
    let mut at = 0;
    let mut take = head;
    while at < digits.len() {
        let chunk = &digits[at..at + take];
        let mut carry = chunk
            .iter()
            .fold(0u64, |acc, &d| acc * 10 + u64::from(d - b'0'));
        let scale = 10u64.pow(take as u32);
        for limb in limbs.iter_mut() {
            // At most (2³² − 1)·10⁹ + 10⁹ < 2⁶⁴.
            let t = u64::from(*limb) * scale + carry;
            *limb = t as u32;
            carry = t >> 32;
        }
        if carry != 0 {
            limbs.push(carry as u32);
        }
        at += take;
        take = CHUNK_DIGITS;
    }
    let mut out: Vec<u8> = Vec::with_capacity(limbs.len() * 4);
    for limb in limbs.iter().rev() {
        out.extend_from_slice(&limb.to_be_bytes());
    }
    let zeros = out.iter().take_while(|&&b| b == 0).count();
    out.drain(..zeros);
    out
}

/// The canonical decimal digits, without a sign, of a big-endian magnitude (empty for
/// zero, which is `0`).
pub(crate) fn digits_of_magnitude(magnitude: &[u8]) -> String {
    let skip = magnitude.iter().take_while(|&&b| b == 0).count();
    let magnitude = &magnitude[skip..];
    if magnitude.is_empty() {
        return "0".to_owned();
    }
    // Big-endian 32-bit limbs, most significant first.
    let pad = (4 - magnitude.len() % 4) % 4;
    let mut padded = vec![0u8; pad];
    padded.extend_from_slice(magnitude);
    let mut limbs: Vec<u32> = padded
        .chunks_exact(4)
        .map(|w| u32::from_be_bytes([w[0], w[1], w[2], w[3]]))
        .collect();
    let mut chunks: Vec<u32> = Vec::new(); // base 10⁹, least significant first
    let mut start = 0;
    while start < limbs.len() {
        let mut rem = 0u64;
        for limb in limbs[start..].iter_mut() {
            let cur = (rem << 32) | u64::from(*limb);
            *limb = (cur / CHUNK) as u32;
            rem = cur % CHUNK;
        }
        chunks.push(rem as u32);
        while start < limbs.len() && limbs[start] == 0 {
            start += 1;
        }
    }
    let mut out = String::with_capacity(chunks.len() * CHUNK_DIGITS);
    let mut iter = chunks.iter().rev();
    if let Some(top) = iter.next() {
        out.push_str(&top.to_string());
    }
    for chunk in iter {
        out.push_str(&format!("{chunk:09}"));
    }
    out
}

/// The decimal digits of a magnitude when there are at most `max` of them, or `None`
/// when there are more. A lower bound from the bit length refuses a magnitude that is
/// certainly too long before any conversion, so the work stays bounded by `max`.
pub(crate) fn digits_within(magnitude: &[u8], max: u64) -> Option<String> {
    let skip = magnitude.iter().take_while(|&&b| b == 0).count();
    let magnitude = &magnitude[skip..];
    if max != u64::MAX && !magnitude.is_empty() {
        // m ≥ 2^(bits − 1), so m has at least ⌊(bits − 1)·log₁₀2⌋ + 1 digits; 0.30102 is
        // below log₁₀2, which keeps the bound a lower one.
        let bits = (magnitude.len() as u64)
            .saturating_mul(8)
            .saturating_sub(u64::from(magnitude[0].leading_zeros()));
        let at_least = (bits - 1).saturating_mul(30_102) / 100_000 + 1;
        if at_least > max {
            return None;
        }
    }
    let digits = digits_of_magnitude(magnitude);
    (digits.len() as u64 <= max).then_some(digits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_round_trips_across_chunk_and_limb_boundaries() {
        let mut cases: Vec<String> = vec!["0".into(), "1".into(), "9".into(), "10".into()];
        for k in 1..60 {
            cases.push(format!("1{}", "0".repeat(k)));
            cases.push("9".repeat(k));
            cases.push(format!("{}1", "1".repeat(k)));
        }
        for case in cases {
            let mag = magnitude_of_digits(case.as_bytes());
            assert_ne!(mag.first(), Some(&0), "{case}: minimal magnitude");
            assert_eq!(digits_of_magnitude(&mag), case);
        }
    }

    #[test]
    fn decimal_agrees_with_u64_where_both_apply() {
        let mut n: u64 = 1;
        let mut values = vec![0u64, u64::MAX, u64::from(u32::MAX), u64::from(u32::MAX) + 1];
        for _ in 0..200 {
            n = n
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            values.push(n);
            values.push(n >> (n % 64));
        }
        for v in values {
            let be = v.to_be_bytes();
            let skip = be.iter().take_while(|&&b| b == 0).count();
            assert_eq!(
                magnitude_of_digits(v.to_string().as_bytes()),
                be[skip..].to_vec()
            );
            assert_eq!(digits_of_magnitude(&be), v.to_string());
        }
    }

    #[test]
    fn digits_within_is_exact_at_the_bound() {
        for k in 1..80u64 {
            let ten_k = format!("1{}", "0".repeat(k as usize)); // k + 1 digits
            let mag = magnitude_of_digits(ten_k.as_bytes());
            assert_eq!(digits_within(&mag, k + 1).as_deref(), Some(ten_k.as_str()));
            assert_eq!(digits_within(&mag, k), None);
            let nines = "9".repeat(k as usize); // k digits
            let mag = magnitude_of_digits(nines.as_bytes());
            assert_eq!(digits_within(&mag, k).as_deref(), Some(nines.as_str()));
            assert_eq!(digits_within(&mag, k - 1), None);
        }
        assert_eq!(digits_within(&[], 1).as_deref(), Some("0"));
        assert_eq!(digits_within(&[], 0), None);
    }

    #[test]
    fn int_text_is_canonical_decimal_only() {
        for ok in ["0", "1", "-1", "10", "-9007199254740993"] {
            assert!(is_int_text(ok), "{ok}");
        }
        for bad in [
            "", "-", "-0", "01", "+1", " 1", "1 ", "1.0", "1_000", "1\u{662}", "--1", "0x1",
        ] {
            assert!(!is_int_text(bad), "{bad}");
        }
    }

    #[test]
    fn base64_is_canonical_both_ways() {
        let mut out = Vec::new();
        for len in 0..40usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            out.clear();
            push_base64(&mut out, &bytes);
            let text = String::from_utf8(out.clone()).unwrap();
            assert_eq!(decode_base64(&text), Some(bytes), "{text}");
        }
        for bad in [
            "AB==", "AAB=", "AA", "AA==\n", "-_8=", "A===", " AA==", "AA==AA==", "=AAA", "A=AA",
        ] {
            assert_eq!(decode_base64(bad), None, "{bad}");
        }
        assert_eq!(decode_base64(""), Some(Vec::new()));
        assert_eq!(decode_base64("AA=="), Some(vec![0]));
        assert_eq!(decode_base64("/+8="), Some(vec![0xff, 0xef]));
    }

    #[test]
    fn hex_is_lowercase_and_even() {
        assert!(is_lower_hex("") && is_lower_hex("00ff"));
        assert!(!is_lower_hex("0") && !is_lower_hex("0A") && !is_lower_hex(" 0"));
        assert_eq!(decode_lower_hex("00ff7a"), vec![0, 0xff, 0x7a]);
        let mut out = Vec::new();
        push_hex(&mut out, &[0, 0xab, 0x10]);
        assert_eq!(out, b"00ab10");
    }
}
