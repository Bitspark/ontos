package total

import (
	"math"

	"github.com/bitspark/ontos/projection/json/go/internal/jsontext"
)

// Limits bounds one reading or writing (spec §9; readable §9 adds MaxIntegerDigits). The
// record is shared by both JSON profiles, and each profile has its own defaults:
// DefaultLimits here, readable.DefaultLimits there.
//
// Every field is enforced exactly as given, so a zero field is a bound of zero, not a
// request for the default: start from the profile's defaults and override the fields you
// mean to set. Unbounded is the largest bound. MaxJSONDepth may also be DeriveJSONDepth,
// which derives it from MaxValueDepth (2v + 2 here, 3v + 4 for the readable profile). Any
// other negative bound is a caller error (ErrInvalidLimits), not a refusal.
//
// A limit refusal reports that this call stopped at a bound. It says nothing about whether
// the text or the value is malformed, and the same call with larger bounds may succeed.
type Limits struct {
	// MaxTextBytes bounds the bytes of the input text (reader) or the output text (writer).
	// Kind text_bytes.
	MaxTextBytes int
	// MaxJSONDepth bounds the arrays and objects open at once: a top-level scalar has depth
	// 0, [] depth 1, {"tuple":[]} depth 2. Kind json_depth. DeriveJSONDepth derives it.
	MaxJSONDepth int
	// MaxValueDepth bounds how deep the value is nested, with the root at depth 0: the
	// codec's height measure. Kind decode_depth.
	MaxValueDepth int
	// MaxAtomBytes bounds the byte length of any atom in the value. Kind atom_bytes.
	MaxAtomBytes int
	// MaxTupleArity bounds the arity of any tuple in the value. Kind tuple_arity.
	MaxTupleArity int
	// MaxIntegerDigits bounds the decimal digits of an integer's magnitude in the readable
	// profile. Kind integer_digits. This profile never checks it.
	MaxIntegerDigits int
}

// Unbounded is the bound no count exceeds.
const Unbounded = math.MaxInt

// DeriveJSONDepth, as MaxJSONDepth, derives the JSON depth bound from MaxValueDepth: the
// deepest spelling of a value within the value depth bound (spec §9.2). An unbounded
// MaxValueDepth derives an unbounded MaxJSONDepth.
const DeriveJSONDepth = jsontext.Derive

// ErrInvalidLimits is wrapped by the error a reader or writer returns for a limits record
// it cannot represent: a negative bound other than MaxJSONDepth = DeriveJSONDepth.
var ErrInvalidLimits = jsontext.ErrInvalidLimits

// DefaultValueDepth is the shipped value depth bound of both profiles: the codec decoder's
// shipped depth (spec §9.2).
const DefaultValueDepth = 1024

// DefaultLimits returns this profile's shipped defaults (spec §9.2): MaxValueDepth 1024,
// MaxJSONDepth derived (2050 under it), every other bound unbounded.
func DefaultLimits() Limits {
	return Limits{
		MaxTextBytes:     Unbounded,
		MaxJSONDepth:     DeriveJSONDepth,
		MaxValueDepth:    DefaultValueDepth,
		MaxAtomBytes:     Unbounded,
		MaxTupleArity:    Unbounded,
		MaxIntegerDigits: Unbounded,
	}
}

// The derived JSON depth of this profile: a tuple takes two JSON levels, an atom one, and
// the deepest value within depth v is an empty tuple at depth v (spec §9.1, §9.2).
const (
	totalFactor = 2
	totalOffset = 2
)

func (l Limits) resolve(factor, offset int) (jsontext.Limits, error) {
	return jsontext.Resolve(l.MaxTextBytes, l.MaxJSONDepth, l.MaxValueDepth, l.MaxAtomBytes, l.MaxTupleArity,
		l.MaxIntegerDigits, factor, offset)
}
