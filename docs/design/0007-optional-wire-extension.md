# Optional Wire value extension

**Owner direction, 3 November 2026. Status: reviewed documentation proposal;
implementation and qualification remain future work.** The owner selected optional
`ontos/wire` and `horos/wire` extensions, replacing the proposed Bittype-owned
contract model, and required preservation of the existing concepts. No extension
package, implementation, dependency, vector, release or consumer migration is
introduced here. The coordinated work is tracked in [ontos issue 23](https://github.com/Bitspark/ontos/issues/23),
[horos issue 17](https://github.com/Bitspark/horos/issues/17) and
[bittype issue 35](https://github.com/Bitspark/bittype/issues/35).

The [coordinated expert consultation](https://github.com/Bitspark/bittype/blob/main/research-docs/0003-optional-wire-extensions.advice.md)
was evaluated against Ontos source at `a3f1d081f2e82f1e0ec39688c4060b5606b16c63`,
Deixis at `e0b0410d6f76d795992cc0a5792c507a19ef05ee` and the runtime sources pinned
below. The accepted recommendations are requirements in this proposal, not
evidence that the extension has been implemented or tested.

## 1. The explicit scope amendment

[ADR 0003](0003-layered-architecture.md) required every higher Ontos layer to
project totally to L0 and inherit its identity. That rule remains unchanged for
the frozen ground stack: `ontos/core`, `ontos/compound`, `ontos/data` and their
existing readings. This decision broadens repository ownership to permit a
separate optional mixed-value profile; it does not claim that live capabilities
are another conservative L1/L2 data reading. The earlier ADR body remains
historical evidence, with a forward-note identifying this amendment.

The chosen boundary is:

| Component | Responsibility |
| --- | --- |
| Deixis | Opaque own values, exact byte-keyed children and generic tree structure. |
| Existing Ontos ground stack | Ground values, their structural identity, canonical bytes and data readings. |
| Proposed `ontos/wire` | A recognized mixed value profile over Deixis, containing ground data and opaque sending capabilities. |
| Proposed `horos/wire` | Type/declaration meaning and explicit lifting over that profile. |
| Bittype | AST projections, analysis integration and language transformations for those definitions. |
| Bitwire / bitruntime | Interaction contracts and the existing realization of export, import, proxies and resource lifetime. |
| Contract libraries | Function, Stream, Cell and future contracts, including their behavior and native representations. |

The [Horos type proposal](https://github.com/Bitspark/horos/blob/main/docs/spec/wire-types.md)
owns type semantics. Bittype's [preservation map](https://github.com/Bitspark/bittype/blob/main/docs/wire-extension-preservation.md)
records where the existing declaration, lifting, native representation and runtime
adapter ideas move. These are conceptual extension names, not installed import
paths or promised native APIs. The optional value profile neither implements a
type checker nor introduces a second Bittype-owned value algebra.

## 2. Existing ground values and their Deixis projection

The [frozen Ontos core](../spec/ontos-core.md) remains:

```text
Value = Atom(Bytes) | Tuple(Value*)
```

Its values are finite, well-founded, immutable, complete and context-free. The
[existing optional projection](../../projection/deixis/PROJECTION.md) already
represents them as a recognized subset of `Deixis.Node<Option<Bytes>>`:

```text
P(Atom(b))             = Node(Some(b), no children)
P(Tuple(v0,...,v(n-1))) = Node(None, { kappa(i): P(vi) | 0 <= i < n })
```

`kappa` is the existing `deixis-pos-v1` exact byte spelling of a natural-number
position. `None` is an own value chosen by this profile, not an absent node,
missing field or null. An empty atom and an empty tuple are different childless
nodes. The inverse recognizes exactly the image of P; it never repairs sparse
positions, rekeys children, drops payloads or discards children.

The projection is implemented in Go, Rust and TypeScript with its shared authored
corpus. Its documented evidence ceiling remains unchanged. It does not equate
Deixis codec bytes with Ontos codec bytes: its byte-preservation law is recovery
to the original Ontos value followed by the existing Ontos codec.

## 3. Proposed mixed profile

Let `C` denote an opaque sending-capability carrier supplied by runtime
composition. The notation below specifies the proposed profile, not a Go type declaration
or a decision that the value package imports a runtime Wire interface:

```text
MixedPayload<C> = None
                | Some(BytesCase(bytes))
                | Some(WireCase(handle: C))

MixedValue<C> = the recognized subset of Deixis.Node<MixedPayload<C>> below
```

| Admitted form | Own value | Complete children |
| --- | --- | --- |
| Atom | `Some(BytesCase(bytes))` | None. |
| Wire | `Some(WireCase(handle))` | None. |
| Tuple | `None` | Exactly `kappa(0)` through `kappa(n-1)`, each holding an admitted mixed value. |

The sum alternatives are distinct even when bytes happen to encode a name or
reference. No pattern inside ordinary bytes or tuples makes them a capability.
The profile owns these restrictions; Deixis retains one opaque slot and no
Atom/Tuple/Wire node kinds. Its child structure remains finite and well-founded;
references inside an opaque capability are not traversed as structural children.

An arbitrary Deixis tree is not an admitted mixed value. Byte/Wire payloads with children,
non-positional or sparse child keys, alternate position spellings and malformed
descendants are refused exactly. The profile does not silently turn arbitrary
named Deixis children into tuple or record fields.

Structural admission of a capability payload does not establish runtime
recognition, authority, liveness or compliance with a message protocol. The
runtime decides which local/imported handles it accepts. Runtime composition must
provide sending faces, never endpoint owners: receiving, receive attachment and
closure authority must not become available or recoverable through a conveyed
Wire. Capturing an opaque handle does not itself attenuate its authority. A stale
handle can remain structurally valid; operational usability and scope expiry are
separate runtime checks. The native API for expressing the opaque carrier and
this boundary remains an implementation design obligation.

### Construction and observation

Deixis does not freeze the contents of its opaque slot. The mixed profile must
therefore capture byte contents and exact child keys/structure as stable,
immutable observations. Construction must not retain mutable caller-controlled
byte, key or child buffers; accessors must not expose mutable backing storage.
Sharing storage is permissible only when that storage already satisfies the
same immutability contract. This is a profile obligation, not a new Deixis rule.

Capability handles are retained as supplied references, not deep-copied runtime
objects. Capture and reconstruction of `Tuple(w, w)` retain both occurrences of
the same supplied handle and their aliasing. They do not replace one occurrence,
merge the two positions, clone the participant or allocate new exports. Immutable
value structure does not make a capability's runtime context or lifetime immutable.

### Ground embedding and recovery

The ground embedding applies the existing projection and injects each byte
payload into `BytesCase`. It preserves the shape and exact positional keys.
Ground recovery is an exact partial operation on admitted mixed values:

```text
embed   : Ontos.Value -> MixedValue<C>
recover : MixedValue<C> -> Ontos.Value or refusal
recover(embed(v)) = v
```

Recovery succeeds exactly on the wire-free admitted subset, by removing the
byte-case injection and using the existing ground recognizer. Re-embedding a
recovered value produces the same ground profile structure and bytes. Ground
identity is preserved in both directions, including empty atom versus empty
tuple, tuple order, nesting and repeated occurrences. No claim of literal native
type equality between independent packages follows from this correspondence.
Recognition of exactly the embedding's image describes this ground recovery
recognizer, not mixed-profile admission, which additionally admits Wire leaves.

Wire-free arbitrary Deixis nodes need not be recoverable; admission comes first.
There is no total pure projection of live mixed values to L0. Replacing a Wire
with its exported reference is a context-dependent runtime operation, not this
ground recovery operation or a conservative data embedding.

### Identity, aliasing and bytes

Mixed structure is available without a chosen relation on capability handles.
An optional identity operation must supply and justify the whole-slot relation;
it cannot infer capability equivalence from matching bytes, shapes, names or
host-language object representations. Ground byte equality and the distinction
between None, bytes and capabilities remain intact.

Reconstruction retains the supplied handles and their aliasing. It does not
clone a participant, resolve a name, merge distinct capabilities, close a borrowed
endpoint or invoke a send. A live handle can retain its runtime context without
making that context part of ground data or a Deixis structural child.

Reference identity, capability designation and export identity are distinct.
Reference identity concerns aliasing of supplied handles in a native process;
capability designation concerns the sending authority a runtime associates with
a handle; export identity concerns a context-scoped transport reference. Distinct
native proxies can designate the same authority, and exporting one capability
in different scopes can produce different references. Neither a matching export
description nor a different native object establishes universal capability
equality. Structural handle preservation does not prescribe cross-process
pointer identity or replace the runtime's export/import contract.

This proposal defines no canonical hash, global ordering or portable encoding
for live capability values. Existing `ontos-codec-v1` encodes recovered ground
values with exactly its existing bytes. Encoding transport reference descriptions
does not serialize endpoint ownership, ambient credentials or behavior. Decoding
those descriptions alone does not create a live capability.

### Bounded operations

Finiteness is a value law, not an operational resource bound. Implementations of
this optional profile must expose explicit node, depth and byte budgets for
recognition and conversion. Each operation must state its counting domain,
including repeated occurrences, structural key bytes and atom bytes, and check
bounds before large allocations. Opaque capability internals are never traversed
or counted as structural children. Runtime transport retains its separate,
explicit accounting for export-reference metadata and complete encoded frames.

Budget exhaustion is a distinct outcome from malformed structure, type mismatch
or runtime failure. It cannot be reported as proof that a finite value lies
outside the profile, silently truncate a value or weaken the exact recovery
laws. Lifting and specialization require their own explicit limits in the type
and tooling layers; their budget does not become an Ontos value constraint.

## 4. Dependency and runtime boundaries

The optional extension must preserve the dependency isolation already used by
the Deixis projection. Ordinary imports of Ontos core/codec/data acquire no
Deixis, Horos, Wire or runtime dependency. Deixis itself learns no Ontos profile
or Wire semantics. The optional value structure takes the opaque capability
carrier C; runtime composition supplies the actual sending faces and recognition.
It must not import bitwire merely to obtain an interface, or import bitruntime
to recognize or construct a handle. The eventual native packaging must demonstrate
this acyclic dependency boundary despite bitwire's existing Ontos use.

Static type descriptions and their tooling need no dependency on a live carrier
or runtime instance. Horos's optional type profile can describe a Wire operand,
and Bittype can process that description, without importing, creating or executing
an actual sending capability. Model ownership is not a linear dependency chain
from every ground package through Deixis, Wire and runtime.

The profile may be realized by optimized native representations that expose the
same values and laws. Selecting Deixis as the denotation does not require every
existing runtime to allocate another tree for every message or to change its
public native types without a qualified migration.

This concrete Wire profile does not require a general capability-extension
framework or a registry of live value kinds. An opaque carrier parameter is
sufficient for the present boundary. Introduce a broader abstraction only when a
second concrete extension demonstrates shared semantics that composition cannot
already express. Existing agnostic AST and provider registries remain unaffected.

Current Bitwire source at `e2d2d641744a49f1d8098b6ea5f2724454d72b96` defines
[hydrated values](https://github.com/Bitspark/bitwire/blob/e2d2d641744a49f1d8098b6ea5f2724454d72b96/docs/wire/hydrated-native.md)
as atoms, finite immutable tuples and runtime-recognized sending capabilities.
It uses a checked Ontos v0.9.0 consumer mirror, not the current standalone Ontos
package identity. Bitruntime source at
`64dbe709f2f002781a5010b08a6650c7eeb129df` implements
[scoped hydration](https://github.com/Bitspark/bitruntime/blob/64dbe709f2f002781a5010b08a6650c7eeb129df/hydrated/README.md):
export descriptors and ground frames cross transport; receiving composition
imports proxies. The present proposal does not change those sources, dependency
pins, frames, installed packages or deployments. Aligning them with this profile
is future work requiring the affected owners' contracts and qualification.

The distinct concepts remain: a live value, a ground description of its type,
a ground transport-reference description, and a native application value.
Hydration handles capabilities; library adapters handle application values and
protocol behavior. Type loading, tree navigation and type generation perform
none of that runtime work.

In particular, ending a hydration scope must invalidate its exports without
closing borrowed endpoints. Sending-face attenuation, scope lifetime and cleanup
remain runtime obligations. Function, Stream and Cell retain independent library
specifications and qualification for their protocol behavior; structural admission
and type conformance cannot establish cancellation, demand or terminal-race laws.

## 5. Preserved concepts and forbidden shortcuts

| Concept | Disposition |
| --- | --- |
| Frozen L0 identity, L1/L2 data readings and codec bytes | Unchanged; no live value is inserted into existing ground APIs. |
| Ontos-over-Deixis projection and positional keys | Reused as the ground profile; its exact image and evidence limits are retained. |
| Mixed data and capabilities | Proposed optional `ontos/wire` profile; no new general tree implementation. |
| Type declarations, generic application, specialization and explicit partial lifting | Owned by Horos and its proposed optional extension; no declaration/type semantics enter Ontos. |
| AST/CST tooling and native type representations | Bittype tooling and library-owned recipes, with explicit source/profile identities. |
| Wire recognition, export/import and lifetime | Existing runtime responsibilities; no implicit hydration in codecs or structure. |
| Function, Stream and Cell | Ordinary libraries; no special value cases, name switches, fingerprints or registrations here. |

Do not broaden L0 or the existing ground recognizer, claim a total live-to-ground
projection, inherit a portable identity for capabilities, accept ordinary
reference-looking data as live authority, or turn structure traversal into
resource management. Do not equate profile membership with type conformance or
protocol correctness. No compatibility decoder for the superseded Bittype
contract-model proposal is introduced.

## 6. Qualification before implementation is called delivered

Future implementation must name the profile and its version, define its native
admission boundaries and preserve the ground embedding/recovery laws. Authored
positive and refusal cases must cover empty atom/tuple separation, nesting,
multiplicity, exact positional keys, bytes resembling references and rejected
foreign structures. Mutation of source byte/key/child buffers and attempted
mutation through observations must not change a captured value. Capability tests
must preserve both occurrences and handle aliasing in `Tuple(w, w)`, and retain
sending authority without invoking, exporting or closing resources during
reconstruction.

Any optional identity/codec operation needs its own stated laws and evidence.
Qualification must distinguish exhaustion at each node/depth/byte bound from
invalid structure and show that no partially admitted value escapes a refused
operation. Runtime alignment must additionally qualify recognition, sending-only
attenuation, export/import, stale references, endpoint/scope lifetime and
local/network behavior against the existing contracts. A stale handle must not
become a malformed tree; closing a scope must not close a borrowed endpoint.
No such checks are represented as having run for this documentation-only proposal.

The evaluated consultation and the coordinated preservation map establish the
design requirements recorded here. The commitment is optional extension ownership
with unchanged ground cores, explicit boundaries and preserved concepts; a package
name alone is neither a complete native API nor implementation evidence.
