package core

import "testing"

func TestAtomsCompareByExactBytes(t *testing.T) {
	if !NewAtom([]byte{1, 2, 3}).Equal(NewAtom([]byte{1, 2, 3})) {
		t.Fatal("equal atoms should be equal")
	}
	if NewAtom([]byte{1, 2, 3}).Equal(NewAtom([]byte{1, 2, 4})) {
		t.Fatal("different atoms should not be equal")
	}
}

func TestAtomLengthIsSignificant(t *testing.T) {
	if NewAtom([]byte{1}).Equal(NewAtom([]byte{0, 1})) {
		t.Fatal("atoms of different length must differ")
	}
}

func TestEmptyAtomNeEmptyTuple(t *testing.T) {
	if Equal(NewAtom(nil), NewTuple()) {
		t.Fatal("empty atom must not equal empty tuple")
	}
}

func TestTuplesCompareStructurally(t *testing.T) {
	a := NewTuple(NewAtom([]byte{0x61}), NewAtom([]byte{0x62}))
	b := NewTuple(NewAtom([]byte{0x61}), NewAtom([]byte{0x62}))
	swapped := NewTuple(NewAtom([]byte{0x62}), NewAtom([]byte{0x61}))
	if !a.Equal(b) {
		t.Fatal("structurally identical tuples should be equal")
	}
	if a.Equal(swapped) {
		t.Fatal("order is significant")
	}
}

func TestNestingIsSignificant(t *testing.T) {
	nested := NewTuple(NewTuple(NewAtom([]byte{0x61}), NewAtom([]byte{0x62})))
	flat := NewTuple(NewAtom([]byte{0x61}), NewAtom([]byte{0x62}))
	if nested.Equal(flat) {
		t.Fatal("nesting must be significant")
	}
}

func TestNewTupleRejectsNilChild(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("NewTuple with a nil child must panic; a nil value is not an ontos value")
		}
	}()
	_ = NewTuple(NewAtom([]byte{0x61}), nil)
}

func TestTupleAtReturnsChildrenInOrder(t *testing.T) {
	first := NewAtom([]byte{0x61})
	second := NewAtom([]byte{0x62})
	tup := NewTuple(first, second)
	if tup.Len() != 2 {
		t.Fatalf("Len = %d, want 2", tup.Len())
	}
	if got := tup.At(0); got == nil || !got.Equal(first) {
		t.Fatalf("At(0) = %v, want %v", got, first)
	}
	if got := tup.At(1); got == nil || !got.Equal(second) {
		t.Fatalf("At(1) = %v, want %v", got, second)
	}
	// At agrees with the Items slice at the same index.
	if got, want := tup.At(0), tup.Items()[0]; !got.Equal(want) {
		t.Fatalf("At(0) = %v, want Items()[0] = %v", got, want)
	}
}

func TestTupleAtOutOfRangeIsNil(t *testing.T) {
	tup := NewTuple(NewAtom([]byte{0x61}))
	if tup.At(-1) != nil {
		t.Fatal("At(-1) must be nil")
	}
	if tup.At(1) != nil {
		t.Fatal("At past the end must be nil")
	}
	empty := NewTuple()
	if empty.Len() != 0 {
		t.Fatalf("empty tuple Len = %d, want 0", empty.Len())
	}
	if empty.At(0) != nil {
		t.Fatal("At on an empty tuple must be nil")
	}
}

func TestAtomBytesAndLen(t *testing.T) {
	a := NewAtom([]byte{1, 2, 3})
	if a.Len() != 3 {
		t.Fatalf("Len = %d, want 3", a.Len())
	}
	got := a.Bytes()
	if len(got) != 3 || got[0] != 1 || got[1] != 2 || got[2] != 3 {
		t.Fatalf("Bytes = %v, want [1 2 3]", got)
	}
	// Bytes is a defensive copy: mutating it must not affect the atom.
	got[0] = 0xff
	if again := a.Bytes(); again[0] != 1 {
		t.Fatal("Bytes must return a defensive copy")
	}
}

// Go's idiom for classifying a Value (the per-language analogue of Rust's
// is_atom/as_atom) is a type switch / type assertion on the Value interface;
// there are no is_atom-style helpers. This guards that documented idiom.
func TestValueTypeSwitchIdiom(t *testing.T) {
	values := []Value{NewAtom([]byte{0x61}), NewTuple(NewAtom([]byte{0x62}))}
	atoms, tuples := 0, 0
	for _, v := range values {
		switch v.(type) {
		case Atom:
			atoms++
		case Tuple:
			tuples++
		default:
			t.Fatalf("unexpected value type %T", v)
		}
	}
	if atoms != 1 || tuples != 1 {
		t.Fatalf("type switch counted atoms=%d tuples=%d, want 1 and 1", atoms, tuples)
	}
	// Type assertion borrows the concrete type, like Rust's as_atom/as_tuple.
	if a, ok := values[0].(Atom); !ok || a.Len() != 1 {
		t.Fatal("expected values[0] to assert to Atom of length 1")
	}
	if _, ok := values[0].(Tuple); ok {
		t.Fatal("an Atom must not assert to Tuple")
	}
}
