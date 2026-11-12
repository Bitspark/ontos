package core

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"testing"
)

// recursiveString is String as it was before Tuple.String walked with an explicit stack:
// the oracle the walk must match byte for byte.
func recursiveString(v Value) string {
	switch v := v.(type) {
	case Tuple:
		var b strings.Builder
		b.WriteString("Tuple(")
		for i, item := range v.items {
			if i != 0 {
				b.WriteString(", ")
			}
			b.WriteString(recursiveString(item))
		}
		b.WriteString(")")
		return b.String()
	case Atom:
		var b strings.Builder
		b.WriteString("Atom(0x")
		for _, byte_ := range v.bytes {
			fmt.Fprintf(&b, "%02x", byte_)
		}
		b.WriteString(")")
		return b.String()
	default:
		return v.String()
	}
}

// nested is depth one-element tuples around Atom(0x61), built without recursion.
func nested(depth int) Value {
	var v Value = NewAtom([]byte{0x61})
	for range depth {
		v = NewTuple(v)
	}
	return v
}

func nestedText(depth int) string {
	return strings.Repeat("Tuple(", depth) + "Atom(0x61)" + strings.Repeat(")", depth)
}

// The CLI human format reuses this rendering, and the conformance harness compares it
// byte for byte across go/rs/ts/py.
func TestStringRendersTheCrossCoreForm(t *testing.T) {
	cases := []struct {
		value Value
		want  string
	}{
		{NewAtom(nil), "Atom(0x)"},
		{NewAtom([]byte{0x61}), "Atom(0x61)"},
		{NewAtom([]byte{0x00, 0x0f, 0xa0, 0xff}), "Atom(0x000fa0ff)"},
		{NewTuple(), "Tuple()"},
		{Tuple{}, "Tuple()"},
		{NewTuple(NewAtom([]byte("map")), NewAtom([]byte{0x61})), "Tuple(Atom(0x6d6170), Atom(0x61))"},
		{NewTuple(NewAtom([]byte{0x70}), NewTuple(NewAtom([]byte{0x71}))), "Tuple(Atom(0x70), Tuple(Atom(0x71)))"},
	}
	for _, c := range cases {
		if got := c.value.String(); got != c.want {
			t.Errorf("String() = %q, want %q", got, c.want)
		}
	}

	every := make([]byte, 256)
	for i := range every {
		every[i] = byte(i)
	}
	if got, want := NewAtom(every).String(), recursiveString(NewAtom(every)); got != want {
		t.Errorf("an atom of every byte value renders %q, want %q", got, want)
	}
}

// Tuple.String keeps its open tuples on a heap slice, so depth costs neither goroutine
// stack nor quadratic time.
//
// NEGATIVE WITNESS: the recursive form took 22 seconds at 100,000 deep, and its time grew
// with the square of the depth, so the 1,000,000-deep case ran past go test's 10-minute
// timeout.
func TestStringAtDepth(t *testing.T) {
	for _, depth := range []int{1024, 100_000, 1_000_000} {
		if got := nested(depth).String(); got != nestedText(depth) {
			t.Errorf("depth %d renders %d bytes, want the %d bytes of the nested form", depth, len(got), len(nestedText(depth)))
		}
	}
}

func TestStringOfADeepChildAmongSiblings(t *testing.T) {
	// Separators and closers stay right when the walk returns from a deep child.
	v := NewTuple(NewAtom([]byte{0x01}), nested(5_000), NewTuple(), NewAtom([]byte{0x02}))
	want := "Tuple(Atom(0x01), " + nestedText(5_000) + ", Tuple(), Atom(0x02))"
	if got := v.String(); got != want {
		t.Fatalf("a deep child among siblings renders %d bytes, want %d", len(got), len(want))
	}
}

func TestStringMatchesTheRecursiveForm(t *testing.T) {
	rng := rand.New(rand.NewPCG(0x63, 0)) // deterministic: a property sweep, not fuzzing
	var gen func(depth int) Value
	gen = func(depth int) Value {
		if depth >= 6 || rng.Float64() < 0.4 {
			bytes := make([]byte, rng.IntN(4))
			for i := range bytes {
				bytes[i] = byte(rng.IntN(256))
			}
			return NewAtom(bytes)
		}
		items := make([]Value, rng.IntN(5))
		for i := range items {
			items[i] = gen(depth + 1)
		}
		return NewTuple(items...)
	}
	for trial := range 500 {
		v := gen(0)
		if got, want := v.String(), recursiveString(v); got != want {
			t.Fatalf("trial %d: String() = %q, want %q", trial, got, want)
		}
	}
}

// A type that embeds Atom or Tuple is a Value too (it gains the marker method), so it can
// be a child. The recursive form called String on every child, so its own method showed
// inside its parent; the walk keeps that.
type point struct{ Tuple }

func (point) String() string { return "Point" }

type label struct{ Atom }

func (label) String() string { return "Label" }

type plain struct{ Tuple }

func TestStringOfAnEmbeddingChildUsesItsOwnMethod(t *testing.T) {
	v := NewTuple(point{NewTuple(NewAtom([]byte{0x01}))}, NewTuple(label{NewAtom([]byte{0x02})}), NewAtom([]byte{0x03}))
	if got, want := v.String(), "Tuple(Point, Tuple(Label), Atom(0x03))"; got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
	// One that keeps Tuple's method renders as the tuple it embeds.
	if got, want := NewTuple(plain{NewTuple(NewAtom([]byte{0x04}))}).String(), "Tuple(Tuple(Atom(0x04)))"; got != want {
		t.Errorf("String() = %q, want %q", got, want)
	}
}
