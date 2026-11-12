package total

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/bitspark/ontos/codec/go"
	"github.com/bitspark/ontos/projection/json/go/internal/jsontext"
)

// The refusal codes of spec §8.4, shared by both JSON profiles. The readable profile adds
// its own (readable §8). A code is never reassigned to another meaning.
const (
	// CodeLimitExceeded: an operational bound of §9 was reached; Error.Kind names it.
	CodeLimitExceeded = "limit_exceeded"
	// CodeInvalidUTF8: the input is not well-formed UTF-8 (stage 2).
	CodeInvalidUTF8 = "invalid_utf8"
	// CodeByteOrderMark: the input begins with U+FEFF (stage 3).
	CodeByteOrderMark = "byte_order_mark"
	// CodeInvalidJSON: the input is not an RFC 8259 JSON text with RFC 8259's whitespace.
	CodeInvalidJSON = "invalid_json"
	// CodeInvalidUnicodeEscape: a \u escape names a lone surrogate.
	CodeInvalidUnicodeEscape = "invalid_unicode_escape"
	// CodeDuplicateMember: an object repeats a member name after escape decoding.
	CodeDuplicateMember = "duplicate_member"
	// CodeTrailingData: something other than whitespace follows the value.
	CodeTrailingData = "trailing_data"
	// CodeInvalidTotalForm: a node is not exactly {"atom": string} or {"tuple": array}.
	CodeInvalidTotalForm = "invalid_total_form"
	// CodeInvalidHex: an atom string is not even-length lowercase hexadecimal.
	CodeInvalidHex = "invalid_hex"
)

// The limit kinds of spec §9.1 and readable §9. They share the codec's namespace
// (ontos-codec §4.2) and its type: decode_depth, atom_bytes and tuple_arity mean what the
// codec decoder's bounds mean, and the others are new for the projection. The codec's
// native_width has no counterpart in text, so the projection never reports it.
const (
	KindTextBytes     codec.DecodeLimitKind = "text_bytes"
	KindJSONDepth     codec.DecodeLimitKind = "json_depth"
	KindDecodeDepth                         = codec.LimitDecodeDepth
	KindAtomBytes                           = codec.LimitAtomBytes
	KindTupleArity                          = codec.LimitTupleArity
	KindIntegerDigits codec.DecodeLimitKind = "integer_digits"
)

// Error is a refusal of either JSON profile (spec §8.1). Profile, Code, Path, Span and Kind
// are normative: for a given input and limits every face reports the same ones. Message
// is for people, and its wording may change.
type Error struct {
	// Profile is the id of the profile that refused: ontos-total-json/1 or
	// ontos-readable-json/1.
	Profile string
	// Code is the stable lowercase refusal code.
	Code string
	// Path is the typed path from the root of the JSON text to the node the refusal names
	// (spec §8.2). It is empty for the size and UTF-8 stages. A writer's path is the output
	// path of the node being written, and is informative only.
	Path []Segment
	// Span is the zero-based, half-open UTF-8 byte span of the input (spec §8.3). A writer
	// refusal has no input text, and so no span: Span is nil.
	Span *Span
	// Kind names the bound for CodeLimitExceeded, and is empty for every other code.
	Kind codec.DecodeLimitKind
	// Message explains the refusal. Nobody may parse it.
	Message string
}

func (e *Error) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %s", e.Profile, e.Code)
	if e.Kind != "" {
		fmt.Fprintf(&b, " (%s)", e.Kind)
	}
	fmt.Fprintf(&b, " at %s", PathString(e.Path))
	if e.Span != nil {
		fmt.Fprintf(&b, ", bytes [%d, %d)", e.Span.Start, e.Span.End)
	}
	if e.Message != "" {
		fmt.Fprintf(&b, ": %s", e.Message)
	}
	return b.String()
}

// Span is a zero-based, half-open byte span [Start, End) of the input. It counts bytes,
// not characters or UTF-16 code units, because the input is bytes. An empty span [n, n)
// marks the end of the input.
type Span struct {
	Start, End int
}

// Segment is one step of a path (spec §8.2): a member name, for a step into an object, or
// an index counting from 0, for a step into an array. The two kinds stay distinct: the
// member "0" is Segment{Name: "0"}, and the index 0 is Segment{IsIndex: true}.
type Segment struct {
	// Name is the member name, decoded, when IsIndex is false.
	Name string
	// Index is the array index when IsIndex is true.
	Index int
	// IsIndex tells an index from a member name.
	IsIndex bool
}

// Name is the segment for the member name s.
func Name(s string) Segment { return Segment{Name: s} }

// Index is the segment for the array index i.
func Index(i int) Segment { return Segment{Index: i, IsIndex: true} }

// MarshalJSON writes the segment as the vectors do: a member name as a JSON string, an
// index as a JSON number. A path is then a JSON array of strings and integers.
func (s Segment) MarshalJSON() ([]byte, error) {
	if s.IsIndex {
		return json.Marshal(s.Index)
	}
	return json.Marshal(s.Name)
}

// PathString renders a path as a JSON array of strings and integers, as the vectors write
// it: ["tuple",0,"atom"].
func PathString(path []Segment) string {
	b, err := json.Marshal(path)
	if err != nil || path == nil {
		return "[]"
	}
	return string(b)
}

// errorOf names a fault by profile.
func errorOf(profile string, f *jsontext.Fault) *Error {
	e := &Error{Profile: profile, Code: f.Code, Path: segments(f.Path), Kind: codec.DecodeLimitKind(f.Kind), Message: f.Message}
	if f.HasSpan {
		e.Span = &Span{Start: f.Start, End: f.End}
	}
	return e
}

// segments converts the internal path segments.
func segments(segs []jsontext.Seg) []Segment {
	out := make([]Segment, len(segs))
	for i, s := range segs {
		out[i] = Segment(s)
	}
	return out
}
