package total_test

import (
	"math"
	"testing"

	"github.com/bitspark/ontos/codec/go"
	"github.com/bitspark/ontos/projection/json/go/internal/vectors"
	"github.com/bitspark/ontos/projection/json/go/total"
)

// TestVectors replays every case of projection/json/vectors/total.json (spec §11).
func TestVectors(t *testing.T) {
	counts := vectors.Replay(t, "../../vectors/total.json", vectors.Face{
		Profile: total.Profile,
		Parse: func(input []byte, limits map[string]int) ([]byte, *vectors.Got) {
			v, err := total.ParseUTF8(input, vectors.WithLimits(total.DefaultLimits(), limits))
			if err != nil {
				return nil, vectors.GotOf(err)
			}
			return codec.Encode(v), nil
		},
		Render: func(value []byte, limits map[string]int) ([]byte, *vectors.Got) {
			v, err := codec.DecodeWithLimits(value, codec.Limits{MaxDepth: math.MaxInt, MaxAtomBytes: math.MaxInt, MaxTupleArity: math.MaxInt})
			if err != nil {
				return nil, &vectors.Got{Code: "value_hex does not decode: " + err.Error()}
			}
			out, err := total.RenderUTF8(v, vectors.WithLimits(total.DefaultLimits(), limits))
			if err != nil {
				return nil, vectors.GotOf(err)
			}
			return out, nil
		},
	})
	t.Logf("total.json: %s", counts)
}
