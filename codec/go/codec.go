// Package codec is the ontos canonical binary codec — ontos-codec-v1 (frozen).
//
//	Atom(bytes)   = 0x00 || uvarint(len(bytes)) || bytes
//	Tuple(values) = 0x01 || uvarint(arity)      || encode(each child)
//
// uvarint is unsigned LEB128 in shortest/canonical form over the u64 domain
// [0, 2^64-1] (spec: docs/spec/ontos-codec.md §3.1). The decoder rejects unknown
// tags, trailing bytes, non-canonical uvarints, uvarints whose value is >= 2^64
// (uvarint_overflow), and inputs exceeding the configured safety limits or this
// implementation's native materialization width (limit_exceeded, whose
// DecodeError.LimitKind names the bound; spec §4.2).
//
// This codec is kept beside the model (it imports core, never the reverse).
// Conformance is pinned by vectors/codec.json (codec id: ontos-codec-v1) and
// specified normatively in docs/spec/ontos-codec.md.
package codec

import (
	"fmt"

	"github.com/bitspark/ontos/core/go"
)

const (
	tagAtom         = 0x00
	tagTuple        = 0x01
	defaultMaxDepth = 1024
)

// Limits bounds decoding of untrusted input. Operational policy, not value
// semantics. Every field is enforced exactly as given, so a zero field is a bound of
// zero, not a request for the default: Limits{} admits only an empty atom or an
// empty tuple at the root. Start from DefaultLimits and override the fields you
// mean to set.
type Limits struct {
	MaxDepth      int
	MaxAtomBytes  int
	MaxTupleArity int
}

// DefaultLimits returns the standard decode limits.
func DefaultLimits() Limits {
	return Limits{MaxDepth: defaultMaxDepth, MaxAtomBytes: maxInt, MaxTupleArity: maxInt}
}

const maxInt = int(^uint(0) >> 1)

// DecodeError carries a cross-language rejection Code (docs/spec/ontos-codec.md §4).
// The five byte-contract codes (unexpected_eof, unknown_tag, non_canonical_uvarint,
// uvarint_overflow, trailing_bytes) are normative and pinned by vectors/codec.json.
// "limit_exceeded" is different: it reports that decoding stopped at an operational
// bound, so it is not vector-pinned and says nothing about whether the input is a
// valid encoding. For it, LimitKind names the bound responsible (spec §4.2). The
// Message is diagnostic only.
//
// Construct a DecodeError with field names. Since LimitKind was added (ontos-internal#352),
// an unkeyed composite literal such as DecodeError{code, msg} no longer compiles.
type DecodeError struct {
	Code    string
	Message string
	// LimitKind names the bound that stopped decoding when Code is "limit_exceeded",
	// and is empty for every other code. It is observational: it identifies the check
	// that stopped this decode, and another implementation may name a different
	// bound for the same input (spec §4.2). An empty or unrecognized kind carries no
	// more than the generic "limit_exceeded".
	LimitKind DecodeLimitKind
}

// DecodeLimitKind names an operational decode bound (docs/spec/ontos-codec.md §4.2).
// The vocabulary is append-only: a name never changes meaning, but a later version
// may add names, so a switch over it needs a default case.
type DecodeLimitKind string

const (
	// LimitDecodeDepth: the value about to be read is nested deeper than
	// Limits.MaxDepth, counting the root as depth 0.
	LimitDecodeDepth DecodeLimitKind = "decode_depth"
	// LimitAtomBytes: a declared atom byte length exceeds Limits.MaxAtomBytes.
	LimitAtomBytes DecodeLimitKind = "atom_bytes"
	// LimitTupleArity: a declared tuple arity exceeds Limits.MaxTupleArity.
	LimitTupleArity DecodeLimitKind = "tuple_arity"
	// LimitNativeWidth: a valid uvarint length or arity does not fit in Go's int
	// (above 2^63-1, or 2^31-1 on a 32-bit build).
	LimitNativeWidth DecodeLimitKind = "native_width"
)

func (e *DecodeError) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

func errf(code, format string, args ...any) *DecodeError {
	return &DecodeError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// limitf builds a "limit_exceeded" DecodeError naming the bound that fired.
func limitf(kind DecodeLimitKind, format string, args ...any) *DecodeError {
	return &DecodeError{Code: "limit_exceeded", Message: fmt.Sprintf(format, args...), LimitKind: kind}
}

// Encode returns the canonical ontos-codec-v1 bytes of v.
func Encode(v core.Value) []byte {
	var out []byte
	return encodeInto(v, out)
}

func encodeInto(v core.Value, out []byte) []byte {
	switch val := v.(type) {
	case core.Atom:
		out = append(out, tagAtom)
		out = appendUvarint(out, val.Len())
		out = append(out, val.Bytes()...)
	case core.Tuple:
		out = append(out, tagTuple)
		out = appendUvarint(out, val.Len())
		for _, item := range val.Items() {
			out = encodeInto(item, out)
		}
	default:
		panic("ontos/codec: unknown core.Value implementation")
	}
	return out
}

// uvarintU64 appends the shortest-form LEB128 encoding of u over the full u64
// domain. This is the canonical encoder the decoder's canonicality check uses.
func uvarintU64(out []byte, u uint64) []byte {
	for {
		b := byte(u & 0x7f)
		u >>= 7
		if u != 0 {
			b |= 0x80
		}
		out = append(out, b)
		if u == 0 {
			break
		}
	}
	return out
}

// appendUvarint appends the shortest-form LEB128 encoding of n (n >= 0).
func appendUvarint(out []byte, n int) []byte { return uvarintU64(out, uint64(n)) }

// EncodeUvarint returns the shortest-form LEB128 encoding of n. It is part of the
// public codec API (the canonical uvarint exposed for callers and pinned by the
// uvarint conformance vectors); the encoder internals use the private appendUvarint.
func EncodeUvarint(n int) []byte { return appendUvarint(nil, n) }

// Decode decodes one value with default limits, rejecting trailing bytes.
func Decode(input []byte) (core.Value, error) {
	return DecodeWithLimits(input, DefaultLimits())
}

// DecodeWithLimits decodes one value with explicit limits, rejecting trailing bytes.
func DecodeWithLimits(input []byte, limits Limits) (core.Value, error) {
	r := &reader{input: input, limits: limits}
	v, err := r.readValue(0)
	if err != nil {
		return nil, err
	}
	if r.pos != len(input) {
		return nil, errf("trailing_bytes", "trailing bytes at offset %d", r.pos)
	}
	return v, nil
}

type reader struct {
	input  []byte
	pos    int
	limits Limits
}

func (r *reader) readValue(depth int) (core.Value, error) {
	if depth > r.limits.MaxDepth {
		return nil, limitf(LimitDecodeDepth, "decode depth %d exceeds maximum %d", depth, r.limits.MaxDepth)
	}
	offset := r.pos
	tag, err := r.readByte()
	if err != nil {
		return nil, err
	}
	switch tag {
	case tagAtom:
		length, err := r.readUvarint()
		if err != nil {
			return nil, err
		}
		if length > r.limits.MaxAtomBytes {
			return nil, limitf(LimitAtomBytes, "atom byte length %d exceeds maximum %d", length, r.limits.MaxAtomBytes)
		}
		b, err := r.readExact(length)
		if err != nil {
			return nil, err
		}
		return core.NewAtom(b), nil
	case tagTuple:
		arity, err := r.readUvarint()
		if err != nil {
			return nil, err
		}
		if arity > r.limits.MaxTupleArity {
			return nil, limitf(LimitTupleArity, "tuple arity %d exceeds maximum %d", arity, r.limits.MaxTupleArity)
		}
		// Every encoded value is at least two bytes (tag + zero uvarint), so an
		// arity larger than half the remaining bytes is impossible.
		remaining := len(r.input) - r.pos
		if arity > remaining/2 {
			return nil, errf("unexpected_eof", "tuple arity %d exceeds remaining input", arity)
		}
		items := make([]core.Value, 0, arity)
		for i := 0; i < arity; i++ {
			item, err := r.readValue(depth + 1)
			if err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		return core.NewTuple(items...), nil
	default:
		return nil, errf("unknown_tag", "unknown value tag 0x%02x at offset %d", tag, offset)
	}
}

func (r *reader) readByte() (byte, error) {
	if r.pos >= len(r.input) {
		return 0, errf("unexpected_eof", "unexpected end of input")
	}
	b := r.input[r.pos]
	r.pos++
	return b, nil
}

func (r *reader) readExact(n int) ([]byte, error) {
	// Compare against the remaining bytes without computing r.pos+n, which would
	// overflow (and produce a negative slice bound) for an n near maxInt — a
	// value the uvarint stage admits (it only rejects > maxInt as limit_exceeded).
	if n < 0 || n > len(r.input)-r.pos {
		return nil, errf("unexpected_eof", "unexpected end of input")
	}
	out := r.input[r.pos : r.pos+n]
	r.pos += n
	return out, nil
}

// readUvarint decodes a uvarint and materializes it as an int for use as a
// length/arity. The encoding domain is u64 (spec §3.1):
//   - a value >= 2^64 is rejected as "uvarint_overflow" (the cross-core pin);
//   - a value that is a valid u64 but exceeds this implementation's usable int
//     (maxInt; Go int is a signed, 63-bit-usable length type) is rejected as
//     "limit_exceeded" — an implementation-local resource limit, NOT
//     "uvarint_overflow" (spec §3.1, §4).
func (r *reader) readUvarint() (int, error) {
	start := r.pos
	value, err := r.readUvarintU64()
	if err != nil {
		return 0, err
	}
	if value > uint64(maxInt) {
		return 0, limitf(LimitNativeWidth, "uvarint value %d exceeds usable length %d at offset %d", value, maxInt, start)
	}
	return int(value), nil
}

// readUvarintU64 decodes one shortest-form uvarint over the full u64 domain.
// It rejects values >= 2^64 ("uvarint_overflow") structurally — an 11th
// continuation byte, or a 10th byte whose high payload bits do not fit under the
// 64-bit ceiling — and rejects non-shortest encodings ("non_canonical_uvarint").
func (r *reader) readUvarintU64() (uint64, error) {
	start := r.pos
	var result uint64
	var shift uint
	for {
		b, err := r.readByte()
		if err != nil {
			return 0, err
		}
		if shift >= 64 {
			// An 11th byte (shift == 70) means the value needs > 70 bits — it
			// cannot be < 2^64.
			return 0, errf("uvarint_overflow", "uvarint value exceeds 2^64-1 at offset %d", start)
		}
		// At shift == 63 (the 10th byte) only the low bit of this byte's payload
		// fits under the 64-bit ceiling; any higher payload bit pushes the value
		// to >= 2^64.
		if shift == 63 && (b&0x7f) > 1 {
			return 0, errf("uvarint_overflow", "uvarint value exceeds 2^64-1 at offset %d", start)
		}
		result |= uint64(b&0x7f) << shift
		if b&0x80 == 0 {
			break
		}
		shift += 7
	}
	// Canonicality: the bytes read must equal the shortest-form encoding of the
	// decoded value (computed over the full u64 domain).
	canonical := uvarintU64(nil, result)
	actual := r.input[start:r.pos]
	if len(canonical) != len(actual) {
		return 0, errf("non_canonical_uvarint", "non-canonical uvarint at offset %d", start)
	}
	for i := range canonical {
		if canonical[i] != actual[i] {
			return 0, errf("non_canonical_uvarint", "non-canonical uvarint at offset %d", start)
		}
	}
	return result, nil
}
