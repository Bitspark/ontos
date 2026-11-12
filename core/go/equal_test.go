package core

import (
	"math/rand/v2"
	"runtime/debug"
	"testing"
)

// recursiveEqual is Equal as it was before Tuple.Equal walked with an explicit stack: the
// oracle for the relation.
func recursiveEqual(left, right Value) bool {
	l, ok := left.(Tuple)
	if !ok {
		return left.Equal(right)
	}
	r, ok := right.(Tuple)
	if !ok || len(l.items) != len(r.items) {
		return false
	}
	for i := range l.items {
		if !recursiveEqual(l.items[i], r.items[i]) {
			return false
		}
	}
	return true
}

// nestedOn is depth one-element tuples around leaf, built without recursion.
func nestedOn(leaf Value, depth int) Value {
	v := leaf
	for range depth {
		v = NewTuple(v)
	}
	return v
}

// Tuple.Equal keeps its open pairs on a heap slice, so depth costs no goroutine stack: these
// cases run with the stack capped at 1 MiB.
//
// NEGATIVE WITNESS: the recursive form took a stack frame per level, so under the cap it
// died at 100,000 levels with "fatal error: stack overflow", which no recover catches.
// Uncapped, it passed the runtime's 1 GB limit at 10,000,000 levels the same way.
func TestEqualAtDepth(t *testing.T) {
	defer debug.SetMaxStack(debug.SetMaxStack(1 << 20))
	for _, depth := range []int{1024, 100_000, 1_000_000} {
		// Each check is a whole walk of the value.
		a := nested(depth)
		if !Equal(a, nested(depth)) {
			t.Errorf("depth %d: equal values compare unequal", depth)
		}
		// A difference at the very bottom, in arity, or in depth.
		if a.Equal(nestedOn(NewAtom([]byte{0x62}), depth)) {
			t.Errorf("depth %d: a different leaf compares equal", depth)
		}
		if a.Equal(nestedOn(NewTuple(NewAtom([]byte{0x61}), NewAtom(nil)), depth-1)) {
			t.Errorf("depth %d: a different arity at the bottom compares equal", depth)
		}
		if nested(depth - 1).Equal(a) {
			t.Errorf("depth %d: a shallower value compares equal", depth)
		}
	}
}

func TestEqualIsTheRecursiveFormsRelation(t *testing.T) {
	rng := rand.New(rand.NewPCG(0x66, 0)) // deterministic: a property sweep, not fuzzing
	// A small space, so that many pairs are equal without being one value.
	var gen func(depth int) Value
	gen = func(depth int) Value {
		if depth >= 3 || rng.Float64() < 0.4 {
			bytes := make([]byte, rng.IntN(2))
			for i := range bytes {
				bytes[i] = byte(rng.IntN(2))
			}
			return NewAtom(bytes)
		}
		items := make([]Value, rng.IntN(3))
		for i := range items {
			items[i] = gen(depth + 1)
		}
		return NewTuple(items...)
	}
	values := make([]Value, 80)
	for i := range values {
		values[i] = gen(0)
	}
	equalPairs := 0
	for i, left := range values {
		for j, right := range values {
			want := recursiveEqual(left, right)
			if got := left.Equal(right); got != want {
				t.Fatalf("values %d and %d: Equal = %v, want %v", i, j, got, want)
			}
			if want {
				equalPairs++
			}
		}
	}
	if equalPairs <= 2*len(values) {
		t.Fatalf("the sweep met only %d equal pairs", equalPairs)
	}
}

// loose embeds Tuple and overrides its Equal.
type loose struct{ Tuple }

func (loose) Equal(Value) bool { return true }

// The recursive form asked each left child through its own Equal method, and a right child
// was only an argument. The walk keeps both.
func TestEqualAsksALeftChildThroughItsOwnMethod(t *testing.T) {
	one, two := NewAtom([]byte{0x01}), NewAtom([]byte{0x02})
	cases := []struct {
		name        string
		left, right Value
		want        bool
	}{
		{"an overriding left child decides", NewTuple(loose{NewTuple(one)}), NewTuple(NewTuple(two)), true},
		{"an overriding right child is not a Tuple", NewTuple(NewTuple(two)), NewTuple(loose{NewTuple(one)}), false},
		{"an embedding left child compares as its Tuple", NewTuple(plain{NewTuple(one)}), NewTuple(NewTuple(one)), true},
		{"an embedding right child is not a Tuple", NewTuple(NewTuple(one)), NewTuple(plain{NewTuple(one)}), false},
	}
	for _, c := range cases {
		if got := c.left.Equal(c.right); got != c.want {
			t.Errorf("%s: Equal = %v, want %v", c.name, got, c.want)
		}
		if got := recursiveEqual(c.left, c.right); got != c.want {
			t.Errorf("%s: the recursive form says %v, want %v", c.name, got, c.want)
		}
	}
}
