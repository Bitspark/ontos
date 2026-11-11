package tupleid_test

import (
	"testing"

	"github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/internal/tupleid"
)

// The key that core installs: copies of a tuple share it, two different tuples share it
// only when both are empty, and reading a child back through its parent keeps it.
func TestKeyOfCoreTuples(t *testing.T) {
	a := core.NewAtom([]byte{0})
	x := core.NewTuple(a, a)
	y := core.NewTuple(a, a) // equal to x, built separately
	copyOfX := x
	var asValue core.Value = x
	parent := core.NewTuple(x, x)

	if tupleid.KeyOf(x) != tupleid.KeyOf(copyOfX) || tupleid.KeyOf(x) != tupleid.KeyOf(asValue) {
		t.Error("copies of one tuple have different keys")
	}
	if tupleid.KeyOf(parent.At(0)) != tupleid.KeyOf(x) || tupleid.KeyOf(parent.At(1)) != tupleid.KeyOf(x) {
		t.Error("a child read back through its parent has a different key")
	}
	if tupleid.KeyOf(x) == tupleid.KeyOf(y) {
		t.Error("two tuples built separately share a key")
	}
	if tupleid.KeyOf(core.NewTuple(a)) == tupleid.KeyOf(x) {
		t.Error("tuples of different arity share a key")
	}

	empties := []core.Value{core.NewTuple(), core.Tuple{}, core.NewTuple([]core.Value{}...)}
	for i, e := range empties {
		if tupleid.KeyOf(e) != (tupleid.Key{}) {
			t.Errorf("empty tuple %d does not have the zero key", i)
		}
	}
	if tupleid.KeyOf(x) == (tupleid.Key{}) {
		t.Error("a non-empty tuple has the zero key")
	}
}
