package wire_test

import (
	"bytes"
	"errors"
	"math/rand"
	"slices"
	"sync"
	"testing"

	deixis "github.com/bitspark/deixis/core/go"
	pos "github.com/bitspark/deixis/pos/go"
	codec "github.com/bitspark/ontos/codec/go"
	core "github.com/bitspark/ontos/core/go"
	data "github.com/bitspark/ontos/data/go"
	wire "github.com/bitspark/ontos/wire/go"
)

type handle struct{ self *handle }

var limits = wire.DefaultLimits()

func requireCode(t *testing.T, err error, code wire.Code, path []int) {
	t.Helper()
	var detail *wire.Error
	if !errors.As(err, &detail) || detail.Code != code || !slices.Equal(detail.Path, path) {
		t.Fatalf("got %v; want %s at %v", err, code, path)
	}
}

func node(t *testing.T, own wire.Payload[*handle], entries ...deixis.Entry[wire.Payload[*handle]]) deixis.Node[wire.Payload[*handle]] {
	t.Helper()
	n, err := deixis.Compose(own, entries)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func TestGroundEmbeddingRecoveryAndBytes(t *testing.T) {
	values := []core.Value{
		core.NewAtom(nil), core.NewTuple(), core.NewAtom([]byte{0, 255, 0}),
		core.NewTuple(core.NewAtom([]byte("wire")), core.NewTuple()),
		data.MustEncodeText("pagination"), data.EncodeNull(),
	}
	rng := rand.New(rand.NewSource(17))
	var value func(int) core.Value
	value = func(depth int) core.Value {
		if depth == 0 || rng.Intn(2) == 0 {
			b := make([]byte, rng.Intn(8))
			_, _ = rng.Read(b)
			return core.NewAtom(b)
		}
		children := make([]core.Value, rng.Intn(5))
		for i := range children {
			children[i] = value(depth - 1)
		}
		return core.NewTuple(children...)
	}
	for i := 0; i < 200; i++ {
		values = append(values, value(4))
	}
	for _, original := range values {
		mixed, err := wire.Embed[*handle](original, limits)
		if err != nil {
			t.Fatal(err)
		}
		n, ok := mixed.Node()
		if !ok {
			t.Fatal("embedding has no node")
		}
		admitted, err := wire.Admit(n, limits)
		if err != nil {
			t.Fatal(err)
		}
		recovered, err := wire.Recover(admitted, limits)
		if err != nil || !core.Equal(original, recovered) || !bytes.Equal(codec.Encode(original), codec.Encode(recovered)) {
			t.Fatalf("ground preservation failed: %v", err)
		}
	}
	atom, _ := wire.Embed[*handle](values[0], limits)
	tuple, _ := wire.Embed[*handle](values[1], limits)
	if atom.Kind() == tuple.Kind() {
		t.Fatal("empty atom and tuple collapsed")
	}
}

func TestExactAdmissionRefusesForeignStructures(t *testing.T) {
	atom := node(t, wire.BytesPayload[*handle](core.NewAtom([]byte("x"))))
	tuple := wire.Payload[*handle]{}
	cases := []struct {
		name  string
		value deixis.Node[wire.Payload[*handle]]
		path  []int
	}{
		{"bytes-and-child", node(t, atom.Own(), deixis.Entry[wire.Payload[*handle]]{Key: pos.Key(0), Node: atom}), nil},
		{"wire-and-child", node(t, wire.WirePayload(&handle{}), deixis.Entry[wire.Payload[*handle]]{Key: pos.Key(0), Node: atom}), nil},
		{"sparse", node(t, tuple, deixis.Entry[wire.Payload[*handle]]{Key: pos.Key(1), Node: atom}), []int{0}},
		{"noncanonical-zero", node(t, tuple, deixis.Entry[wire.Payload[*handle]]{Key: []byte{0, 0, 0}, Node: atom}), []int{0}},
		{"named-child", node(t, tuple, deixis.Entry[wire.Payload[*handle]]{Key: []byte("name"), Node: atom}), []int{0}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := wire.Admit(tc.value, limits)
			if got.Valid() {
				t.Fatal("failure published a usable value")
			}
			requireCode(t, err, wire.Invalid, tc.path)
			outer := node(t, tuple, deixis.Entry[wire.Payload[*handle]]{Key: pos.Key(0), Node: tc.value})
			_, err = wire.Admit(outer, limits)
			requireCode(t, err, wire.Invalid, append([]int{0}, tc.path...))
		})
	}
	// A zero native node is a valid empty tuple; a zero admitted Value is not.
	var empty deixis.Node[wire.Payload[*handle]]
	v, err := wire.Admit(empty, limits)
	if err != nil || v.Kind() != wire.Tuple || v.Len() != 0 {
		t.Fatal("None is not an empty tuple")
	}
	if (wire.Value[*handle]{}).Valid() {
		t.Fatal("zero Value is usable")
	}
}

func TestCaptureAndObservationsPreserveBytesAndAliasing(t *testing.T) {
	input := []byte("abc")
	a, err := wire.NewAtom[*handle](input, limits)
	if err != nil {
		t.Fatal(err)
	}
	input[0] = 'z'
	observed, _ := a.Bytes()
	observed[0] = 'q'
	observed, _ = a.Bytes()
	if string(observed) != "abc" {
		t.Fatal("atom retained or exposed mutable bytes")
	}
	h := &handle{}
	h.self = h // Opaque cycles must not become structural cycles.
	w := wire.NewWire(h)
	children := []wire.Value[*handle]{a, w, w}
	v, err := wire.NewTuple(children, limits)
	if err != nil {
		t.Fatal(err)
	}
	children[0] = w
	n, _ := v.Node()
	entries := n.Entries()
	entries[0].Key[0] = 33
	entries[0].Node = n
	for _, i := range []int{1, 2} {
		child, err := v.At(i, limits)
		if err != nil {
			t.Fatal(err)
		}
		got, ok := child.Handle()
		if !ok || got != h || got.self != h {
			t.Fatal("handle aliasing lost")
		}
	}
	first, _ := v.At(0, limits)
	got, _ := first.Bytes()
	if string(got) != "abc" {
		t.Fatal("child collection or keys exposed")
	}
	recovered, err := wire.Recover(v, limits)
	if recovered != nil {
		t.Fatal("partial recovery published")
	}
	requireCode(t, err, wire.NotGround, []int{1})
	// Nil is a legal opaque payload; recognition remains the runtime's concern.
	nilWire := wire.NewWire[*handle](nil)
	if got, ok := nilWire.Handle(); !ok || got != nil {
		t.Fatal("nil handle was reinterpreted as None")
	}
}

func TestResourceAccountingAndFailureOutput(t *testing.T) {
	a, _ := wire.NewAtom[*handle]([]byte("ab"), limits)
	// Tuple(atom, atom): three nodes and eight bytes (two 2-byte keys + two atoms).
	exact := wire.Limits{MaxDepth: 1, MaxNodes: 3, MaxBytes: 8}
	v, err := wire.NewTuple([]wire.Value[*handle]{a, a}, exact)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := v.Node()
	for _, l := range []wire.Limits{
		{MaxDepth: 0, MaxNodes: 3, MaxBytes: 8},
		{MaxDepth: 1, MaxNodes: 2, MaxBytes: 8},
		{MaxDepth: 1, MaxNodes: 3, MaxBytes: 7},
	} {
		got, err := wire.Admit(n, l)
		var detail *wire.Error
		if got.Valid() || !errors.As(err, &detail) || detail.Code != wire.Exhausted {
			t.Fatalf("admission: %v", err)
		}
		recovered, err := wire.Recover(v, l)
		if recovered != nil {
			t.Fatal("recovery published partial output")
		}
		requireCode(t, err, wire.Exhausted, nil)
	}
	for _, l := range []wire.Limits{{}, {MaxDepth: -1, MaxNodes: 1}, {MaxDepth: 513, MaxNodes: 1}, {MaxNodes: 1, MaxBytes: -1}} {
		_, err := wire.Admit(n, l)
		requireCode(t, err, wire.InvalidLimits, nil)
	}
	_, err = wire.NewAtom[*handle]([]byte("ab"), wire.Limits{MaxNodes: 1, MaxBytes: 1})
	requireCode(t, err, wire.Exhausted, nil)
	_, err = wire.NewTuple([]wire.Value[*handle]{{}}, limits)
	requireCode(t, err, wire.Invalid, []int{0})
	_, err = wire.Embed[*handle](nil, limits)
	requireCode(t, err, wire.Invalid, nil)
	_, err = wire.Recover(wire.Value[*handle]{}, limits)
	requireCode(t, err, wire.Invalid, nil)
	_, err = v.At(-1, limits)
	requireCode(t, err, wire.Invalid, nil)
	ground := core.NewTuple(core.NewAtom([]byte("ab")), core.NewAtom([]byte("ab")))
	if _, err := wire.Embed[*handle](ground, exact); err != nil {
		t.Fatal(err)
	}
	tooSmall := exact
	tooSmall.MaxNodes--
	if got, err := wire.Embed[*handle](ground, tooSmall); got.Valid() || err == nil {
		t.Fatal("embedding ignored occurrences")
	}
}

func TestConcurrentImmutableObservations(t *testing.T) {
	v, err := wire.Embed[*handle](core.NewTuple(core.NewAtom([]byte("stable"))), limits)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				child, err := v.At(0, limits)
				if err != nil {
					t.Error(err)
					return
				}
				b, _ := child.Bytes()
				b[0] = 0
				if _, err := wire.Recover(v, limits); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
	child, _ := v.At(0, limits)
	b, _ := child.Bytes()
	if string(b) != "stable" {
		t.Fatal("concurrent caller mutated owned storage")
	}
}

func TestEmbeddingDepthRefusalDoesNotScaleWithWidth(t *testing.T) {
	children := make([]core.Value, 4096)
	for i := range children {
		children[i] = core.NewTuple()
	}
	wide := core.NewTuple(children...)
	narrow := core.NewTuple(children[0])
	l := wire.Limits{MaxDepth: 0, MaxNodes: 10000, MaxBytes: 1 << 20}
	allocations := func(value core.Value) float64 {
		return testing.AllocsPerRun(20, func() {
			got, err := wire.Embed[*handle](value, l)
			if got.Valid() {
				t.Fatal("depth refusal published a value")
			}
			requireCode(t, err, wire.Exhausted, nil)
		})
	}
	if small, large := allocations(narrow), allocations(wide); large > small+1 {
		t.Fatalf("depth refusal allocations grow with width: %v -> %v", small, large)
	}
}
