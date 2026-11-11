// Package tupleid is how core tells the codec that two core.Tuple values are the same
// tuple in memory. codec.Measure keys its memo on it (docs/spec/ontos-codec.md §10.3).
//
// Why this form: Go has no friend access, and core cannot import a package that names
// core.Tuple, because that package would import core. So the one function that reads a
// tuple's unexported child slice lives in core, where the compiler checks it against
// Tuple's fields, and core installs it in KeyOf when core is initialized. Go initializes
// a package before any package that imports it, so KeyOf is set before any codec code
// runs. The package is internal, so only this module can import it, and core's exported
// API is unchanged.
package tupleid

import "unsafe"

// Key identifies a tuple by its child storage: the address of its first child and its
// arity. Every copy of a core.Tuple shares its child slice, so all copies have one key.
// Two different tuples share a key only when both are empty: every empty tuple has the
// zero Key, and every empty tuple measures the same, so that is harmless. A non-empty
// tuple's key is its own, because core.NewTuple copies its children into a new slice that
// no other tuple holds and nothing writes to. If core ever let two tuples share a child
// array, keys would have to change with it.
//
// The address is only compared, never dereferenced. Holding it as an unsafe.Pointer keeps
// the array alive, so the address cannot be reused while a key exists.
type Key struct {
	first unsafe.Pointer
	arity int
}

// Of is the key of a tuple whose children are children. Only core calls it, with a
// tuple's own child slice.
func Of[V any](children []V) Key {
	if len(children) == 0 {
		return Key{}
	}
	return Key{first: unsafe.Pointer(&children[0]), arity: len(children)}
}

// KeyOf returns the key of tuple, which must be a core.Tuple. It takes the tuple as any
// because this package cannot name core.Tuple. Passing the core.Value that holds the
// tuple converts without allocating. core sets KeyOf when it is initialized, and only the
// codec calls it.
var KeyOf func(tuple any) Key
