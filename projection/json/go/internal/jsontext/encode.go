package jsontext

import "github.com/bitspark/ontos/core/go"

// Encode returns the ontos-codec-v1 bytes of v, as codec.Encode does, with an explicit
// stack in place of recursion: the projections compare map keys and set elements by their
// encodings (readable §4.4, §4.8) at any depth the limits admit.
func Encode(v core.Value) []byte {
	return AppendEncode(nil, v)
}

// AppendEncode appends the ontos-codec-v1 bytes of v to out.
func AppendEncode(out []byte, v core.Value) []byte {
	type open struct {
		t    core.Tuple
		next int
	}
	var stack []open
	for {
		switch x := v.(type) {
		case core.Atom:
			out = append(out, 0x00)
			out = AppendUvarint(out, uint64(x.Len()))
			out = append(out, x.Bytes()...)
		case core.Tuple:
			out = append(out, 0x01)
			out = AppendUvarint(out, uint64(x.Len()))
			stack = append(stack, open{t: x})
		}
		v = nil
		for len(stack) > 0 {
			top := &stack[len(stack)-1]
			if top.next < top.t.Len() {
				v = top.t.At(top.next)
				top.next++
				break
			}
			stack = stack[:len(stack)-1]
		}
		if v == nil {
			return out
		}
	}
}

// AppendUvarint appends the shortest LEB128 encoding of u (ontos-codec §3.1).
func AppendUvarint(out []byte, u uint64) []byte {
	for u >= 0x80 {
		out = append(out, byte(u)|0x80)
		u >>= 7
	}
	return append(out, byte(u))
}
