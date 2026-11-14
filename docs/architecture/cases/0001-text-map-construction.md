# `ONTOS-ACX-001`: text-key map construction belongs to ontos data

Status: implemented; qualification and consumer adoption are recorded below.

## Ownership failure

bitagent deployments, bindings and resource contributions locally implemented
the same conversion between native text-key entries and canonical ontos maps.
That algorithm needs only the map embedding and UTF-8 text producer/reader. Its
contract does not require bitagent, a resource runner, an account, or a gateway.
Leaving it in those consumers makes each independently responsible for canonical
map order, duplicate rejection, Unicode fidelity and map/key recognition.

This violates [AC-11](https://github.com/Bitspark/platform/blob/main/docs/concepts/architectural-correctness.md#ac-11)
(agnostic ownership from first implementation),
[AC-02](https://github.com/Bitspark/platform/blob/main/docs/concepts/architectural-correctness.md#ac-02)
(semantic ownership) and the correction obligation in
[AC-10](https://github.com/Bitspark/platform/blob/main/docs/concepts/architectural-correctness.md#ac-10).
This ontos-owned record concerns the shared capability. The bitagent-specific
removal remains [BITAGENT-ACX-012](https://github.com/Bitspark/bitagent/blob/main/docs/architecture-cases/0012-generic-form-and-map-constructors.md).

## Selected contract

The [specified API](../../spec/ontos-data.md#571-native-text-key-map-construction-and-reading)
accepts explicit entry sequences instead of host dictionaries. The sequence
retains duplicate intent so the map owner can reject it. Readers return ordered
entries instead of host objects, preserving codec order without JavaScript
property behavior. Arbitrary child Values remain unchanged.

ontos data implements the producer/reader; domain consumers call it while retaining
their field vocabulary, child encodings and policy. The implementation composes
the existing text and map codecs. It adds no label, normalization, recursive
conversion, schema, authority rule or alternate Value identity.

## Correction and qualification

The same public capability is implemented in TypeScript, Go, Rust and Python.
Each binding tests a hand-spelled common codec byte string with key order different
from native lexicographic order, duplicate refusal, Unicode fidelity, empty maps,
arbitrary children, and malformed map/non-text key rejection. The bindings whose
native strings permit invalid Unicode test its rejection. Existing map and text
implementations remain the sole owners of the underlying guarantees.

Repository tests and required PR checks qualify the change before landing. No
new vectors or embedding version are needed: the new producer's output is already
in the frozen map/text corpus domain. Consumer adoption and release selection do
not transfer field semantics to ontos. Consumers must use one coherent native
Value package graph; this API does not adapt between foreign constructors.
