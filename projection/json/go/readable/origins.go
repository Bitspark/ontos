package readable

import (
	"iter"
	"slices"

	"github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/projection/json/go/internal/jsontext"
)

// Origin is where one node of a value came from: the JSON path (total §8.2) and the span
// of the source node that produced it (spec §10.2).
type Origin struct {
	Path []Segment
	Span Span
}

// Origins maps every node of a value read by ParseUTF8WithOrigins, every atom and tuple of
// its expanded tree, back to the source text (spec §10.2). A node is addressed by its
// value path: the tuple child indices from the root, so [] is the root and [2, 1] is child
// 1 of child 2. In a map, an entry's index is its position in codec order, wherever the
// entry stood in the source.
//
// The source node of each value node is: for a string, number or literal, the whole value
// it denotes; for an array, the list and its label, its elements those of the list's
// elements; for an object, the map and its label, each member (from its name to the end of
// its value) its entry, the member's name token the key, and the member's value the value;
// for an envelope with bytes, int or decimal, the whole value; with map, set or compound,
// the container and its label, each entry array, element or argument its own; and with
// raw nothing itself, each total-form object inside the atom or tuple it spells.
//
// Origins are metadata: they are not part of the value, its identity or its encoding. The
// zero Origins has no nodes.
type Origins struct {
	value core.Value
	root  *jsontext.Origin
}

// Lookup returns the origin of the value node at valuePath, or false when the value has no
// node there.
func (o Origins) Lookup(valuePath ...int) (Origin, bool) {
	if o.root == nil {
		return Origin{}, false
	}
	v, n := o.value, o.root
	for _, i := range valuePath {
		t, ok := v.(core.Tuple)
		if !ok || i < 0 || i >= t.Len() {
			return Origin{}, false
		}
		v = t.At(i)
		if !n.Uniform {
			n = n.Kids[i]
		}
	}
	return originOf(n), true
}

// All enumerates every node of the value in pre-order, with its value path and its
// origin. Each value path is a fresh slice.
func (o Origins) All() iter.Seq2[[]int, Origin] {
	return func(yield func([]int, Origin) bool) {
		if o.root == nil {
			return
		}
		type item struct {
			v  core.Value
			n  *jsontext.Origin
			vp []int
		}
		stack := []item{{v: o.value, n: o.root, vp: []int{}}}
		for len(stack) > 0 {
			it := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if !yield(it.vp, originOf(it.n)) {
				return
			}
			t, ok := it.v.(core.Tuple)
			if !ok {
				continue
			}
			for i := t.Len() - 1; i >= 0; i-- {
				kid := it.n
				if !kid.Uniform {
					kid = kid.Kids[i]
				}
				stack = append(stack, item{v: t.At(i), n: kid, vp: append(slices.Clip(it.vp), i)})
			}
		}
	}
}

func originOf(n *jsontext.Origin) Origin {
	return Origin{Path: segments(n.Path.Segments()), Span: Span{Start: n.Start, End: n.End}}
}
