// Package readable is ontos-readable-json/1, the readable JSON form of ground values
// (docs/spec/ontos-readable-json.md). It spells the common values as ordinary JSON:
//
//	null, true, false                          null(), bool
//	"hi"                                       utf8-text("hi")
//	257                                        int(257), within ±(2⁵³ − 1)
//	[1,"a",null]                               list(…)
//	{"b":true,"aa":false}                      map with text keys, in codec order
//
// and every other value through one reserved envelope, {"$ontos":[tag,…]}, with the seven
// tags bytes, int, decimal, map, set, compound and raw. The raw tag wraps the total form of
// package total, so this profile is total over L0 too: every value has exactly one
// preferred spelling, and every accepted text denotes exactly one value.
//
// ParseUTF8 reads JSON text, as bytes, into a value; ParseUTF8WithOrigins also maps every
// node of the value back to the source (spec §10.2); RenderUTF8 writes a value's preferred
// spelling. Stages 1 to 3 of the reading are the total profile's, and the Limits record,
// the Error type and its Segment and Span are package total's, re-exported here. This
// profile's defaults are DefaultLimits.
//
// A JSON profile is a presentation, not the form of record: identity, hashing and signing
// use the codec bytes of the value read back, never the JSON text. Readable input is read
// from its source bytes: a channel that has already replaced ill-formed bytes with U+FFFD
// cannot carry it (spec §10.1).
//
// Neither the reader nor the writer recurses on the host stack, and no integer passes
// through a bounded host type. Conformance is pinned by
// projection/json/vectors/readable.json.
package readable

import (
	"errors"

	"github.com/bitspark/ontos/codec/go"
	"github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/projection/json/go/internal/jsontext"
	"github.com/bitspark/ontos/projection/json/go/total"
)

// Profile is this profile's id.
const Profile = "ontos-readable-json/1"

// Limits is the record shared with the total profile (spec §9).
type Limits = total.Limits

// Error is the refusal type shared with the total profile (spec §8).
type Error = total.Error

// Segment is one step of a path (total §8.2).
type Segment = total.Segment

// Span is a byte span of the input (total §8.3).
type Span = total.Span

// Unbounded is the bound no count exceeds.
const Unbounded = total.Unbounded

// DeriveJSONDepth, as MaxJSONDepth, derives the JSON depth bound from MaxValueDepth: for
// this profile 3·MaxValueDepth + 4, the deepest spelling of a value within it (spec §9).
const DeriveJSONDepth = total.DeriveJSONDepth

// DefaultIntegerDigits is this profile's shipped max_integer_digits (spec §9).
const DefaultIntegerDigits = 4300

// DefaultLimits returns this profile's shipped defaults (spec §9): MaxValueDepth 1024,
// MaxJSONDepth derived (3076 under it), MaxIntegerDigits 4300, every other bound
// unbounded.
func DefaultLimits() Limits {
	l := total.DefaultLimits()
	l.MaxIntegerDigits = DefaultIntegerDigits
	return l
}

// The derived JSON depth: a set or compound tag takes three JSON levels per value level,
// and a chain of compounds around a raw empty tuple reaches 3h + 4 (spec §9).
const (
	readableFactor = 3
	readableOffset = 4
)

// The refusal codes this profile adds to the shared ones (spec §8).
const (
	// CodeInvalidNumber: a number literal has a fraction or an exponent.
	CodeInvalidNumber = "invalid_number"
	// CodeUnsafeIntegerLiteral: a bare integer literal lies outside ±(2⁵³ − 1).
	CodeUnsafeIntegerLiteral = "unsafe_integer_literal"
	// CodeInvalidEnvelope: an object with a member named $ontos has another member, or the
	// member's value is not a non-empty array that starts with a string.
	CodeInvalidEnvelope = "invalid_envelope"
	// CodeUnknownTag: the tag name is not one of the seven.
	CodeUnknownTag = "unknown_tag"
	// CodeInvalidTag: a tag has the wrong arity, a payload element is of the wrong JSON
	// kind, or a compound label is neither a string nor exactly ["bytes", string].
	CodeInvalidTag = "invalid_tag"
	// CodeInvalidInteger: an integer string is not canonical decimal text.
	CodeInvalidInteger = "invalid_integer"
	// CodeNoncanonicalDecimal: decimal components are canonical integers but not the
	// canonical pair.
	CodeNoncanonicalDecimal = "noncanonical_decimal"
	// CodeInvalidBase64: a base64 string is not canonical padded standard base64.
	CodeInvalidBase64 = "invalid_base64"
	// CodeDuplicateMapKey: a map tag repeats a key, by ground-value equality.
	CodeDuplicateMapKey = "duplicate_map_key"
	// CodeDuplicateSetElement: a set tag repeats an element, by ground-value equality.
	CodeDuplicateSetElement = "duplicate_set_element"
)

// The shared codes, for convenience (total §8.4).
const (
	CodeLimitExceeded        = total.CodeLimitExceeded
	CodeInvalidUTF8          = total.CodeInvalidUTF8
	CodeByteOrderMark        = total.CodeByteOrderMark
	CodeInvalidJSON          = total.CodeInvalidJSON
	CodeInvalidUnicodeEscape = total.CodeInvalidUnicodeEscape
	CodeDuplicateMember      = total.CodeDuplicateMember
	CodeTrailingData         = total.CodeTrailingData
	CodeInvalidTotalForm     = total.CodeInvalidTotalForm
	CodeInvalidHex           = total.CodeInvalidHex
)

// The limit kinds, for convenience (total §9.1, spec §9).
const (
	KindTextBytes     = total.KindTextBytes
	KindJSONDepth     = total.KindJSONDepth
	KindDecodeDepth   = total.KindDecodeDepth
	KindAtomBytes     = total.KindAtomBytes
	KindTupleArity    = total.KindTupleArity
	KindIntegerDigits = total.KindIntegerDigits
)

// ParseUTF8 reads input, JSON text as bytes, as an ontos-readable-json/1 value under
// limits (spec §4). A refusal is an *Error; an invalid limits record is an error wrapping
// total.ErrInvalidLimits. It never returns a value together with an error.
func ParseUTF8(input []byte, limits Limits) (core.Value, error) {
	v, _, err := parse(input, limits, false)
	return v, err
}

// Parsed is a value read together with its origins.
type Parsed struct {
	Value   core.Value
	Origins Origins
}

// ParseUTF8WithOrigins is ParseUTF8 that also returns the origins of the value (spec
// §10.2): for every node of the value, the JSON path and span of the source that produced
// it. Origins are metadata, not part of the value.
func ParseUTF8WithOrigins(input []byte, limits Limits) (Parsed, error) {
	v, o, err := parse(input, limits, true)
	if err != nil {
		return Parsed{}, err
	}
	return Parsed{Value: v, Origins: Origins{value: v, root: o}}, nil
}

func parse(input []byte, limits Limits, origins bool) (core.Value, *jsontext.Origin, error) {
	l, err := resolve(limits)
	if err != nil {
		return nil, nil, err
	}
	root, f := jsontext.Read(input, &l)
	if f != nil {
		return nil, nil, errorOf(f)
	}
	r := reader{l: &l, origins: origins}
	v, o, f := r.run(root)
	if f != nil {
		return nil, nil, errorOf(f)
	}
	return v, o, nil
}

// RenderUTF8 writes v's preferred spelling (spec §2, §5): UTF-8 without a byte order mark,
// no whitespace and no trailing newline, members, entries and elements in codec order. It
// checks the bounds of limits as the reader's mirror (spec §9), so what it writes under
// limits reads back under the same limits. A refusal is an *Error with no span; its path,
// informative, is the output path of the node being written.
func RenderUTF8(v core.Value, limits Limits) ([]byte, error) {
	if v == nil {
		return nil, errors.New("readable: RenderUTF8 of a nil core.Value, which is not a value")
	}
	l, err := resolve(limits)
	if err != nil {
		return nil, err
	}
	w := writer{e: jsontext.Emitter{L: &l}}
	if f := w.run(v); f != nil {
		return nil, errorOf(f)
	}
	return w.e.Out, nil
}

func resolve(l Limits) (jsontext.Limits, error) {
	return jsontext.Resolve(l.MaxTextBytes, l.MaxJSONDepth, l.MaxValueDepth, l.MaxAtomBytes, l.MaxTupleArity,
		l.MaxIntegerDigits, readableFactor, readableOffset)
}

func errorOf(f *jsontext.Fault) *Error {
	e := &Error{Profile: Profile, Code: f.Code, Path: segments(f.Path), Kind: codec.DecodeLimitKind(f.Kind), Message: f.Message}
	if f.HasSpan {
		e.Span = &Span{Start: f.Start, End: f.End}
	}
	return e
}

func segments(segs []jsontext.Seg) []Segment {
	out := make([]Segment, len(segs))
	for i, s := range segs {
		out[i] = Segment(s)
	}
	return out
}
