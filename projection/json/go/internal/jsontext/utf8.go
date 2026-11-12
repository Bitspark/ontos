package jsontext

import "unicode/utf8"

// Text runs stages 1 and 2 (total §4.1, §4.2): the size bound, then well-formed UTF-8.
func Text(input []byte, l *Limits) *Fault {
	if n := len(input); n > l.TextBytes {
		return Limit(KindTextBytes, nil, l.TextBytes, n, Message(KindTextBytes, l))
	}
	if utf8.Valid(input) {
		return nil
	}
	start, end := utf8Fault(input)
	return Refuse(CodeInvalidUTF8, nil, start, end, "the input is not well-formed UTF-8")
}

// utf8Fault returns the span of the first maximal ill-formed subpart (Unicode §3.9, Table
// 3-7): the longest run from the first bad offset that is a prefix of a well-formed
// sequence, or that one byte when no well-formed sequence starts with it. The input is
// known to be ill-formed.
func utf8Fault(b []byte) (int, int) {
	n := len(b)
	for i := 0; i < n; {
		c := b[i]
		if c < 0x80 {
			i++
			continue
		}
		need, lo, hi := 0, byte(0x80), byte(0xbf)
		switch {
		case c >= 0xc2 && c <= 0xdf:
			need = 1
		case c == 0xe0:
			need, lo = 2, 0xa0
		case c >= 0xe1 && c <= 0xec, c == 0xee, c == 0xef:
			need = 2
		case c == 0xed:
			need, hi = 2, 0x9f
		case c == 0xf0:
			need, lo = 3, 0x90
		case c >= 0xf1 && c <= 0xf3:
			need = 3
		case c == 0xf4:
			need, hi = 3, 0x8f
		default:
			return i, i + 1
		}
		j := i + 1
		for k := 0; k < need; k, j = k+1, j+1 {
			l, h := byte(0x80), byte(0xbf)
			if k == 0 {
				l, h = lo, hi
			}
			if j >= n || b[j] < l || b[j] > h {
				return i, j
			}
		}
		i = j
	}
	return n, n // unreachable for ill-formed input
}
