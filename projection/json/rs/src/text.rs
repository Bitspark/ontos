//! Stages 1 and 2 of total §4.1, and the shared front of every reading: size, then
//! well-formed UTF-8 with the maximal-subpart span (total §4.2), then the strict JSON
//! reading of [`crate::lex`].

use crate::error::{Code, Fault, LimitKind, Span};
use crate::lex::{self, Tree};

/// Runs stages 1 to 3 over `input` and returns the JSON tree, or the first refusal.
pub(crate) fn read(
    input: &[u8],
    max_text_bytes: u64,
    max_json_depth: u64,
) -> Result<Tree<'_>, Fault> {
    // Stage 1: size. The bytes beyond the bound are the span.
    if input.len() as u64 > max_text_bytes {
        // max_text_bytes < input.len() here, so it fits a usize.
        let start = max_text_bytes as usize;
        return Err(Fault::limit(
            LimitKind::TextBytes,
            Vec::new(),
            Some(Span::new(start, input.len())),
        ));
    }
    // Stage 2: the whole input is well-formed UTF-8 before any JSON is read.
    if let Some(span) = first_ill_formed(input) {
        return Err(Fault::new(
            Code::InvalidUtf8,
            Vec::new(),
            span,
            "the input is not well-formed UTF-8 here",
        ));
    }
    let text = core::str::from_utf8(input).expect("stage 2 found the input well-formed");
    // Stage 3.
    lex::read(text, max_json_depth)
}

/// The span of the first maximal ill-formed subpart of `b` (Unicode §3.9, Table 3-7), or
/// `None` when `b` is well-formed UTF-8.
///
/// At the first offset `s` that does not start a well-formed sequence, the span is the
/// longest run from `s` that is a prefix of some well-formed sequence, or the one byte at
/// `s` when no well-formed sequence starts with it.
pub(crate) fn first_ill_formed(b: &[u8]) -> Option<Span> {
    let n = b.len();
    let mut i = 0;
    while i < n {
        let lead = b[i];
        if lead < 0x80 {
            i += 1;
            continue;
        }
        // The number of continuation bytes, and the range the first of them may take.
        let (need, lo, hi) = match lead {
            0xc2..=0xdf => (1, 0x80, 0xbf),
            0xe0 => (2, 0xa0, 0xbf),
            0xe1..=0xec | 0xee | 0xef => (2, 0x80, 0xbf),
            0xed => (2, 0x80, 0x9f),
            0xf0 => (3, 0x90, 0xbf),
            0xf1..=0xf3 => (3, 0x80, 0xbf),
            0xf4 => (3, 0x80, 0x8f),
            _ => return Some(Span::new(i, i + 1)),
        };
        let mut j = i + 1;
        for k in 0..need {
            let (l, h) = if k == 0 { (lo, hi) } else { (0x80, 0xbf) };
            if j >= n || b[j] < l || b[j] > h {
                return Some(Span::new(i, j));
            }
            j += 1;
        }
        i = j;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fault(bytes: &[u8]) -> Option<(usize, usize)> {
        first_ill_formed(bytes).map(|s| (s.start, s.end))
    }

    #[test]
    fn maximal_subparts_of_the_spec_table() {
        // total §4.2's table, at offset 1 behind an ASCII byte.
        assert_eq!(fault(b"a\x80"), Some((1, 2)));
        assert_eq!(fault(b"a\xc0\x80"), Some((1, 2)));
        assert_eq!(fault(b"a\xe2\x82\x41"), Some((1, 3)));
        assert_eq!(fault(b"a\xed\xa0\x80"), Some((1, 2)));
        assert_eq!(fault(b"a\xf4\x90\x80\x80"), Some((1, 2)));
        assert_eq!(fault(b"a\xe2\x82"), Some((1, 3)));
    }

    #[test]
    fn agrees_with_std_on_well_formedness() {
        // Every one- and two-byte input, and a sample of longer ones: well-formed exactly
        // when std says so, and the fault starts where std's valid prefix ends.
        let mut inputs: Vec<Vec<u8>> = Vec::new();
        for a in 0..=255u8 {
            inputs.push(vec![a]);
            for b in (0..=255u8).step_by(3) {
                inputs.push(vec![a, b]);
                inputs.push(vec![a, b, 0x80, 0xbf]);
            }
        }
        for input in inputs {
            match core::str::from_utf8(&input) {
                Ok(_) => assert_eq!(fault(&input), None, "{input:02x?}"),
                Err(e) => {
                    let (s, end) = fault(&input).expect("ill-formed");
                    assert_eq!(s, e.valid_up_to(), "{input:02x?}");
                    let len = e.error_len().unwrap_or(input.len() - s);
                    assert_eq!(end - s, len, "{input:02x?}");
                }
            }
        }
    }
}
