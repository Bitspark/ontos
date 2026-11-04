# Optional wire values

The Go module `github.com/bitspark/ontos/wire/go` and TypeScript package
`@bitspark/ontos-wire` implement revision 1 of the
[optional mixed profile](../docs/design/0007-optional-wire-extension.md). It is
separate from the dependency-free ground modules. Rust continues to provide
the existing ground projection; no Rust mixed-value API is claimed.

`Value[C]` contains an admitted immutable deixis node. Its opaque carrier `C`
comes from runtime composition. Supply sending faces; this package neither
attenuates a full endpoint nor recognizes, invokes, closes or exports a handle.
It imports no bitwire, bitruntime or horos package.

Use `NewAtom`, `NewTuple` and constant-work `NewWire` to construct mixed values.
`Embed` preserves ground values. `Admit` recognizes native deixis nodes exactly;
it refuses payload-with-children, sparse or noncanonical keys and invalid
descendants. `Recover` returns a ground value exactly for admitted wire-free
values; it never replaces a Wire with reference data. Its output is nil on failure.

Every nonconstant construction/conversion takes explicit `Limits`. The accounting
counts root depth zero, every unfolded node occurrence, atom bytes and structural
key bytes. It excludes opaque carrier internals. Cached immutable measures allow
tuple construction/recovery preflight without rewalking shared children. Defaults
are depth 256, 100,000 nodes and 16 MiB; configured depth is 0..512, nodes positive
and bytes nonnegative. Exhaustion is distinct from malformed input or a live leaf.
Tuple allocation is preceded by immediate node/key bounds. Arbitrary user-defined
tree interfaces are not called by admission; use the native deixis carrier.

All byte/key/child observations own their storage. Opaque handles retain their
supplied native values and reference aliasing; opaque internals are never cloned.
The zero `Value` is invalid, while the zero native deixis node is the empty tuple.
No mixed equality, hashing, ordering, codec, hydration or protocol is provided.

Maintained test/lint targets discover this nested module. Tests cover exact
recognition, immutable capture, repeated handles, operational limits, ground
identity/codec preservation, authored negative cases and concurrent observations.
The [compact native realization](NATIVE.md) shares tuple structure with consumers
while leaving leaf recognition to their own private factories. Its native costs
and limits are distinct from the explicit Deixis conversions described above.
Runtime hydration and sending remain separate consumer implementations.
