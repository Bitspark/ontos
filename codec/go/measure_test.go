package codec

import (
	"encoding/hex"
	"errors"
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/bitspark/ontos/core/go"
)

// measure (docs/spec/ontos-codec.md §10, design record 0008): replays
// vectors/codec-measure.json with real sharing, and checks what the vectors cannot
// state: bounds past 2^53 - 1, a doubling chain far past k = 64, and a value deeper
// than any native stack.

type measureVectorValue struct {
	Nodes []struct {
		Atom  *string `json:"atom"`
		Tuple []int   `json:"tuple"`
	} `json:"nodes"`
	Root int `json:"root"`
}

// build makes one in-memory node per table entry, so an index named twice is one
// shared node: every copy of a core.Tuple shares its child storage.
func (j measureVectorValue) build(t *testing.T) core.Value {
	t.Helper()
	built := make([]core.Value, 0, len(j.Nodes))
	for i, node := range j.Nodes {
		switch {
		case node.Atom != nil && node.Tuple == nil:
			b, err := hex.DecodeString(*node.Atom)
			if err != nil {
				t.Fatalf("node %d: bad hex: %v", i, err)
			}
			built = append(built, core.NewAtom(b))
		case node.Atom == nil:
			items := make([]core.Value, 0, len(node.Tuple))
			for _, ref := range node.Tuple {
				if ref < 0 || ref >= i {
					t.Fatalf("node %d names %d, which is not an earlier node", i, ref)
				}
				items = append(items, built[ref])
			}
			built = append(built, core.NewTuple(items...))
		default:
			t.Fatalf("node %d is both an atom and a tuple", i)
		}
	}
	return built[j.Root]
}

type measureNumbers struct {
	EncodedBytes uint64 `json:"encoded_bytes"`
	Occurrences  uint64 `json:"occurrences"`
	Height       uint64 `json:"height"`
}

func TestMeasureVectors(t *testing.T) {
	var doc struct {
		Count int `json:"count"`
		Cases []struct {
			Name   string             `json:"name"`
			Value  measureVectorValue `json:"value"`
			Bounds measureNumbers     `json:"bounds"`
			Expect struct {
				Measures *measureNumbers `json:"measures"`
				Exceeded []MeasureKind   `json:"exceeded"`
			} `json:"expect"`
		} `json:"cases"`
	}
	readVectors(t, "codec-measure.json", &doc)
	if len(doc.Cases) == 0 || len(doc.Cases) != doc.Count {
		t.Fatalf("codec-measure.json: %d cases, count says %d", len(doc.Cases), doc.Count)
	}
	for _, c := range doc.Cases {
		value := c.Value.build(t)
		got, err := Measure(value, MeasureBounds{
			MaxEncodedBytes: c.Bounds.EncodedBytes,
			MaxOccurrences:  c.Bounds.Occurrences,
			MaxHeight:       c.Bounds.Height,
		})
		if want := c.Expect.Measures; want != nil {
			if err != nil {
				t.Errorf("case %q: want %+v, got %v", c.Name, *want, err)
				continue
			}
			if got != (Measures{want.EncodedBytes, want.Occurrences, want.Height}) {
				t.Errorf("case %q: want %+v, got %+v", c.Name, *want, got)
			}
			continue
		}
		if len(c.Expect.Exceeded) == 0 {
			t.Fatalf("case %q: expects neither measures nor exceeded", c.Name)
		}
		var me *MeasureError
		if !errors.As(err, &me) {
			t.Errorf("case %q: want over limit %v, got %+v, %v", c.Name, c.Expect.Exceeded, got, err)
			continue
		}
		if !reflect.DeepEqual(me.Exceeded, c.Expect.Exceeded) {
			t.Errorf("case %q: exceeded %v, want %v", c.Name, me.Exceeded, c.Expect.Exceeded)
		}
		if got != (Measures{}) {
			t.Errorf("case %q: over limit, but measures %+v are not zero", c.Name, got)
		}
	}
}

// doublingChain builds x0 = Atom(00), xk = Tuple(x(k-1), x(k-1)) as k + 1 nodes.
func doublingChain(k int) core.Value {
	var v core.Value = core.NewAtom([]byte{0})
	for i := 0; i < k; i++ {
		v = core.NewTuple(v, v)
	}
	return v
}

var unbounded = MeasureBounds{MaxEncodedBytes: math.MaxUint64, MaxOccurrences: math.MaxUint64, MaxHeight: math.MaxUint64}

// measureWithin fails the test instead of hanging when the memo stops sharing: an
// expanded walk of these chains would not finish.
func measureWithin(t *testing.T, v core.Value, bounds MeasureBounds) (Measures, error) {
	t.Helper()
	type result struct {
		m   Measures
		err error
	}
	done := make(chan result, 1)
	go func() {
		m, err := Measure(v, bounds)
		done <- result{m, err}
	}()
	select {
	case r := <-done:
		return r.m, r.err
	case <-time.After(30 * time.Second):
		t.Fatal("Measure did not finish: it is expanding shared subtrees")
		return Measures{}, nil
	}
}

func exceededOf(t *testing.T, err error) []MeasureKind {
	t.Helper()
	var me *MeasureError
	if !errors.As(err, &me) {
		t.Fatalf("want a *MeasureError, got %v", err)
	}
	return me.Exceeded
}

// The doubling chain at the u64 ceiling, with bounds no vector can state (> 2^53 - 1).
// Every expected number is a closed form of record 0008: 5·2^k − 2 bytes,
// 2^(k+1) − 1 occurrences, height k.
func TestMeasureDoublingChainAtTheU64Ceiling(t *testing.T) {
	// k = 61: 5·2^61 − 2 = 11529215046068469758 bytes, still below 2^64 − 1.
	got, err := measureWithin(t, doublingChain(61), unbounded)
	if err != nil {
		t.Fatalf("k = 61: %v", err)
	}
	if want := (Measures{EncodedBytes: 5<<61 - 2, Occurrences: 1<<62 - 1, Height: 61}); got != want {
		t.Fatalf("k = 61: got %+v, want %+v", got, want)
	}

	// k = 63: 5·2^63 − 2 bytes is past 2^64 − 1, while 2^64 − 1 occurrences sits exactly
	// at the largest bound, so it is within; one less and it is over.
	_, err = measureWithin(t, doublingChain(63), unbounded)
	if got := exceededOf(t, err); !reflect.DeepEqual(got, []MeasureKind{MeasureEncodedBytes}) {
		t.Fatalf("k = 63: exceeded %v", got)
	}
	tighter := unbounded
	tighter.MaxOccurrences = math.MaxUint64 - 1
	_, err = measureWithin(t, doublingChain(63), tighter)
	if got := exceededOf(t, err); !reflect.DeepEqual(got, []MeasureKind{MeasureEncodedBytes, MeasureOccurrences}) {
		t.Fatalf("k = 63, occurrences bound 2^64 - 2: exceeded %v", got)
	}

	// k = 64: 5·2^64 − 2 bytes and 2^65 − 1 occurrences both pass every u64 bound and
	// saturate instead of wrapping; height 64 is within a bound of 64 and over 63.
	at64 := unbounded
	at64.MaxHeight = 64
	_, err = measureWithin(t, doublingChain(64), at64)
	if got := exceededOf(t, err); !reflect.DeepEqual(got, []MeasureKind{MeasureEncodedBytes, MeasureOccurrences}) {
		t.Fatalf("k = 64: exceeded %v", got)
	}
	at64.MaxHeight = 63
	_, err = measureWithin(t, doublingChain(64), at64)
	if got := exceededOf(t, err); !reflect.DeepEqual(got, []MeasureKind{MeasureEncodedBytes, MeasureHeight, MeasureOccurrences}) {
		t.Fatalf("k = 64, height bound 63: exceeded %v", got)
	}
}

// k = 100000 denotes a tree of 2^100001 − 1 values. Measured as its 100001 nodes it
// takes as long as the chain is long, and its height, 100000, is exact.
func TestMeasureDoublingChainFarPast64(t *testing.T) {
	const k = 100_000
	_, err := measureWithin(t, doublingChain(k), MeasureBounds{
		MaxEncodedBytes: math.MaxUint64, MaxOccurrences: math.MaxUint64, MaxHeight: k,
	})
	if got := exceededOf(t, err); !reflect.DeepEqual(got, []MeasureKind{MeasureEncodedBytes, MeasureOccurrences}) {
		t.Fatalf("exceeded %v", got)
	}
	_, err = measureWithin(t, doublingChain(k), MeasureBounds{
		MaxEncodedBytes: math.MaxUint64, MaxOccurrences: math.MaxUint64, MaxHeight: k - 1,
	})
	if got := exceededOf(t, err); !reflect.DeepEqual(got, []MeasureKind{MeasureEncodedBytes, MeasureHeight, MeasureOccurrences}) {
		t.Fatalf("height bound k - 1: exceeded %v", got)
	}
}

// A value nested a million deep, far past the decoder's depth bound of 1024, is measured
// with an explicit stack. Each level is a tag and an arity of 1 (2 bytes), around
// Atom(61) (3 bytes): 2·10^6 + 3 bytes, 10^6 + 1 occurrences, height 10^6.
func TestMeasureDeepValue(t *testing.T) {
	const deep = 1_000_000
	var v core.Value = core.NewAtom([]byte{0x61})
	for i := 0; i < deep; i++ {
		v = core.NewTuple(v)
	}
	got, err := Measure(v, unbounded)
	if err != nil {
		t.Fatal(err)
	}
	if want := (Measures{EncodedBytes: 2*deep + 3, Occurrences: deep + 1, Height: deep}); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	bounded := unbounded
	bounded.MaxHeight = 1024
	_, err = Measure(v, bounded)
	if got := exceededOf(t, err); !reflect.DeepEqual(got, []MeasureKind{MeasureHeight}) {
		t.Fatalf("height bound 1024: exceeded %v", got)
	}
}

// Structurally equal tuples built apart are not shared, and are measured all the same;
// the zero core.Tuple is the empty tuple.
func TestMeasureWithoutSharing(t *testing.T) {
	a := core.NewAtom([]byte("abc"))
	v := core.NewTuple(core.NewTuple(a), core.NewTuple(a), core.Tuple{}, core.NewTuple())
	// Tuple(a) is 2 + 5 = 7 bytes, 2 occurrences; the empty tuples 2 bytes, 1 occurrence.
	got, err := Measure(v, unbounded)
	if err != nil {
		t.Fatal(err)
	}
	if want := (Measures{EncodedBytes: 2 + 7 + 7 + 2 + 2, Occurrences: 1 + 2 + 2 + 1 + 1, Height: 2}); got != want {
		t.Fatalf("got %+v, want %+v", got, want)
	}
	if n := uint64(len(Encode(v))); n != got.EncodedBytes {
		t.Fatalf("encoded_bytes %d, but Encode wrote %d bytes", got.EncodedBytes, n)
	}
}

// MeasureBounds{} is a bound of zero on every measure, not a default.
func TestMeasureZeroBoundsAreZero(t *testing.T) {
	_, err := Measure(core.NewTuple(), MeasureBounds{})
	if got := exceededOf(t, err); !reflect.DeepEqual(got, []MeasureKind{MeasureEncodedBytes, MeasureOccurrences}) {
		t.Fatalf("exceeded %v", got)
	}
	if msg := err.Error(); msg != "over limit: encoded_bytes, occurrences" {
		t.Fatalf("message %q", msg)
	}
}
