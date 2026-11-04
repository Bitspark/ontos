package wire

import (
	"errors"
	"slices"

	deixis "github.com/bitspark/deixis/core/go"
	pos "github.com/bitspark/deixis/pos/go"
	core "github.com/bitspark/ontos/core/go"
)

// NativeValue is the compact native realization: a ground Atom/Tuple, an
// immutable NativeTuple[C], or an opaque C recognized by its NativeFactory.
// The open Go union is checked by Capture; interface satisfaction is insufficient.
// Ground values keep their native identity. This is not a ground core.Value.
type NativeValue = any

// NativeTuple owns structure, not authority. Its factory's private identity
// proves only that its immediate children were captured by that same policy.
// Native construction does not unfold sharing or apply Deixis conversion limits.
type NativeTuple[C any] struct {
	items []NativeValue
	owner *nativeIdentity
}

type nativeIdentity struct{ marker byte }

func (t NativeTuple[C]) Len() int { return len(t.items) }
func (t NativeTuple[C]) At(i int) NativeValue { return t.items[i] }
func (t NativeTuple[C]) Items() []NativeValue { return slices.Clone(t.items) }

// NativeFactory composes a caller-owned leaf policy with shared immutable value
// structure. capture must recognize/attenuate a leaf without sending, exporting
// or testing liveness. Ontos never supplies a runtime capability policy.
type NativeFactory[C any] struct {
	owner *nativeIdentity
	capture func(NativeValue) (C, error)
}

var ErrNativeValue = errors.New("ontos/wire: unqualified native value")

func NewNativeFactory[C any](capture func(NativeValue) (C, error)) *NativeFactory[C] {
	return &NativeFactory[C]{owner: &nativeIdentity{marker: 1}, capture: capture}
}

// Capture is shallow: a factory-owned immutable tuple already qualified its
// children. A tuple made under another policy is not proof under this policy.
func (f *NativeFactory[C]) Capture(value NativeValue) (NativeValue, error) {
	if f == nil || f.owner == nil || f.capture == nil { return nil, ErrNativeValue }
	switch v := value.(type) {
	case core.Atom, core.Tuple:
		return value, nil
	case NativeTuple[C]:
		if v.owner == nil && len(v.items) == 0 { return core.NewTuple(), nil }
		if v.owner == f.owner { return v, nil }
		return nil, ErrNativeValue
	}
	handle, err := f.capture(value)
	if err != nil { return nil, err }
	// C must be disjoint from the native structural alternatives. Otherwise a
	// WireCase would become indistinguishable from an AtomCase or TupleCase.
	switch any(handle).(type) {
	case core.Atom, core.Tuple, NativeTuple[C]:
		return nil, ErrNativeValue
	}
	return handle, nil
}

// Tuple captures only its immediate children. Wire-free tuples collapse to the
// original ground representation. Shared mixed descendants remain shared.
func (f *NativeFactory[C]) Tuple(items ...NativeValue) (NativeValue, error) {
	if f == nil || f.owner == nil || f.capture == nil { return nil, ErrNativeValue }
	captured := make([]NativeValue, len(items))
	ground := make([]core.Value, len(items))
	live := false
	for i, item := range items {
		v, err := f.Capture(item)
		if err != nil { return nil, err }
		captured[i] = v
		if g, ok := v.(core.Value); ok { ground[i] = g } else { live = true }
	}
	if !live { return core.NewTuple(ground...), nil }
	return NativeTuple[C]{items: captured, owner: f.owner}, nil
}

// NativeItems observes structure, without establishing capability recognition.
func NativeItems[C any](value NativeValue) ([]NativeValue, bool) {
	switch v := value.(type) {
	case NativeTuple[C]:
		return v.Items(), true
	case core.Tuple:
		items := make([]NativeValue, v.Len())
		for i := range items { items[i] = v.At(i) }
		return items, true
	}
	return nil, false
}

// ProjectNative explicitly converts a qualified compact value to the bounded
// Deixis representation. Its limits are structural, never a runtime send budget.
func ProjectNative[C any](factory *NativeFactory[C], value NativeValue, limits Limits) (Value[C], error) {
	if err := validate(limits); err != nil { return Value[C]{}, err }
	value, err := factory.Capture(value)
	if err != nil { return Value[C]{}, err }
	work := &budget{limits: limits}
	var visit func(NativeValue, int, []int) (Value[C], error)
	visit = func(value NativeValue, depth int, path []int) (Value[C], error) {
		var count int
		var at func(int) NativeValue
		switch v := value.(type) {
		case core.Atom:
			if err := work.node(depth, 0, path); err != nil { return Value[C]{}, err }
			if err := work.take(v.Len(), path); err != nil { return Value[C]{}, err }
			return NewAtom[C](v.Bytes(), limits)
		case core.Tuple:
			count, at = v.Len(), func(i int) NativeValue { return v.At(i) }
		case NativeTuple[C]:
			count, at = v.Len(), v.At
		default:
			if err := work.node(depth, 0, path); err != nil { return Value[C]{}, err }
			handle, ok := value.(C)
			if !ok { return Value[C]{}, ErrNativeValue }
			return NewWire(handle), nil
		}
		if err := work.node(depth, count, path); err != nil { return Value[C]{}, err }
		for i := 0; i < count; i++ {
			if err := work.take(len(pos.Key(uint64(i))), path); err != nil { return Value[C]{}, err }
		}
		children := make([]Value[C], count)
		for i := range children {
			child, err := visit(at(i), depth+1, append(slices.Clone(path), i))
			if err != nil { return Value[C]{}, err }
			children[i] = child
		}
		return NewTuple(children, limits)
	}
	return visit(value, 0, nil)
}

// NativeFromValue explicitly qualifies a bounded Deixis value under a native
// factory. An opaque handle in Value is never itself evidence of recognition.
func NativeFromValue[C any](factory *NativeFactory[C], value Value[C], limits Limits) (NativeValue, error) {
	if err := validate(limits); err != nil { return nil, err }
	if !value.valid { return nil, fail(Invalid, nil, "expected an admitted value") }
	if value.nodes > limits.MaxNodes || value.bytes > limits.MaxBytes || value.depth > limits.MaxDepth {
		return nil, fail(Exhausted, nil, "native conversion budget exceeded")
	}
	var visit func(deixis.Node[Payload[C]]) (NativeValue, error)
	visit = func(node deixis.Node[Payload[C]]) (NativeValue, error) {
		switch payload := node.Own(); payload.Kind() {
		case Atom: return payload.atom, nil
		case Capability:
			// Explicit WireCase may not collapse into a structural alternative.
			switch any(payload.handle).(type) {
			case core.Atom, core.Tuple, NativeTuple[C]: return nil, ErrNativeValue
			}
			return factory.Capture(payload.handle)
		default:
			items := make([]NativeValue, node.Len())
			for i := range items {
				child, _ := node.Get(pos.Key(uint64(i)))
				v, err := visit(child)
				if err != nil { return nil, err }
				items[i] = v
			}
			return factory.Tuple(items...)
		}
	}
	return visit(value.node)
}
