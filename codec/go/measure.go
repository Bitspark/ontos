package codec

import (
	"reflect"
	"strings"
	"unsafe"

	"github.com/bitspark/ontos/core/go"
)

// MeasureKind names one of the three measures that Measure reports
// (docs/spec/ontos-codec.md §10). The vocabulary is append-only, as DecodeLimitKind's
// is: a name never changes meaning, but a later version may add names, so a switch
// over it needs a default case, and an unrecognized name still means over limit.
type MeasureKind string

const (
	// MeasureEncodedBytes is the length of the value's canonical encoding: len(Encode(v)).
	MeasureEncodedBytes MeasureKind = "encoded_bytes"
	// MeasureHeight is how deep the value is nested, as the decoder's depth bound
	// counts it: 0 for an atom and for the empty tuple, 1 + the deepest child otherwise.
	MeasureHeight MeasureKind = "height"
	// MeasureOccurrences is the number of values in the expanded tree, the root
	// included: a subtree that appears twice counts twice.
	MeasureOccurrences MeasureKind = "occurrences"
)

// MeasureBounds states one bound for each measure. Every field is enforced exactly as
// given, so a field left out of a composite literal is a bound of zero, not a default:
// MeasureBounds{} is exceeded by every value, which has at least two encoded bytes and
// one occurrence. A measure equal to its bound is within it.
type MeasureBounds struct {
	MaxEncodedBytes uint64
	MaxOccurrences  uint64
	MaxHeight       uint64
}

// Measures are a value's three measures, each exact, as Measure reports them when every
// one is within its bound.
type Measures struct {
	EncodedBytes uint64
	Occurrences  uint64
	Height       uint64
}

// MeasureError is Measure's over-limit outcome. Exceeded names every measure that
// exceeded its bound, in ascending order of the names (encoded_bytes, height,
// occurrences), and is never empty. It is a function of the value and the bounds alone
// (spec §10.2), unlike DecodeError's LimitKind. It carries no numbers: a measure past
// its bound was not counted to the end.
type MeasureError struct {
	Exceeded []MeasureKind
}

func (e *MeasureError) Error() string {
	names := make([]string, len(e.Exceeded))
	for i, kind := range e.Exceeded {
		names[i] = string(kind)
	}
	return "over limit: " + strings.Join(names, ", ")
}

// Measure reports the length of v's canonical encoding, the number of values in its
// expanded tree and its height, without expanding it (docs/spec/ontos-codec.md §10).
// When every measure is within its bound it returns them exactly, with a nil error.
// Otherwise it returns the zero Measures and a *MeasureError naming every measure over
// its bound.
//
// A value built with NewTuple may hold the same subtree under several parents, and a
// chain of k such tuples can denote a tree whose encoding is 5·2^k − 2 bytes long.
// Measure visits each distinct tuple once and adds its measures once per incoming edge,
// so its work is linear in the distinct tuples plus their child edges, whatever the
// bounds. It walks with an explicit stack, so a value of any height can be measured.
// Its arithmetic saturates at each bound, so it never overflows, and it always finishes
// the walk, so the exceeded set does not depend on the traversal order.
//
// A tuple is recognized by the identity of its child storage. A core.Tuple is a struct
// around a slice, and every copy of a tuple shares that slice's backing array, so
// Measure keys its memo on the array's address and the tuple's arity. The slice is
// unexported, so Measure reads it with reflect, using only the standard library and no
// change to core; the address is held as an unsafe.Pointer, which the garbage collector
// tracks. Structurally equal tuples built separately have separate arrays: they are
// measured correctly, just not shared.
func Measure(v core.Value, bounds MeasureBounds) (Measures, error) {
	m := meter{bounds: bounds, memo: map[tupleKey]Measures{}}
	got := m.measure(v)
	var exceeded []MeasureKind
	if m.overBytes {
		exceeded = append(exceeded, MeasureEncodedBytes)
	}
	if m.overHeight {
		exceeded = append(exceeded, MeasureHeight)
	}
	if m.overOccurrences {
		exceeded = append(exceeded, MeasureOccurrences)
	}
	if exceeded != nil {
		return Measures{}, &MeasureError{Exceeded: exceeded}
	}
	return got, nil
}

// tupleKey identifies a tuple's child storage: the backing array's address and the
// tuple's arity. Every empty tuple measures the same, so empty tuples whose keys collide
// (a nil slice, or the runtime's shared zero-size allocation) are harmless.
type tupleKey struct {
	items unsafe.Pointer
	arity int
}

// tupleItemsField is the index of core.Tuple's child slice, or -1 if core no longer
// holds its children in a slice field named items. Measure panics then, rather than
// walking without a memo, which would expand the value.
var tupleItemsField = func() int {
	field, ok := reflect.TypeOf(core.Tuple{}).FieldByName("items")
	if !ok || len(field.Index) != 1 || field.Type.Kind() != reflect.Slice {
		return -1
	}
	return field.Index[0]
}()

// keyOf takes the tuple as the core.Value interface, so reflect reads the struct the
// interface already holds and nothing is allocated per tuple.
func keyOf(v core.Value) tupleKey {
	if tupleItemsField < 0 {
		panic("ontos/codec: core.Tuple no longer holds its children in a slice field named items; Measure's memo must follow it")
	}
	items := reflect.ValueOf(v).Field(tupleItemsField)
	return tupleKey{items: items.UnsafePointer(), arity: items.Len()}
}

// meter holds one walk: the bounds, the memo of measured tuples, and for each measure
// whether any partial result passed its bound. No subtree's measure is larger than the
// whole value's, so a partial result past a bound proves the value's measure is too:
// one flag per measure is exact, and a value held at its bound never changes the
// outcome (spec §10.2).
type meter struct {
	bounds                                 MeasureBounds
	memo                                   map[tupleKey]Measures
	overBytes, overOccurrences, overHeight bool
}

// add is a + b saturated at bound: past the bound it sets *over and holds the bound.
// Short-circuiting on a > bound keeps bound - a from wrapping.
func add(a, b, bound uint64, over *bool) uint64 {
	if a > bound || b > bound-a {
		*over = true
		return bound
	}
	return a + b
}

// uvarintLen is the length of n's shortest-form uvarint (§3).
func uvarintLen(n uint64) uint64 {
	length := uint64(1)
	for n >= 0x80 {
		n >>= 7
		length++
	}
	return length
}

func (m *meter) atom(a core.Atom) Measures {
	n := uint64(a.Len())
	return Measures{
		EncodedBytes: add(1+uvarintLen(n), n, m.bounds.MaxEncodedBytes, &m.overBytes),
		Occurrences:  add(0, 1, m.bounds.MaxOccurrences, &m.overOccurrences),
		Height:       0,
	}
}

// frame is a tuple being measured: its next child, and the sums so far.
type frame struct {
	value       core.Value
	tuple       core.Tuple
	next        int
	bytes       uint64
	occurrences uint64
	deepest     uint64 // the largest child height so far
}

func (m *meter) open(v core.Value, t core.Tuple) frame {
	return frame{
		value:       v,
		tuple:       t,
		bytes:       add(1, uvarintLen(uint64(t.Len())), m.bounds.MaxEncodedBytes, &m.overBytes),
		occurrences: add(0, 1, m.bounds.MaxOccurrences, &m.overOccurrences),
	}
}

func (m *meter) addChild(f *frame, child Measures) {
	f.bytes = add(f.bytes, child.EncodedBytes, m.bounds.MaxEncodedBytes, &m.overBytes)
	f.occurrences = add(f.occurrences, child.Occurrences, m.bounds.MaxOccurrences, &m.overOccurrences)
	if child.Height > f.deepest {
		f.deepest = child.Height
	}
}

// measure walks v in post-order with an explicit stack of open tuples. A tuple is
// pushed the first time it is reached; it cannot be reached again while open, because a
// value is acyclic, so each distinct tuple is opened once and every later edge to it
// is a memo hit that adds its measures, height included.
func (m *meter) measure(v core.Value) Measures {
	var stack []frame
	switch val := v.(type) {
	case core.Atom:
		return m.atom(val)
	case core.Tuple:
		stack = append(stack, m.open(v, val))
	default:
		panic("ontos/codec: unknown core.Value implementation")
	}
	for {
		top := &stack[len(stack)-1]
		if top.next < top.tuple.Len() {
			child := top.tuple.At(top.next)
			top.next++
			switch val := child.(type) {
			case core.Atom:
				m.addChild(top, m.atom(val))
			case core.Tuple:
				if got, ok := m.memo[keyOf(child)]; ok {
					m.addChild(top, got)
				} else {
					stack = append(stack, m.open(child, val))
				}
			default:
				panic("ontos/codec: unknown core.Value implementation")
			}
			continue
		}
		done := Measures{EncodedBytes: top.bytes, Occurrences: top.occurrences}
		if top.tuple.Len() > 0 {
			done.Height = add(top.deepest, 1, m.bounds.MaxHeight, &m.overHeight)
		}
		m.memo[keyOf(top.value)] = done
		stack = stack[:len(stack)-1]
		if len(stack) == 0 {
			return done
		}
		m.addChild(&stack[len(stack)-1], done)
	}
}
