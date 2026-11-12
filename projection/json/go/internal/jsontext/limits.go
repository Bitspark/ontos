package jsontext

import (
	"errors"
	"fmt"
	"math"
)

// Unbounded is the largest bound, which no count can exceed (total §10: math.MaxInt).
const Unbounded = math.MaxInt

// Derive is the MaxJSONDepth setting that derives the JSON depth bound from the value
// depth bound (total §9.2, readable §9).
const Derive = -1

// ErrInvalidLimits is the caller error for a bound the faces cannot represent: a negative
// bound, other than the derived JSON depth (total §10: "a caller error, not a refusal").
var ErrInvalidLimits = errors.New("invalid limits")

// Limits are the effective bounds of one call, with the JSON depth bound resolved.
type Limits struct {
	TextBytes     int
	JSONDepth     int
	ValueDepth    int
	AtomBytes     int
	TupleArity    int
	IntegerDigits int
}

// Resolve checks the caller's bounds and resolves a derived JSON depth bound to
// factor·valueDepth + offset: 2v + 2 for the total profile, 3v + 4 for the readable one.
// The derived bound saturates at Unbounded. No input can open more arrays and objects than
// it has bytes, so a saturated bound refuses exactly what the exact one would.
func Resolve(textBytes, jsonDepth, valueDepth, atomBytes, tupleArity, integerDigits, factor, offset int) (Limits, error) {
	for _, b := range []struct {
		name  string
		value int
	}{
		{"MaxTextBytes", textBytes},
		{"MaxValueDepth", valueDepth},
		{"MaxAtomBytes", atomBytes},
		{"MaxTupleArity", tupleArity},
		{"MaxIntegerDigits", integerDigits},
	} {
		if b.value < 0 {
			return Limits{}, fmt.Errorf("%w: %s is %d; a bound is 0 or more", ErrInvalidLimits, b.name, b.value)
		}
	}
	switch {
	case jsonDepth == Derive:
		if valueDepth > (Unbounded-offset)/factor {
			jsonDepth = Unbounded
		} else {
			jsonDepth = factor*valueDepth + offset
		}
	case jsonDepth < 0:
		return Limits{}, fmt.Errorf("%w: MaxJSONDepth is %d; a bound is 0 or more, or DeriveJSONDepth (%d)", ErrInvalidLimits, jsonDepth, Derive)
	}
	return Limits{
		TextBytes:     textBytes,
		JSONDepth:     jsonDepth,
		ValueDepth:    valueDepth,
		AtomBytes:     atomBytes,
		TupleArity:    tupleArity,
		IntegerDigits: integerDigits,
	}, nil
}

// Shape checks the first two value-side bounds of a node's contribution (readable §4.9,
// total §4.4): the deepest value it contributes, then its largest tuple arity (negative
// for none). It returns the kind of the first bound exceeded, or "".
func (l *Limits) Shape(depth, arity int) string {
	if depth > l.ValueDepth {
		return KindDecodeDepth
	}
	if arity > l.TupleArity {
		return KindTupleArity
	}
	return ""
}

// Digits checks the third: the decimal digits of an integer the node carries.
func (l *Limits) Digits(digits int) string {
	if digits > l.IntegerDigits {
		return KindIntegerDigits
	}
	return ""
}

// Atoms checks the fourth: the byte lengths of the atoms the node contributes.
func (l *Limits) Atoms(lengths ...int) string {
	for _, n := range lengths {
		if n > l.AtomBytes {
			return KindAtomBytes
		}
	}
	return ""
}

// Message words a limit refusal.
func Message(kind string, l *Limits) string {
	switch kind {
	case KindTextBytes:
		return fmt.Sprintf("the text is longer than max_text_bytes (%d)", l.TextBytes)
	case KindJSONDepth:
		return fmt.Sprintf("more than max_json_depth (%d) arrays and objects are open", l.JSONDepth)
	case KindDecodeDepth:
		return fmt.Sprintf("the value is nested deeper than max_value_depth (%d)", l.ValueDepth)
	case KindAtomBytes:
		return fmt.Sprintf("an atom is longer than max_atom_bytes (%d)", l.AtomBytes)
	case KindTupleArity:
		return fmt.Sprintf("a tuple has more children than max_tuple_arity (%d)", l.TupleArity)
	case KindIntegerDigits:
		return fmt.Sprintf("an integer has more digits than max_integer_digits (%d)", l.IntegerDigits)
	}
	return kind
}
