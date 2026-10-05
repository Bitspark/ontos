// Command consumer-smoke exercises projection/deixis/go THE WAY A CONSUMER DOES, and
// it lives here rather than in the module's own tests because that is the whole point:
// the module's tests run with its in-repo `replace` in force, and a consumer never sees
// that replace.
//
// `replace` applies ONLY in the main module. So when someone outside this repo depends
// on github.com/bitspark/ontos/projection/deixis/go, the face's own
// `replace github.com/bitspark/ontos => ../../..` is IGNORED and `github.com/bitspark/ontos`
// resolves from the registry at whatever its `require` names. Measured 2026-08-21: CI
// verified `face + tree` while a consumer got `face + ontos v0.7.0`, nine commits apart.
// Benign that day, because the L0 floor is frozen — and an untested combination shipping
// to consumers regardless.
//
// The CI step that runs this builds a scratch module which `replace`s ONLY the face to
// this checkout, leaving ontos itself to resolve normally. That reproduces the consumer's
// resolution exactly, without editing any go.mod in the repo.
//
// ⚠ This directory is under `.github/`, which the go tool ignores (it skips paths whose
// element begins with `.` or `_`). That is deliberate: the file must NOT be compiled by
// the root module's `go build ./...`, or it would resolve the tree and prove nothing.
//
// It is deliberately face-specific rather than generic over nested modules. A second
// nested module needs its own smoke; pretending one program covers an unknown future
// module would be the vacuous-pass shape this repo keeps paying for.
package main

import (
	"errors"

	deixis "github.com/bitspark/deixis/core/go"
	pos "github.com/bitspark/deixis/pos/go"
	core "github.com/bitspark/ontos/core/go"
	projection "github.com/bitspark/ontos/projection/deixis/go"
)

func main() {
	// A value touching every arm of the floor: a nested tuple, the EMPTY tuple, and an
	// empty atom — the last two being law 6's pair, which a lax bridge merges first.
	v := core.NewTuple(
		core.NewAtom([]byte("a")),
		core.NewTuple(),
		core.NewAtom(nil),
		core.NewTuple(core.NewAtom([]byte{0x00, 0xff})),
	)

	back, err := projection.Recognize(projection.Project(v))
	if err != nil {
		panic("R refused P(v) across the consumer boundary: " + err.Error())
	}
	if !core.Equal(back, v) {
		panic("law 1 (R(P(v)) = v) violated across the consumer boundary")
	}

	// Law 6 must survive the boundary too: the empty atom and the empty tuple stay
	// distinct nodes, and each recognizes back to its own side.
	leaf := projection.Project(core.NewAtom([]byte{}))
	empty := projection.Project(core.NewTuple())
	a, err := projection.Recognize(leaf)
	if err != nil {
		panic("R refused P(Atom(\"\")): " + err.Error())
	}
	b, err := projection.Recognize(empty)
	if err != nil {
		panic("R refused P(Tuple()): " + err.Error())
	}
	if core.Equal(a, b) {
		panic("law 6 violated across the consumer boundary: empty atom and empty tuple merged")
	}

	// Refusal must still refuse — a face that accepts everything would pass every
	// assertion above. BOTH classes, because deixis v0.2.0's mandatory-value model
	// admits a shape the old leaf/struct sum could not express, and a consumer that
	// only ever saw the key refusal would not notice the other one going missing.
	shifted, err := projection.Recognize(shiftedDomain())
	if err == nil {
		panic("R ACCEPTED a shifted domain — the refusal path is dead: " + shifted.String())
	}
	if kindOf(err) != projection.KindKeyMismatch {
		panic("a shifted domain must refuse as key_mismatch, got: " + string(kindOf(err)))
	}

	beside, err := projection.Recognize(payloadBesideChildren())
	if err == nil {
		panic("R ACCEPTED a payload beside children: " + beside.String())
	}
	if kindOf(err) != projection.KindValueWithChildren {
		// Its key is a perfectly good κ(0), so blaming a key would be a false answer.
		panic("a payload beside children must refuse as value_with_children, got: " + string(kindOf(err)))
	}

	println("consumer smoke OK:", projection.Profile, "/", projection.PositionSpelling)
}

// kindOf reads the refusal class off the face's own error type, across the consumer
// boundary — so this also proves *Unrecognized is reachable and typed for a consumer,
// not just inside the module's own tests.
func kindOf(err error) projection.Kind {
	var u *projection.Unrecognized
	if !errors.As(err, &u) {
		panic("refusal is not a *projection.Unrecognized across the consumer boundary")
	}
	return u.Kind
}

// atomNode is P's atom shape, built by hand: Some(bytes) AND childless.
func atomNode(b []byte) projection.Node {
	n, err := deixis.Compose(deixis.Some(b), nil)
	if err != nil {
		panic("building an atom node failed: " + err.Error())
	}
	return n
}

// shiftedDomain builds a one-child tuple node keyed κ(1) instead of κ(0) — the `shifted`
// case. A consumer builds nodes by importing deixis directly, which is exactly what this
// does, so it also proves the face composes with the deixis packages rather than hiding
// them behind its own surface.
func shiftedDomain() projection.Node {
	n, err := deixis.Compose(deixis.None[[]byte](), []deixis.Entry[projection.Payload]{
		{Key: pos.Key(1), Node: atomNode([]byte("x"))},
	})
	if err != nil {
		panic("building the shifted fixture failed: " + err.Error())
	}
	return n
}

// payloadBesideChildren builds the shape the v0.1.0 sum could not express: a present own
// value AND a child. The child's key is exactly κ(0), so nothing is wrong with the
// domain — the node is refused on its shape alone.
func payloadBesideChildren() projection.Node {
	n, err := deixis.Compose(deixis.Some([]byte("payload")), []deixis.Entry[projection.Payload]{
		{Key: pos.Key(0), Node: atomNode(nil)},
	})
	if err != nil {
		panic("building the payload-beside-children fixture failed: " + err.Error())
	}
	return n
}
