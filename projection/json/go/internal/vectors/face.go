package vectors

import (
	"errors"

	"github.com/bitspark/ontos/projection/json/go/total"
)

// WithLimits applies a case's overrides, by their spec names, to a profile's defaults.
func WithLimits(base total.Limits, overrides map[string]int) total.Limits {
	for name, v := range overrides {
		switch name {
		case "max_text_bytes":
			base.MaxTextBytes = v
		case "max_json_depth":
			base.MaxJSONDepth = v
		case "max_value_depth":
			base.MaxValueDepth = v
		case "max_atom_bytes":
			base.MaxAtomBytes = v
		case "max_tuple_arity":
			base.MaxTupleArity = v
		case "max_integer_digits":
			base.MaxIntegerDigits = v
		default:
			panic("unknown limit " + name)
		}
	}
	return base
}

// GotOf converts a face's error to a refusal in the vectors' terms. An error that is not
// an *total.Error is returned as a refusal with the code "not a refusal: …", which no case
// pins.
func GotOf(err error) *Got {
	var e *total.Error
	if !errors.As(err, &e) {
		return &Got{Code: "not a refusal: " + err.Error()}
	}
	g := &Got{Profile: e.Profile, Code: e.Code, Path: PathOf(e.Path), Kind: string(e.Kind), Message: e.Message}
	if e.Span != nil {
		g.Span = &[2]int{e.Span.Start, e.Span.End}
	}
	return g
}

// PathOf converts a typed path to the vectors' strings and ints.
func PathOf(path []total.Segment) []any {
	out := make([]any, len(path))
	for i, s := range path {
		if s.IsIndex {
			out[i] = s.Index
		} else {
			out[i] = s.Name
		}
	}
	return out
}
