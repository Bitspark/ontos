package wire_test

import (
	"bytes"
	"errors"
	"testing"

	codec "github.com/bitspark/ontos/codec/go"
	core "github.com/bitspark/ontos/core/go"
	wire "github.com/bitspark/ontos/wire/go"
)

func TestNativeQualificationAndGroundIdentity(t *testing.T) {
	h := &handle{}
	factory := wire.NewNativeFactory(func(v any) (*handle, error) {
		if v == h {
			return h, nil
		}
		return nil, wire.ErrNativeValue
	})
	other := wire.NewNativeFactory(func(v any) (*handle, error) { return h, nil })
	ground := core.NewTuple(core.NewAtom([]byte("x")))
	v, err := factory.Tuple(ground)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := v.(core.Tuple); !ok {
		t.Fatal("wire-free tuple did not collapse")
	}
	projected, err := wire.ProjectNative(factory, v, limits)
	if err != nil {
		t.Fatal(err)
	}
	recovered, err := wire.Recover(projected, limits)
	if err != nil || !bytes.Equal(codec.Encode(v.(core.Value)), codec.Encode(recovered)) {
		t.Fatal("ground bytes changed", err)
	}
	items := []any{ground, h, h}
	mixed, err := factory.Tuple(items...)
	if err != nil {
		t.Fatal(err)
	}
	items[1] = nil
	observed, _ := wire.NativeItems[*handle](mixed)
	if observed[1] != h || observed[2] != h {
		t.Fatal("handle alias lost")
	}
	observed[1] = nil
	observed, _ = wire.NativeItems[*handle](mixed)
	if observed[1] != h {
		t.Fatal("tuple storage leaked")
	}
	foreign, _ := other.Tuple(h)
	if _, err := factory.Capture(foreign); !errors.Is(err, wire.ErrNativeValue) {
		t.Fatal("foreign policy trusted", err)
	}
	projected, err = wire.ProjectNative(factory, mixed, limits)
	if err != nil {
		t.Fatal(err)
	}
	back, err := wire.NativeFromValue(factory, projected, limits)
	if err != nil {
		t.Fatal(err)
	}
	observed, _ = wire.NativeItems[*handle](back)
	if observed[1] != h || observed[2] != h {
		t.Fatal("conversion changed opaque aliases")
	}
}

func TestNativeLocalCaptureDoesNotUnfoldSharingOrLimitDepth(t *testing.T) {
	h := &handle{}
	calls := 0
	factory := wire.NewNativeFactory(func(v any) (*handle, error) { calls++; return v.(*handle), nil })
	var shared any = h
	for i := 0; i < 40; i++ {
		shared, _ = factory.Tuple(shared, shared)
	}
	var deep any = h
	for i := 0; i < 15000; i++ {
		deep, _ = factory.Tuple(deep)
	}
	before := calls
	if _, err := factory.Capture(shared); err != nil {
		t.Fatal(err)
	}
	if _, err := factory.Capture(deep); err != nil {
		t.Fatal(err)
	}
	if calls != before {
		t.Fatal("capture traversed immutable children")
	}
	bounded := limits
	bounded.MaxNodes = 50
	_, err := wire.ProjectNative(factory, shared, bounded)
	var problem *wire.Error
	if !errors.As(err, &problem) || problem.Code != wire.Exhausted {
		t.Fatal("shared expansion did not exhaust", err)
	}
	_, err = wire.ProjectNative(factory, deep, limits)
	if !errors.As(err, &problem) || problem.Code != wire.Exhausted {
		t.Fatal("explicit projection lost depth bound", err)
	}
}

func TestNativeWireCaseCannotCollapse(t *testing.T) {
	factory := wire.NewNativeFactory(func(v any) (any, error) { return v, nil })
	for _, h := range []any{core.NewAtom(nil), core.NewTuple(), wire.NativeTuple[any]{}} {
		if _, err := wire.NativeFromValue(factory, wire.NewWire(h), limits); !errors.Is(err, wire.ErrNativeValue) {
			t.Fatal("WireCase collapsed", err)
		}
	}
}
