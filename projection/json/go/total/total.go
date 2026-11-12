// Package total is ontos-total-json/1, the total JSON form of ground values
// (docs/spec/ontos-total-json.md):
//
//	Atom(b)              →  {"atom":"<b as lowercase hex>"}
//	Tuple(v₀, …, vₙ₋₁)   →  {"tuple":[<v₀>,…,<vₙ₋₁>]}
//
// ParseUTF8 reads JSON text, as bytes, into a value, and RenderUTF8 writes a value's
// preferred spelling. The profile is total: every value has exactly one preferred
// spelling, and every accepted text denotes exactly one value. It says nothing about
// embeddings.
//
// A JSON profile is a presentation, not the form of record: identity, hashing and signing
// use the codec bytes of the value read back, never the JSON text.
//
// The reader runs the four stages of spec §4 in order (size, UTF-8, the strict JSON
// reading, the total form) and refuses with an *Error whose code, path, span and kind the
// spec determines (§8). Limits are operational (§9): the shipped defaults are
// DefaultLimits, and a bound may be configured per call. Neither the reader nor the writer
// recurses on the host stack, so any depth the limits admit is safe.
//
// The package also holds what the companion profile, ontos-readable-json/1 (package
// readable), shares with this one: the Limits record, the Error type and its Segment and
// Span. Conformance is pinned by projection/json/vectors/total.json.
package total

import (
	"errors"

	"github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/projection/json/go/internal/jsontext"
)

// Profile is this profile's id.
const Profile = "ontos-total-json/1"

// ParseUTF8 reads input, JSON text as bytes, as an ontos-total-json/1 value under limits
// (spec §4). A refusal is an *Error; an invalid limits record is an error wrapping
// ErrInvalidLimits. It never returns a value together with an error.
//
// A Go string may hold any bytes, so a string is read with ParseUTF8([]byte(s), …), whose
// UTF-8 stage refuses ill-formed bytes as in any input.
func ParseUTF8(input []byte, limits Limits) (core.Value, error) {
	l, err := limits.resolve(totalFactor, totalOffset)
	if err != nil {
		return nil, err
	}
	root, f := jsontext.Read(input, &l)
	if f != nil {
		return nil, errorOf(Profile, f)
	}
	v, _, f := jsontext.Total(root, 0, nil, &l, false)
	if f != nil {
		return nil, errorOf(Profile, f)
	}
	return v, nil
}

// RenderUTF8 writes v's preferred spelling (spec §2, §5): UTF-8 without a byte order mark,
// no whitespace and no trailing newline. It checks the bounds of limits as the reader's
// mirror (spec §9.3), so what it writes under limits reads back under the same limits. A
// refusal is an *Error with no span; its path, informative, is the output path of the node
// being written.
func RenderUTF8(v core.Value, limits Limits) ([]byte, error) {
	if v == nil {
		return nil, errors.New("total: RenderUTF8 of a nil core.Value, which is not a value")
	}
	l, err := limits.resolve(totalFactor, totalOffset)
	if err != nil {
		return nil, err
	}
	e := jsontext.Emitter{L: &l}
	if f := jsontext.WriteTotal(&e, v, 0, nil); f != nil {
		return nil, errorOf(Profile, f)
	}
	return e.Out, nil
}
