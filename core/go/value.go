// Package core is ontos/core (L0): the frozen value model.
//
//	Bytes = finite octet strings
//	Value = Atom(Bytes) | Tuple(Value*)
//
// A value is finite, immutable, well-founded (a finite tree, never cyclic),
// uninterpreted, and compared by structural identity. This package defines what
// a value is and when two values are the same — nothing else. There is no byte
// encoding here (that is the codec package) and no interpretation of atoms or
// shapes. See docs/spec/ontos-core.md.
//
// # Common Value API (all three cores)
//
// The Go, Rust, and TypeScript cores expose the same conceptual surface so a
// developer who learns one can predict the others. Every core provides, by its
// own naming convention:
//
//   - Construct — NewAtom(bytes) / NewTuple(items...) (Rust Value::atom/tuple,
//     TS atom/tuple).
//   - Atom bytes + length — Atom.Bytes and Atom.Len.
//   - Tuple children + arity + indexed access — Tuple.Items, Tuple.Len, and
//     Tuple.At (matching Rust Tuple::at / TS Tuple.at).
//   - Structural equality — Value.Equal and the package-level Equal (Rust
//     PartialEq, TS equals).
//   - Diagnostic string — Value.String (Rust Display, TS toString); this is not
//     a canonical encoding.
//
// # Intentional per-language extras
//
// Some members exist in only one core because they are idiomatic to that
// language and have no natural cross-core analogue; they are intentional, not
// accidental gaps. Go classifies a Value with an ordinary type switch or type
// assertion on the Value interface (e.g. a, ok := v.(Atom)), so it needs no
// is_atom/as_atom helpers; those exist only in Rust, where Value is a closed
// enum. The TS-only kind discriminant and toJSON/toHex serve JavaScript
// consumers that lack Rust enums and Go interfaces and want a stable JSON shape;
// Go has no such runtime JSON contract and so omits them.
package core

import (
	"fmt"
	"strings"

	"github.com/bitspark/ontos/internal/tupleid"
)

// Value is a foundational ontos value: either an Atom or a Tuple, and never
// anything else. The unexported marker method keeps the sum type closed: only
// Atom and Tuple in this package can implement it.
type Value interface {
	// Equal reports structural identity with other.
	Equal(other Value) bool
	// String renders a diagnostic form (not a canonical encoding).
	String() string

	isValue()
}

// Atom is an opaque finite byte string. The bytes have no built-in interpretation.
//
// Construct atoms with Atom (which copies); the held bytes are not exposed by
// reference, so an Atom is immutable once built.
type Atom struct {
	bytes []byte
}

// Tuple is a finite ordered tuple of values. Arity, order, and multiplicity are
// part of the value's identity.
type Tuple struct {
	items []Value
}

func (Atom) isValue()  {}
func (Tuple) isValue() {}

// NewAtom builds an Atom from a defensive copy of bytes. A nil slice yields the
// empty atom.
func NewAtom(bytes []byte) Atom {
	cp := make([]byte, len(bytes))
	copy(cp, bytes)
	return Atom{bytes: cp}
}

// NewTuple builds a Tuple from a defensive copy of items.
//
// A nil child is not a value: the L0 set is generated only by Atom and Tuple
// (see docs/spec/ontos-core.md §1), so a nil Value interface cannot be a tuple
// child. Go has no closed sum type to enforce this statically, so the
// constructor is the gate — it panics on a nil child rather than admitting a
// malformed tuple that would later panic in Equal/Encode. Constructing a value
// from untrusted bytes goes through the codec's Decode, which never produces a
// nil child; this guard protects the in-process construction path.
func NewTuple(items ...Value) Tuple {
	cp := make([]Value, len(items))
	for i, item := range items {
		if item == nil {
			panic(fmt.Sprintf("core: NewTuple child %d is nil; a nil value is not an ontos value", i))
		}
		cp[i] = item
	}
	return Tuple{items: cp}
}

// Bytes returns a defensive copy of the atom's exact bytes.
func (a Atom) Bytes() []byte {
	cp := make([]byte, len(a.bytes))
	copy(cp, a.bytes)
	return cp
}

// Len is the atom's byte length.
func (a Atom) Len() int { return len(a.bytes) }

// Items returns a defensive copy of the tuple's ordered children.
func (t Tuple) Items() []Value {
	cp := make([]Value, len(t.items))
	copy(cp, t.items)
	return cp
}

// Len is the tuple's arity.
func (t Tuple) Len() int { return len(t.items) }

// At returns child i, or nil if out of range.
func (t Tuple) At(i int) Value {
	if i < 0 || i >= len(t.items) {
		return nil
	}
	return t.items[i]
}

// Give the codec a key for a tuple's identity in memory, read from the child slice that
// only this package can see (internal/tupleid says why it goes this way). The key relies
// on NewTuple copying its children: no two tuples share a child array.
func init() {
	tupleid.KeyOf = func(tuple any) tupleid.Key { return tupleid.Of(tuple.(Tuple).items) }
}

// Equal: an Atom equals another Atom with the exact same bytes; never a Tuple.
func (a Atom) Equal(other Value) bool {
	b, ok := other.(Atom)
	if !ok {
		return false
	}
	if len(a.bytes) != len(b.bytes) {
		return false
	}
	for i := range a.bytes {
		if a.bytes[i] != b.bytes[i] {
			return false
		}
	}
	return true
}

// Equal: a Tuple equals another Tuple of the same arity whose children are
// elementwise equal in order; never an Atom.
//
// It keeps the open pairs of tuples on an explicit stack instead of making one call per
// nesting level. The recursive form's goroutine stack grew with the depth, and at ten
// million levels it passed the runtime's 1 GB limit, a fatal error no recover catches.
//
// The answer, and the order the children are asked in, are the recursive form's: a left
// child of type Tuple is opened in place, after the checks Equal makes of its argument,
// and any other left child (an Atom, or a type from another package that embeds one)
// is asked through its own Equal method, as before.
func (t Tuple) Equal(other Value) bool {
	u, ok := other.(Tuple)
	if !ok {
		return false
	}
	if len(t.items) != len(u.items) {
		return false
	}
	type open struct {
		left, right []Value
		next        int
	}
	stack := []open{{left: t.items, right: u.items}}
	for len(stack) > 0 {
		top := &stack[len(stack)-1]
		if top.next == len(top.left) {
			stack = stack[:len(stack)-1]
			continue
		}
		left, right := top.left[top.next], top.right[top.next]
		top.next++
		if l, ok := left.(Tuple); ok {
			r, ok := right.(Tuple)
			if !ok || len(l.items) != len(r.items) {
				return false
			}
			stack = append(stack, open{left: l.items, right: r.items})
		} else if !left.Equal(right) {
			return false
		}
	}
	return true
}

// Equal is the package-level structural identity relation.
func Equal(left, right Value) bool { return left.Equal(right) }

func (a Atom) String() string {
	var b strings.Builder
	writeAtom(&b, a.bytes)
	return b.String()
}

// writeAtom writes Atom(0x…) with each byte as two lowercase hex digits, as %02x does.
func writeAtom(b *strings.Builder, bytes []byte) {
	const digits = "0123456789abcdef"
	b.WriteString("Atom(0x")
	for _, byte_ := range bytes {
		b.WriteByte(digits[byte_>>4])
		b.WriteByte(digits[byte_&0x0f])
	}
	b.WriteString(")")
}

// String writes the whole tuple into one builder, keeping its open tuples on an explicit
// stack instead of making one call per nesting level. The recursive form copied every
// subtree's string into its parent's, so its time grew with the square of the depth: 22
// seconds for a value 100,000 deep. This walk is linear, and its stack is a heap slice,
// which never reaches the goroutine stack limit.
//
// The output is the recursive form's: an Atom or Tuple child is written in place, and
// any other child (a type from another package that embeds one of them) renders through
// its own String method, as it did before.
func (t Tuple) String() string {
	type open struct {
		items []Value
		next  int
	}
	var b strings.Builder
	b.WriteString("Tuple(")
	stack := []open{{items: t.items}}
	for len(stack) > 0 {
		top := &stack[len(stack)-1]
		if top.next == len(top.items) {
			b.WriteString(")")
			stack = stack[:len(stack)-1]
			continue
		}
		if top.next != 0 {
			b.WriteString(", ")
		}
		item := top.items[top.next]
		top.next++
		switch v := item.(type) {
		case Tuple:
			b.WriteString("Tuple(")
			stack = append(stack, open{items: v.items})
		case Atom:
			writeAtom(&b, v.bytes)
		default:
			b.WriteString(item.String())
		}
	}
	return b.String()
}
