// Package wire implements the optional ontos/wire value profile over deixis.
// C is an opaque, caller-supplied sending face. Capturing C does not recognize,
// attenuate, invoke or export it. The package has no runtime or type-system dependency.
package wire

import (
	"fmt"
	"slices"

	deixis "github.com/bitspark/deixis/core/go"
	pos "github.com/bitspark/deixis/pos/go"
	core "github.com/bitspark/ontos/core/go"
)

const Profile = "ontos/wire"
const Revision = 1
const PositionSpelling = pos.Profile

type Kind string

const (
	Atom Kind = "atom"
	Tuple Kind = "tuple"
	Capability Kind = "wire"
)

// Payload is a closed sum. Its zero value is the tuple's None alternative.
// Atom storage is an immutable ground Atom; C is retained exactly as supplied.
// Runtime composition is responsible for supplying send-only faces, not owners.
type Payload[C any] struct {
	kind Kind
	atom core.Atom
	handle C
}

func BytesPayload[C any](atom core.Atom) Payload[C] { return Payload[C]{kind: Atom, atom: atom} }
func WirePayload[C any](handle C) Payload[C] { return Payload[C]{kind: Capability, handle: handle} }
func (p Payload[C]) Kind() Kind {
	if p.kind == "" { return Tuple }
	return p.kind
}
func (p Payload[C]) Bytes() ([]byte, bool) { return p.atom.Bytes(), p.kind == Atom }
func (p Payload[C]) Handle() (C, bool) { return p.handle, p.kind == Capability }

// Limits count the unfolded tree: root depth zero, every node occurrence,
// every atom byte and every structural positional-key byte. Opaque handle
// internals are never visited. Limits are operational, not value semantics.
type Limits struct {
	MaxDepth int
	MaxNodes int
	MaxBytes int
}

func DefaultLimits() Limits { return Limits{MaxDepth: 256, MaxNodes: 100000, MaxBytes: 16 << 20} }
func (l Limits) valid() bool { return l.MaxDepth >= 0 && l.MaxDepth <= 512 && l.MaxNodes > 0 && l.MaxBytes >= 0 }

type Code string

const (
	Invalid Code = "invalid"
	InvalidLimits Code = "invalid-limits"
	Exhausted Code = "exhausted"
	NotGround Code = "not-ground"
)

type Error struct {
	Code Code
	Path []int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("ontos/wire %s at %v: %s", e.Code, e.Path, e.Message) }
func fail(code Code, path []int, message string) error { return &Error{code, slices.Clone(path), message} }

// Value is an admitted, immutable mixed value. The zero value is invalid.
// It exposes no universal equality, hash, codec or operational Wire method.
// The cached measures count occurrences even when immutable storage is shared.
type Value[C any] struct {
	node deixis.Node[Payload[C]]
	valid bool
	nodes int
	bytes int
	depth int
}

func (v Value[C]) Valid() bool { return v.valid }
func (v Value[C]) Kind() Kind {
	if !v.valid { return "" }
	return v.node.Own().Kind()
}
func (v Value[C]) Bytes() ([]byte, bool) {
	if !v.valid { return nil, false }
	return v.node.Own().Bytes()
}
func (v Value[C]) Handle() (C, bool) {
	if !v.valid { var zero C; return zero, false }
	return v.node.Own().Handle()
}
func (v Value[C]) Len() int { return v.node.Len() }

// Node exposes the exact immutable deixis representation. Payload accessors copy
// bytes and preserve opaque C; keys/children are protected by deixis itself.
func (v Value[C]) Node() (deixis.Node[Payload[C]], bool) { return v.node, v.valid }

// At is a positional observation. Re-admission uses the supplied limits and
// returns no usable value on failure. This avoids hidden unbounded traversal.
func (v Value[C]) At(index int, limits Limits) (Value[C], error) {
	if !v.valid || v.Kind() != Tuple || index < 0 || index >= v.Len() {
		return Value[C]{}, fail(Invalid, nil, "expected an existing tuple position")
	}
	node, _ := v.node.Get(pos.Key(uint64(index)))
	return Admit(node, limits)
}

func validate(l Limits) error {
	if !l.valid() { return fail(InvalidLimits, nil, "invalid depth, node or byte budget") }
	return nil
}

func childless[C any](payload Payload[C]) deixis.Node[Payload[C]] {
	node, _ := deixis.Compose(payload, nil) // No keys can collide.
	return node
}

func NewAtom[C any](bytes []byte, limits Limits) (Value[C], error) {
	if err := validate(limits); err != nil { return Value[C]{}, err }
	if len(bytes) > limits.MaxBytes { return Value[C]{}, fail(Exhausted, nil, "atom byte budget exceeded") }
	return Value[C]{node: childless(BytesPayload[C](core.NewAtom(bytes))), valid: true, nodes: 1, bytes: len(bytes)}, nil
}

// NewWire does constant structural work: one node, depth zero, zero data/key
// bytes. Even a nil C is structurally opaque; runtime recognition is separate.
func NewWire[C any](handle C) Value[C] {
	return Value[C]{node: childless(WirePayload(handle)), valid: true, nodes: 1}
}

func NewTuple[C any](items []Value[C], limits Limits) (Value[C], error) {
	if err := validate(limits); err != nil { return Value[C]{}, err }
	result := Value[C]{valid: true, nodes: 1}
	if len(items) > limits.MaxNodes-1 { return Value[C]{}, fail(Exhausted, nil, "tuple node budget exceeded") }
	for i, child := range items {
		path := []int{i}
		if !child.valid { return Value[C]{}, fail(Invalid, path, "invalid tuple child") }
		keyBytes := len(pos.Key(uint64(i)))
		if child.depth >= limits.MaxDepth || child.nodes > limits.MaxNodes-result.nodes || keyBytes > limits.MaxBytes-result.bytes || child.bytes > limits.MaxBytes-result.bytes-keyBytes {
			return Value[C]{}, fail(Exhausted, path, "tuple depth, node or byte budget exceeded")
		}
		result.nodes += child.nodes
		result.bytes += keyBytes + child.bytes
		result.depth = max(result.depth, child.depth+1)
	}
	entries := make([]deixis.Entry[Payload[C]], len(items))
	for i, child := range items { entries[i] = deixis.Entry[Payload[C]]{Key: pos.Key(uint64(i)), Node: child.node} }
	result.node, _ = deixis.Compose(Payload[C]{}, entries) // Positional keys are injective.
	return result, nil
}

type budget struct { limits Limits; nodes, bytes int }
func (b *budget) node(depth, childCount int, path []int) error {
	if depth > b.limits.MaxDepth || b.nodes >= b.limits.MaxNodes || childCount > b.limits.MaxNodes-b.nodes-1 {
		return fail(Exhausted, path, "node or depth budget exceeded")
	}
	b.nodes++
	return nil
}
func (b *budget) take(bytes int, path []int) error {
	if bytes > b.limits.MaxBytes-b.bytes { return fail(Exhausted, path, "atom/key byte budget exceeded") }
	b.bytes += bytes
	return nil
}

// Admit recognizes exactly the mixed profile, without normalization. It accepts
// native immutable deixis nodes rather than invoking arbitrary user tree methods.
// Known cardinality plus every exact positional key establishes a dense domain;
// Get avoids copying an unbounded child/key collection merely to check a limit.
func Admit[C any](node deixis.Node[Payload[C]], limits Limits) (Value[C], error) {
	if err := validate(limits); err != nil { return Value[C]{}, err }
	work := &budget{limits: limits}
	var visit func(deixis.Node[Payload[C]], int, []int) (int, error)
	visit = func(n deixis.Node[Payload[C]], depth int, path []int) (int, error) {
		if err := work.node(depth, n.Len(), path); err != nil { return 0, err }
		switch p := n.Own(); p.Kind() {
		case Atom, Capability:
			if n.Len() != 0 { return 0, fail(Invalid, path, "payload leaf has children") }
			if p.Kind() == Atom {
				if err := work.take(p.atom.Len(), path); err != nil { return 0, err }
			}
			return depth, nil
		case Tuple:
			height := depth
			for i := 0; i < n.Len(); i++ {
				key := pos.Key(uint64(i))
				childPath := append(slices.Clone(path), i)
				if err := work.take(len(key), childPath); err != nil { return 0, err }
				child, found := n.Get(key)
				if !found { return 0, fail(Invalid, childPath, "child keys are not exactly dense canonical positions") }
				d, err := visit(child, depth+1, childPath)
				if err != nil { return 0, err }
				height = max(height, d)
			}
			return height, nil
		default:
			return 0, fail(Invalid, path, "unknown payload alternative")
		}
	}
	depth, err := visit(node, 0, nil)
	if err != nil { return Value[C]{}, err }
	return Value[C]{node: node, valid: true, nodes: work.nodes, bytes: work.bytes, depth: depth}, nil
}

// Embed preserves ground values and their exact deixis positional layout.
// It is total semantically; operational budget exhaustion remains a refusal.
func Embed[C any](value core.Value, limits Limits) (Value[C], error) {
	if err := validate(limits); err != nil { return Value[C]{}, err }
	work := &budget{limits: limits}
	var visit func(core.Value, int, []int) (deixis.Node[Payload[C]], int, error)
	visit = func(value core.Value, depth int, path []int) (deixis.Node[Payload[C]], int, error) {
		var empty deixis.Node[Payload[C]]
		switch v := value.(type) {
		case core.Atom:
			if err := work.node(depth, 0, path); err != nil { return empty, 0, err }
			if err := work.take(v.Len(), path); err != nil { return empty, 0, err }
			return childless(BytesPayload[C](v)), depth, nil
		case core.Tuple:
			if err := work.node(depth, v.Len(), path); err != nil { return empty, 0, err }
			// Charge immediate keys before allocating the child collection.
			for i := 0; i < v.Len(); i++ {
				if err := work.take(len(pos.Key(uint64(i))), path); err != nil { return empty, 0, err }
			}
			entries := make([]deixis.Entry[Payload[C]], v.Len())
			height := depth
			for i := range entries {
				n, d, err := visit(v.At(i), depth+1, append(slices.Clone(path), i))
				if err != nil { return empty, 0, err }
				entries[i] = deixis.Entry[Payload[C]]{Key: pos.Key(uint64(i)), Node: n}
				height = max(height, d)
			}
			n, _ := deixis.Compose(Payload[C]{}, entries)
			return n, height, nil
		default:
			return empty, 0, fail(Invalid, path, "expected a ground Atom or Tuple")
		}
	}
	node, depth, err := visit(value, 0, nil)
	if err != nil { return Value[C]{}, err }
	return Value[C]{node: node, valid: true, nodes: work.nodes, bytes: work.bytes, depth: depth}, nil
}

// Recover returns a ground value exactly when the admitted input is wire-free.
// It never exports a handle or replaces it with a data reference. Failure has
// nil output; callers must not interpret Exhausted as proof of non-groundness.
func Recover[C any](value Value[C], limits Limits) (core.Value, error) {
	if err := validate(limits); err != nil { return nil, err }
	if !value.valid { return nil, fail(Invalid, nil, "expected an admitted value") }
	if value.nodes > limits.MaxNodes || value.bytes > limits.MaxBytes || value.depth > limits.MaxDepth {
		return nil, fail(Exhausted, nil, "recovery budget exceeded")
	}
	var visit func(deixis.Node[Payload[C]], []int) (core.Value, error)
	visit = func(n deixis.Node[Payload[C]], path []int) (core.Value, error) {
		switch p := n.Own(); p.Kind() {
		case Atom:
			return p.atom, nil
		case Capability:
			return nil, fail(NotGround, path, "live capability has no pure ground recovery")
		default:
			items := make([]core.Value, n.Len())
			for i := range items {
				child, _ := n.Get(pos.Key(uint64(i)))
				v, err := visit(child, append(slices.Clone(path), i))
				if err != nil { return nil, err }
				items[i] = v
			}
			return core.NewTuple(items...), nil
		}
	}
	return visit(value.node, nil)
}
