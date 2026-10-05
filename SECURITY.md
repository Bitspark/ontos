# Security

## Reporting

Report a vulnerability privately, through GitHub's *Report a vulnerability* on this
repository's Security tab, and not in an issue or a pull request. Say what the flaw is,
where it is, and how to observe it. A byte string, the implementation that misjudges it and
the verdict you expected are enough. You will hear back within five working days with
whether it is confirmed and what the fix will be.

## Scope

ontos judges bytes. Its codec, `ontos-codec-v1` ([docs/spec/ontos-codec.md](docs/spec/ontos-codec.md)),
turns a value into exactly one byte string and turns untrusted bytes back into a value or a
rejection code. Consumers sign and hash over those bytes: a signature is made over the
canonical encoding of a value, and a hash names a value by it. They trust ontos to say
*these bytes are exactly this value*, and nothing else. A way to make it say that falsely
is a security report.

Concretely, in any of the four implementations (Go, Rust and TypeScript, which are
published, and Python, which validates them):

- **Two encodings of one value, or one encoding of two values.** The codec is canonical:
  a value has exactly one encoding, and a decoder that accepts a non-canonical spelling (a
  uvarint that is not in shortest form, trailing bytes, an unknown tag) lets two parties
  disagree about which bytes a value is. That is how a signature comes to verify in one
  language and fail in another.
- **An accepted input the specification rejects.** A decoder that returns a value for
  bytes [the codec specification](docs/spec/ontos-codec.md) rejects is a report, whatever
  value it returns.
- **A resource the limits do not bound.** Each implementation documents its resource
  limits (ontos-codec.md §4.1) and must reject input beyond them, never truncate it or
  partially accept it. Input that makes an implementation crash, hang or allocate far
  beyond the input it was given, instead of returning a rejection code, is a denial of
  service.
- **A misread embedding.** The registered embeddings ([docs/spec/ontos-data.md](docs/spec/ontos-data.md))
  give an integer, a text, a decimal, a map and the rest one canonical form each. A
  recognizer that accepts a value outside that form, or a producer that returns a value
  for a host value outside the embedding's domain (§4.1: replacing a character, rounding,
  truncating, coercing), is a report. The same holds for the JSON projection
  ([docs/spec/ontos-data-json.md](docs/spec/ontos-data-json.md)) and for the deixis
  projection's laws ([projection/deixis/PROJECTION.md](projection/deixis/PROJECTION.md)).
- **A divergence between the implementations.** The four are held to one corpus in
  `vectors/` on purpose. If they disagree about whether some bytes are a valid encoding,
  which value they encode, or which rejection they earn, that disagreement is itself the
  vulnerability, because a consumer's two ends may not be in the same language.

## Not in scope

**What a value means is not here.** ontos carries values and assigns them no meaning. A
flaw in how a consumer interprets a value, which values it chooses to trust, or how it
signs, hashes or stores the bytes is reported to that consumer.

**A documented limit is not a divergence.** An implementation may stop at a documented
resource limit with `limit_exceeded`. Where those limits differ between languages, they
differ only on input that is already truncated in every implementation, so the
implementations still agree about which byte strings are valid (ontos-codec.md §4.1). A
limit that makes one implementation *accept* what another rejects is in scope.

The CLIs, the conformance harness, the fuzzing tools and the vector tooling are developer
tooling that runs on a checkout's own files; a flaw in them is a bug, unless what it shows
is a library misjudging bytes.

## Supported versions

The latest minor release is supported, in all languages together: one version number
spans every registry and tag, so a fix ships as a new release across the implementations
rather than a patch to one of them.

`ontos-codec-v1` is frozen, and a security fix never changes its byte mapping. A fix brings
an implementation back into line with the specification. If the specification itself were
at fault, the remedy would be a new codec version under a new name, never an edit to v1.
