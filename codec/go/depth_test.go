package codec

import (
	"bytes"
	"strings"
	"testing"

	"github.com/bitspark/ontos/core/go"
)

// nestedBytes is the frozen byte form of depth one-element tuples around Atom(61), by
// hand: each tuple level is a tag and an arity of 1 (01 01), and the atom is 00 01 61.
func nestedBytes(depth int) []byte {
	return append(bytes.Repeat([]byte{0x01, 0x01}, depth), 0x00, 0x01, 0x61)
}

// Logging what Decode accepted takes time linear in its size: core.Tuple.String writes
// one builder with an explicit stack. NEGATIVE WITNESS: its recursive form copied every
// subtree's string into its parent's, and took 22 seconds on the 100,000-deep value.
func TestDecodedDeepValueRenders(t *testing.T) {
	deep := DefaultLimits()
	deep.MaxDepth = 100_000
	for _, c := range []struct {
		depth  int
		limits Limits
	}{{1024, DefaultLimits()}, {100_000, deep}} {
		v, err := DecodeWithLimits(nestedBytes(c.depth), c.limits)
		if err != nil {
			t.Fatalf("depth %d: %v", c.depth, err)
		}
		want := strings.Repeat("Tuple(", c.depth) + "Atom(0x61)" + strings.Repeat(")", c.depth)
		if got := v.String(); got != want {
			t.Fatalf("depth %d renders %d bytes, want %d", c.depth, len(got), len(want))
		}
	}
}

// A decoded deep value compares with the one built by hand: core.Tuple.Equal walks with an
// explicit stack. Its recursive form also answered here, on a goroutine stack that grew with
// the depth, and died of a fatal stack overflow at ten million levels.
func TestDecodedDeepValueEqualsTheBuiltOne(t *testing.T) {
	deep := DefaultLimits()
	deep.MaxDepth = 100_000
	for _, c := range []struct {
		depth  int
		limits Limits
	}{{1024, DefaultLimits()}, {100_000, deep}} {
		v, err := DecodeWithLimits(nestedBytes(c.depth), c.limits)
		if err != nil {
			t.Fatalf("depth %d: %v", c.depth, err)
		}
		var built core.Value = core.NewAtom([]byte{0x61})
		for range c.depth {
			built = core.NewTuple(built)
		}
		if !core.Equal(v, built) || !core.Equal(built, v) {
			t.Fatalf("depth %d: the decoded value and the built one compare unequal", c.depth)
		}
	}
}
