# Compact native realization

The Go and TypeScript implementations of `ontos/wire` provide two qualified
representations of the same mixed value domain. `Value[C]` is the explicit,
bounded deixis representation. `NativeValue` retains ordinary ground atoms and
tuples, opaque carrier leaves, and immutable `NativeTuple` structure. This is
the optimized realization allowed by [design 0007](../docs/design/0007-optional-wire-extension.md).
Neither representation adds live capabilities to ground ontos.

## Ownership and qualification

`NativeFactory` owns tuple capture, ground collapse and structural observations.
Its caller supplies one leaf-capture function. A runtime uses that function to
recognize its sending faces and to project endpoint owners to those faces.
The function must not send, export or test liveness. Recognition is separate
from whether a later operation succeeds. Capturing an already recognized carrier
must preserve that exact carrier; projecting an owner must return its stable
sending face. These caller policy laws preserve aliases across repeated capture.

Each factory has an unforgeable private identity. Its tuples retain that identity
and immutable immediate children. Capturing one of its own tuples is constant
work: its descendants were already captured. A tuple made under another factory
is refused, even if its native class is the same. Public structural construction
cannot manufacture qualification under a runtime's private policy.

Ground values retain their native identity. A tuple with only ground children
becomes the ground tuple. Mixed descendants and repeated carrier leaves retain
their sharing; byte and child observations cannot mutate the captured structure.
The carrier alternative must be disjoint from ground atoms, ground tuples and
native tuples. Converting an explicit WireCase carrying one of those alternatives
is refused rather than silently changing its kind. Wrap such a carrier in a
distinct opaque native object if it is required by a composition.

## Costs and limits

Native tuple construction copies and qualifies only its immediate children. It
does not unfold a shared tree, traverse an already qualified tuple, or impose
the explicit deixis conversion's depth/node/key-byte budgets. Existing runtimes
can therefore preserve constant-work local delivery and their own send budgets.

`ProjectNative` / `projectNative` explicitly converts qualified native values to
`Value[C]`. `NativeFromValue` / `nativeFromValue` explicitly converts back through
the receiving factory's leaf policy. Both take structural limits. Exhaustion
returns no usable output. These conversions count every unfolded node occurrence
and structural positional-key byte; they are not transport admission checks.
Recovering a ground value remains exact and refuses live leaves. It never exports
a capability or replaces one by reference data.

## Dependency and protocol boundary

Import `github.com/bitspark/ontos/wire/go` or `@bitspark/ontos-wire/native`.
Neither imports bitwire, bitruntime, bitnode, horos or any contract library.
There is no registry, universal fingerprint, transport codec or built-in
Function, Stream or Cell kind. The carrier parameter belongs to the composition.

The bitwire hydrated protocol retains its reference/frame grammar. Runtimes
retain endpoint ownership, received context, alias recognition, export staging,
scope, namespace and lifetime. Structural qualification alone establishes none
of those operational properties.

## Qualification

Both native implementations test exact ground/codec preservation, opaque alias
preservation, immutable capture, foreign-factory refusal, structural-alternative
disjointness, bounded explicit conversion, 15,000-level native construction and
local capture of a shared tree with over a trillion unfolded occurrences.
Consumer runtime conformance additionally qualifies send-only projection,
foreign handles, limits, scope/lifetime and network interoperability.

This decision follows the owner's 4 November 2026 migration instruction and the
independent review of existing runtime observations. Native representation is
shared code; runtime authority is supplied policy, not an ontos interpretation.
