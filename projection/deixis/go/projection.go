// Package projection implements `ontos-over-deixis-v1`: the total projection P and the
// exact partial recognizer R between ontos values and `Node[Option[Bytes]]`, on the
// `deixis-pos-v1` position spelling.
//
// It is additive, and it is the one place in ontos that knows deixis exists. Nothing in
// `ontos/core` or `ontos-codec-v1` changes because this package exists, and this package
// defines no equality of its own at L0 — ontos identity stays where it is. What it DOES
// supply is the slot relation deixis requires of a caller: see [NodeEq].
//
// Deixis v0.2.0 gives every node an own value independently of its children
// (Node[T] = T × FinMap[Bytes, Node[T]]), so there is no leaf/struct sum to switch on.
// Option is THIS BRIDGE'S chosen payload domain, not a feature of the deixis core, which
// carries T opaquely and never interprets it.
//
// Written from docs/../projection/deixis/PROJECTION.md alone. See the note on
// independence at the bottom of this file.
package projection

import (
	"bytes"
	"fmt"
	"strings"

	deixis "github.com/bitspark/deixis/core/go"
	pos "github.com/bitspark/deixis/pos/go"
	core "github.com/bitspark/ontos/core/go"
)

// Profile and PositionSpelling name the two things this face implements. They are the
// values the vector file carries, and a conforming face is conforming to exactly these.
const (
	Profile          = "ontos-over-deixis-v1"
	PositionSpelling = "deixis-pos-v1"
)

// Payload is the bridge's slot: an optional byte string. Some(b) reads as an atom's
// bytes, None as "no atom here". Deixis requires a value at every node and says nothing
// about what it means; this choice is the profile's, made here and nowhere else.
type Payload = deixis.Option[[]byte]

// Node is the projection's codomain, Node[Option[Bytes]].
type Node = deixis.Node[Payload]

// NodeEq is the deixis identity `=D` at this bridge's slot: deixis's lifted relation over
// equality of the WHOLE payload.
//
// Deixis deliberately provides no native equality for a node — it lifts one from the slot
// and declines to choose the slot's relation on a caller's behalf — so the relation is
// supplied here, explicitly. Both halves are load-bearing: None differs from every Some
// (which is law 6, the empty tuple against the empty atom), and two Somes compare by
// exact bytes, length included.
func NodeEq(a, b Node) bool {
	return a.EqualBy(b, payloadEq)
}

func payloadEq(x, y Payload) bool {
	xb, xSome := x.Get()
	yb, ySome := y.Get()
	if xSome != ySome {
		return false
	}
	if !xSome {
		return true
	}
	return bytes.Equal(xb, yb)
}

// childless builds a node with a payload and no children. Composing zero children cannot
// collide, so Compose's only error is unreachable here.
func childless(own Payload) Node {
	n, err := deixis.Compose(own, nil)
	if err != nil {
		panic(fmt.Sprintf("%s: a childless node has no keys, so no duplicate is possible: %v", Profile, err))
	}
	return n
}

// Project is P : Ontos → Node[Option[Bytes]], and it is TOTAL — every ontos value has a
// projection, so this function cannot fail:
//
//	P(Atom(b))          = Node(Some(b), {})
//	P(Tuple(v₀ … vₙ₋₁)) = Node(None, { κ(i) ↦ P(vᵢ) | 0 ≤ i < n })
func Project(v core.Value) Node {
	switch t := v.(type) {
	case core.Atom:
		// Some(b) AND childless. The childlessness is half the projection: it is what
		// lets R tell an atom from a tuple without a tag.
		return childless(deixis.Some(t.Bytes()))

	case core.Tuple:
		n := t.Len()
		if n == 0 {
			// Law 6: the empty TUPLE is Node(None, {}) and the empty ATOM is
			// Node(Some(""), {}). They differ in the PAYLOAD, not in the child map —
			// which is the thing a lax bridge would merge first.
			return childless(deixis.None[[]byte]())
		}
		entries := make([]deixis.Entry[Payload], 0, n)
		for i := 0; i < n; i++ {
			entries = append(entries, deixis.Entry[Payload]{
				Key:  pos.Key(uint64(i)),
				Node: Project(t.At(i)),
			})
		}
		node, err := deixis.Compose(deixis.None[[]byte](), entries)
		if err != nil {
			// κ is injective (deixis-pos-v1), so 0…n−1 yield n distinct keys and a
			// duplicate is unreachable. Panicking rather than returning an error keeps
			// P total in its SIGNATURE, which is the property law 1 leans on.
			panic(fmt.Sprintf("%s: κ is injective, so Compose cannot reject %d distinct positions: %v", Profile, n, err))
		}
		return node
	}

	// L0 is closed: Value = Atom | Tuple, and the interface is sealed by an unexported
	// method. A third case would be a new floor, not a new projection.
	panic(fmt.Sprintf("%s: not an L0 value: %T", Profile, v))
}

// Kind names WHY R refused. The mandatory-value model admits node shapes the old
// leaf/struct sum could not express, and they do not all fail for the same reason — so
// they do not all get the same explanation. Branch on Kind; the prose in Reason is
// informative only.
type Kind string

const (
	// KindKeyMismatch: a tuple node whose child domain is not exactly {κ(0) … κ(n−1)}.
	// A shifted or sparse domain, a named key, a non-canonical spelling and a stray
	// entry after a dense prefix all land here.
	KindKeyMismatch Kind = "key_mismatch"

	// KindValueWithChildren: a node carrying an own value AND children. P gives a
	// payload only to a childless node, so no key is at fault and none is reported.
	KindValueWithChildren Kind = "value_with_children"
)

// Unrecognized reports why R refused, and where. R is EXACT: it either inverts P on the
// nose or it refuses. It never sorts entries into new positions, fills gaps, drops keys,
// or normalizes an alternate spelling of an index to its position — every one of those
// is a repair pass, and a repair pass silently coarsens identity.
type Unrecognized struct {
	// Path is the ontos index path from the root to the node that refused, so a
	// failure deep in a tree is locatable without re-walking it.
	Path []int
	// Kind is the refusal class. It is normative; two conforming faces agree on it.
	Kind Kind
	// Reason states what was required and what was found. Informative, not normative.
	Reason string
}

func (e *Unrecognized) Error() string {
	where := "$"
	if len(e.Path) > 0 {
		parts := make([]string, len(e.Path))
		for i, p := range e.Path {
			parts[i] = fmt.Sprintf("%d", p)
		}
		where = "$." + strings.Join(parts, ".")
	}
	return fmt.Sprintf("%s: [%s] %s", where, e.Kind, e.Reason)
}

// Recognize is R : Node[Option[Bytes]] ⇀ Ontos, PARTIAL — it succeeds exactly on the
// image of P (law 2):
//
//	R(Node(Some(b), {})) = Atom(b)
//	R(Node(None, m))     = Tuple(R(m(κ(0))), …, R(m(κ(n−1))))
//	                       defined only when dom m = { κ(0), …, κ(n−1) } and every child recognizes.
//
// Everything else refuses: a payload beside children, and a tuple whose domain is not
// exactly the dense positional one.
func Recognize(n Node) (core.Value, error) {
	return recognizeAt(n, nil)
}

func recognizeAt(n Node, path []int) (core.Value, error) {
	if b, some := n.Own().Get(); some {
		// A present payload is an atom — but ONLY if the node is childless. A node
		// carrying both is well-formed deixis and outside the image of P. That is a
		// question about the node's SHAPE, so it is answered before any key is read:
		// the keys may be flawless κ and the node is still not an ontos value.
		if n.Len() > 0 {
			return nil, &Unrecognized{
				Path: clonePath(path),
				Kind: KindValueWithChildren,
				Reason: fmt.Sprintf(
					"the node carries an own value and %d child(ren); under %s a payload belongs only to a CHILDLESS node, so no key is at fault here",
					n.Len(), Profile,
				),
			}
		}
		return core.NewAtom(b), nil
	}

	// An absent payload is a tuple. Because κ is order-preserving, deixis's canonical
	// entry order IS tuple order. So the recognizer walks the entries ONCE, comparing
	// each key against the GENERATED κ(i) — it never parses a key and needs no κ
	// decoder. That is also what makes the refusals below exact: a gap (dom = {κ(0),
	// κ(2)}) shows up as entry 1 carrying κ(2), and a key that would DECODE to i but is
	// not octet-equal to κ(i) is caught by the same comparison. n = 0 is the empty
	// tuple and is in the image.
	entries := n.Entries()
	items := make([]core.Value, 0, len(entries))
	for i, e := range entries {
		want := pos.Key(uint64(i))
		if !bytes.Equal(e.Key, want) {
			return nil, &Unrecognized{
				Path: clonePath(path),
				Kind: KindKeyMismatch,
				Reason: fmt.Sprintf(
					"entry %d carries key %x, not κ(%d) = %x — recognition under %s is exact, and dom m must be exactly {κ(0) … κ(n−1)}",
					i, e.Key, i, want, Profile,
				),
			}
		}
		child, err := recognizeAt(e.Node, append(clonePath(path), i))
		if err != nil {
			return nil, err
		}
		items = append(items, child)
	}
	return core.NewTuple(items...), nil
}

// clonePath copies rather than aliasing: append() on a shared backing array would let a
// sibling's index overwrite a recorded path, so a reported failure could name the wrong
// position.
func clonePath(p []int) []int {
	out := make([]int, len(p))
	copy(out, p)
	return out
}

// INDEPENDENCE NOTE, recorded because the profile's maturity claim depends on it.
//
// This face was written from PROJECTION.md alone; its author did not read
// projection/deixis/rs. That makes it independent of the FIRST IMPLEMENTATION'S CODE but
// NOT of the organisation that wrote it, so per ontos-internal#255 it earns at most the
// "witnessed (in-house, code-sealed)" tier and does NOT move the profile's maturity line
// off UNWITNESSED on its own. A second witness needs an author independent of ontos, who
// has read neither this file nor the Rust one.
//
// THE v0.2.0 MIGRATION DOES NOT CHANGE THAT, in either direction. The three faces were
// carried to the mandatory-value model together, by one author with all three open, so
// the migration is not a fresh independent reading of anything — and it does not retract
// the original one either: the Go face's independence is a fact about how it was FIRST
// written, and it stays exactly as strong, and as limited, as it was.
