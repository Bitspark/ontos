package readable_test

import (
	"math"
	"testing"

	"github.com/bitspark/ontos/codec/go"
	"github.com/bitspark/ontos/projection/json/go/internal/vectors"
	"github.com/bitspark/ontos/projection/json/go/readable"
)

// TestVectors replays every case of projection/json/vectors/readable.json (spec §12),
// origins included.
func TestVectors(t *testing.T) {
	limits := func(overrides map[string]int) readable.Limits {
		return vectors.WithLimits(readable.DefaultLimits(), overrides)
	}
	counts := vectors.Replay(t, "../../vectors/readable.json", vectors.Face{
		Profile: readable.Profile,
		Parse: func(input []byte, overrides map[string]int) ([]byte, *vectors.Got) {
			v, err := readable.ParseUTF8(input, limits(overrides))
			if err != nil {
				return nil, vectors.GotOf(err)
			}
			return codec.Encode(v), nil
		},
		Render: func(value []byte, overrides map[string]int) ([]byte, *vectors.Got) {
			v, err := codec.DecodeWithLimits(value, codec.Limits{MaxDepth: math.MaxInt, MaxAtomBytes: math.MaxInt, MaxTupleArity: math.MaxInt})
			if err != nil {
				return nil, &vectors.Got{Code: "value_hex does not decode: " + err.Error()}
			}
			out, err := readable.RenderUTF8(v, limits(overrides))
			if err != nil {
				return nil, vectors.GotOf(err)
			}
			return out, nil
		},
		Origins: func(input []byte, overrides map[string]int) ([]vectors.Origin, *vectors.Got) {
			parsed, err := readable.ParseUTF8WithOrigins(input, limits(overrides))
			if err != nil {
				return nil, vectors.GotOf(err)
			}
			var out []vectors.Origin
			for vp, o := range parsed.Origins.All() {
				out = append(out, vectors.Origin{ValuePath: vp, JSONPath: vectors.PathOf(o.Path), Span: [2]int{o.Span.Start, o.Span.End}})
			}
			return out, nil
		},
	})
	t.Logf("readable.json: %s", counts)
}
