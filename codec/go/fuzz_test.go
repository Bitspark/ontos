package codec

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/bitspark/ontos/core/go"
)

// This file hardens the SECURITY-CRITICAL ontos-codec-v1 decoder, which consumes
// untrusted bytes. It establishes three properties, dependency-free (a small
// hand-rolled LCG; no fast-check / gopter / testing/quick value generators):
//
//	P1 decode NEVER panics on arbitrary input — it only ever returns a typed
//	   *DecodeError (no index-out-of-bounds, no slice-bound overflow, no blowup).
//	P2 CANONICAL IDEMPOTENCE — the decoder accepts only canonical bytes, so if
//	   Decode(b) succeeds then Encode(Decode(b)) == b exactly.
//	P3 ROUND-TRIP on valid values — for randomly built Value trees,
//	   Decode(Encode(v)) is structurally Equal to v.
//
// FuzzDecode drives P1+P2 under Go native fuzzing (and its seed corpus, drawn
// from the conformance vectors, also runs under plain `go test`). TestCodecProperties
// drives P1+P2 over 50k random byte buffers and P3 over thousands of random values.

// ---------------------------------------------------------------------------
// Deterministic PRNG: a 64-bit linear congruential generator (no imports, no
// crate). Constants are Knuth's MMIX multiplier + an odd increment.
// ---------------------------------------------------------------------------

type lcg struct{ state uint64 }

func newLCG(seed uint64) *lcg { return &lcg{state: seed} }

func (r *lcg) next() uint64 {
	r.state = r.state*6364136223846793005 + 1442695040888963407
	return r.state
}

// uintn returns a value in [0, n). n must be > 0.
func (r *lcg) uintn(n int) int {
	if n <= 1 {
		return 0
	}
	// Use the high bits (better distributed than the low bits of an LCG).
	return int((r.next() >> 33) % uint64(n))
}

func (r *lcg) byteVal() byte { return byte(r.next() >> 56) }

// randBytes builds a byte slice of length [0, maxLen].
func (r *lcg) randBytes(maxLen int) []byte {
	n := r.uintn(maxLen + 1)
	b := make([]byte, n)
	for i := range b {
		b[i] = r.byteVal()
	}
	return b
}

// ---------------------------------------------------------------------------
// Random valid Value trees (atoms of random bytes, tuples of small arity,
// bounded depth) — the P3 generator. Total node count is capped so a pathological
// branch cannot explode.
// ---------------------------------------------------------------------------

const (
	p3MaxDepth   = 6  // tree depth bound
	p3MaxArity   = 5  // tuple arity bound
	p3MaxAtomLen = 16 // atom byte-length bound
	p3MaxNodes   = 64 // total nodes per tree (hard cap)
)

func (r *lcg) randValue(depth int, budget *int) core.Value {
	*budget--
	// Force a leaf when out of depth or node budget; ~40% leaves otherwise.
	if depth <= 0 || *budget <= 0 || r.uintn(5) < 2 {
		return core.NewAtom(r.randBytes(p3MaxAtomLen))
	}
	arity := r.uintn(p3MaxArity + 1)
	items := make([]core.Value, 0, arity)
	for i := 0; i < arity && *budget > 0; i++ {
		items = append(items, r.randValue(depth-1, budget))
	}
	return core.NewTuple(items...)
}

func (r *lcg) buildValue() core.Value {
	budget := p3MaxNodes
	return r.randValue(p3MaxDepth, &budget)
}

// ---------------------------------------------------------------------------
// Seed corpus: every byte string the conformance vectors say is a valid encoding
// (codec.json `encode` + data.json `encode`), plus the rejected shapes (which
// must NOT panic and must NOT decode), plus a few raw edge literals.
// ---------------------------------------------------------------------------

// hexCase mirrors the {name, hex} shape shared by the encode/reject arrays.
type hexCase struct {
	Hex string `json:"hex"`
}

// readVectorsTB reads a vectors/<name> JSON file into `into`. It mirrors the
// readVectors helper in vectors_test.go but accepts testing.TB so it can serve
// both FuzzDecode (*testing.F) and TestCodecProperties (*testing.T).
func readVectorsTB(tb testing.TB, name string, into any) {
	tb.Helper()
	wd, err := os.Getwd()
	if err != nil {
		tb.Fatalf("getwd: %v", err)
	}
	path := filepath.Join(wd, "..", "..", "vectors", name)
	data, err := os.ReadFile(path)
	if err != nil {
		tb.Fatalf("read %s: %v", path, err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		tb.Fatalf("parse %s: %v", path, err)
	}
}

// seedHexes returns the fuzz seed corpus: every byte string the conformance
// vectors say is a valid encoding (codec.json + data.json `encode`), the rejected
// shapes (which must NOT panic and must NOT decode), and a few raw edge literals.
func seedHexes(tb testing.TB) [][]byte {
	tb.Helper()
	var seeds [][]byte
	add := func(h string) {
		b, err := hex.DecodeString(h)
		if err != nil {
			tb.Fatalf("bad seed hex %q: %v", h, err)
		}
		seeds = append(seeds, b)
	}

	// Valid encodings from codec.json (encode) — these decode and are idempotent.
	var codecDoc struct {
		Encode []hexCase `json:"encode"`
		Reject []hexCase `json:"reject"`
	}
	readVectorsTB(tb, "codec.json", &codecDoc)
	for _, c := range codecDoc.Encode {
		add(c.Hex)
	}
	// Rejected shapes — exercise the error paths (skip the empty-input case, which
	// hex-decodes to a zero-length slice that f.Add would just dedupe anyway).
	for _, c := range codecDoc.Reject {
		if c.Hex != "" {
			add(c.Hex)
		}
	}

	// L2 embedding encodings from data.json — full ontos-codec-v1 byte strings.
	var dataDoc struct {
		Encode []hexCase `json:"encode"`
	}
	readVectorsTB(tb, "data.json", &dataDoc)
	for _, c := range dataDoc.Encode {
		add(c.Hex)
	}

	// A few raw edge literals: empty, a bare tag, an unknown tag, a truncated
	// tuple, a stray byte, a non-terminated long uvarint.
	seeds = append(seeds, []byte{})
	for _, h := range []string{"00", "01", "0200", "ff", "0180808080"} {
		add(h)
	}
	return seeds
}

// checkDecode runs P1+P2 on a single input: Decode must never panic (Go would
// abort the test on an unrecovered panic), and any successful decode must
// re-encode to the exact input (canonical idempotence).
func checkDecode(tb testing.TB, b []byte) {
	tb.Helper()
	v, err := Decode(b)
	if err != nil {
		return // a typed rejection — P1 holds (no panic), nothing to re-encode.
	}
	if got := Encode(v); !bytes.Equal(got, b) {
		tb.Fatalf("idempotence violated: Decode succeeded but Encode(Decode(b)) != b\n  in:  %x\n  out: %x", b, got)
	}
}

// FuzzDecode is the Go native-fuzzing entry point. Its seed corpus (the
// conformance vectors) also runs under plain `go test`, exercising P1 on every
// seed and P2 on the valid ones.
func FuzzDecode(f *testing.F) {
	for _, seed := range seedHexes(f) {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		checkDecode(t, b)
	})
}

// ---------------------------------------------------------------------------
// TestCodecProperties: the plain-`go test` driver for P1, P2, P3.
// ---------------------------------------------------------------------------

func TestCodecProperties(t *testing.T) {
	const (
		seed       uint64 = 0x6F6E746F73636463 // "ontoscdc"
		byteIters         = 50000              // P1 + P2 over random byte buffers
		maxBufLen         = 64                 // random buffer length bound
		valueIters        = 20000              // P3 over random valid Value trees
	)

	// --- P1 + P2 on seed corpus first (the vectors), so failures point at a known
	// shape before the random storm. ---
	for _, b := range seedHexes(t) {
		checkDecode(t, b)
	}

	// --- P1 + P2: 50k arbitrary byte buffers up to 64 bytes. Decode must never
	// panic; any buffer that decodes must be canonical (Encode(Decode(b)) == b). ---
	r := newLCG(seed)
	decoded := 0
	for i := 0; i < byteIters; i++ {
		b := r.randBytes(maxBufLen)
		v, err := Decode(b)
		if err != nil {
			continue // typed rejection; P1 holds.
		}
		decoded++
		if got := Encode(v); !bytes.Equal(got, b) {
			t.Fatalf("P2 idempotence violated on random buffer #%d\n  in:  %x\n  out: %x", i, b, got)
		}
	}
	t.Logf("P1/P2: decoded %d of %d random byte buffers (rest rejected, none panicked)", decoded, byteIters)

	// Biased buffers: prefix a valid tag so more inputs reach deeper decode paths
	// (more atoms/tuples actually materialize, exercising P2 harder).
	rb := newLCG(seed ^ 0x9E3779B97F4A7C15)
	biasedDecoded := 0
	for i := 0; i < byteIters; i++ {
		tail := rb.randBytes(maxBufLen - 1)
		tag := byte(rb.uintn(3)) // 0x00 atom, 0x01 tuple, 0x02 unknown
		b := append([]byte{tag}, tail...)
		v, err := Decode(b)
		if err != nil {
			continue
		}
		biasedDecoded++
		if got := Encode(v); !bytes.Equal(got, b) {
			t.Fatalf("P2 idempotence violated on biased buffer #%d\n  in:  %x\n  out: %x", i, b, got)
		}
	}
	t.Logf("P1/P2: decoded %d of %d tag-biased buffers (rest rejected, none panicked)", biasedDecoded, byteIters)

	// --- P3: round-trip on randomly generated valid Value trees. ---
	// Derive a distinct P3 stream seed at runtime (a constant product would
	// overflow the uint64 compile-time domain; the wrap is intentional here).
	var p3Seed uint64 = seed
	p3Seed *= 2654435761
	rv := newLCG(p3Seed)
	maxObservedDepth := 0
	for i := 0; i < valueIters; i++ {
		v := rv.buildValue()
		enc := Encode(v)
		back, err := Decode(enc)
		if err != nil {
			t.Fatalf("P3: Decode(Encode(v)) failed on value #%d: %v\n  value: %s\n  enc:   %x", i, err, v, enc)
		}
		if !core.Equal(back, v) {
			t.Fatalf("P3: round-trip mismatch on value #%d\n  want: %s\n  got:  %s\n  enc:  %x", i, v, back, enc)
		}
		// Re-encode the decoded value: must reproduce the same canonical bytes
		// (ties P3 back to P2 — the encoding is deterministic and canonical).
		if reEnc := Encode(back); !bytes.Equal(reEnc, enc) {
			t.Fatalf("P3/P2: re-encode of round-tripped value #%d differs\n  enc:    %x\n  re-enc: %x", i, enc, reEnc)
		}
		if d := treeDepth(v); d > maxObservedDepth {
			maxObservedDepth = d
		}
	}
	t.Logf("P3: round-tripped %d random valid values (max observed depth %d)", valueIters, maxObservedDepth)

	// --- P1 + P2 (structured): mutate the encoding of a random valid value by one
	// byte and re-run decode. Single-byte mutations of a canonical encoding land
	// far more often in the decode-success branch than uniform-random bytes do, so
	// this stresses P2 (canonical idempotence) on inputs with real nested
	// structure — and still asserts P1 (no panic) on the rejections. ---
	rm := newLCG(seed ^ 0x123456789ABCDEF0)
	mutDecoded, mutChanged := 0, 0
	for i := 0; i < valueIters; i++ {
		enc := Encode(rm.buildValue())
		mutated := make([]byte, len(enc))
		copy(mutated, enc)
		if len(mutated) > 0 {
			pos := rm.uintn(len(mutated))
			delta := byte(1 + rm.uintn(255)) // never 0 — guarantee a real change
			mutated[pos] += delta
		}
		if !bytes.Equal(mutated, enc) {
			mutChanged++
		}
		v, err := Decode(mutated)
		if err != nil {
			continue // P1: typed rejection, no panic.
		}
		mutDecoded++
		if got := Encode(v); !bytes.Equal(got, mutated) {
			t.Fatalf("P2 idempotence violated on mutated encoding #%d\n  in:  %x\n  out: %x", i, mutated, got)
		}
	}
	t.Logf("P1/P2: mutated %d valid encodings (%d byte-changed); %d still decoded, all idempotent, none panicked", valueIters, mutChanged, mutDecoded)
}

// treeDepth reports the depth of a value tree (atom = 1) for diagnostics.
func treeDepth(v core.Value) int {
	tup, ok := v.(core.Tuple)
	if !ok {
		return 1
	}
	max := 0
	for _, child := range tup.Items() {
		if d := treeDepth(child); d > max {
			max = d
		}
	}
	return max + 1
}
