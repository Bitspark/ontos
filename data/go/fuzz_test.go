package data

import (
	"encoding/hex"
	"encoding/json"
	"math/big"
	"os"
	"path/filepath"
	"testing"

	"github.com/bitspark/ontos/codec/go"
	"github.com/bitspark/ontos/core/go"
)

// This file hardens the ontos-data (L2) RECOGNIZERS, which consume already-decoded
// L0 Value trees that may be adversarial (a peer can hand a consumer any well-formed
// L0 value). It establishes five properties, dependency-free (a small hand-rolled
// LCG, the same generator codec/go/fuzz_test.go uses):
//
//	D1 recognition NEVER panics — every Read<Kind>/RecognizeInt returns its datum or
//	   a typed *DataError (no index-out-of-bounds, no slice blowup, no nil deref).
//	D2 READ IS CANONICAL — recognition accepts only the canonical form, so if
//	   Read<Kind>(v) succeeds then Encode<Kind>(Read<Kind>(v)) == v exactly.
//	D3 ROUND-TRIP on produced data — for a random typed datum,
//	   Read<Kind>(Encode<Kind>(datum)) == datum.
//	D4 RECOGNIZE/READ AGREEMENT (ontos-internal#67/#77) — RecognizeInt(v)==nil iff ReadInt(v)
//	   succeeds. (Go's *big.Int binding is unbounded, so there is no resource-limit
//	   case; the distinction is load-bearing for Rust's i128 binding.)
//	D5 AT MOST ONE KIND — the eight labels are disjoint, so a value is a well-formed
//	   embedding of at most one kind.
//
// FuzzData drives D1/D2/D4/D5 under Go native fuzzing: it decodes arbitrary bytes
// (the genuine "untrusted bytes" path) and sweeps the recognizers over whatever
// materializes. Its seed corpus (the conformance vectors) also runs under plain
// `go test`. TestDataProperties drives all five over tens of thousands of random
// embedding-biased values. rs/ts stop at fixed-iteration property tests; Go adds the
// native coverage-guided target (see .github/workflows/fuzz.yml), mirroring the codec.

// ---------------------------------------------------------------------------
// Deterministic PRNG: a 64-bit LCG (Knuth MMIX constants), no imports/crates.
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
	return int((r.next() >> 33) % uint64(n))
}

func (r *lcg) byteVal() byte { return byte(r.next() >> 56) }

func (r *lcg) boolVal() bool { return r.next()>>63 == 1 }

// ---------------------------------------------------------------------------
// Generators (embedding-biased): produce both well-labeled and mislabeled
// compounds so the recognizers' sort/dup/arity/canonicality paths are reached.
// ---------------------------------------------------------------------------

var fuzzLabels = []string{labelInt, labelText, labelBool, labelList, labelMap, labelSet, labelDecimal, labelNull}

func (r *lcg) randLabel() []byte {
	// 75% a real registered label, 25% a random short atom (mislabeled/bare).
	if r.uintn(4) != 0 {
		return []byte(fuzzLabels[r.uintn(len(fuzzLabels))])
	}
	n := r.uintn(5)
	b := make([]byte, n)
	for i := range b {
		b[i] = r.byteVal()
	}
	return b
}

// randAtomBytes: small alphabet half the time (so scalar payloads form valid
// canonical forms often enough to keep D2 non-vacuous), uniform bytes otherwise.
func (r *lcg) randAtomBytes() []byte {
	n := r.uintn(10)
	b := make([]byte, n)
	small := r.boolVal()
	for i := range b {
		if small {
			b[i] = byte(r.next() & 0x03)
		} else {
			b[i] = r.byteVal()
		}
	}
	return b
}

// randValue builds an embedding-biased Value with bounded depth and a node budget,
// so a pathological branch cannot explode.
func (r *lcg) randValue(depth int, budget *int) core.Value {
	*budget--
	if depth <= 0 || *budget <= 0 || r.uintn(5) < 2 {
		return core.NewAtom(r.randAtomBytes())
	}
	labeled := r.uintn(4) != 0 // 75% labeled compounds
	arity := r.uintn(5)        // 0..=4 tail children
	items := make([]core.Value, 0, arity+1)
	if labeled {
		items = append(items, core.NewAtom(r.randLabel()))
	}
	for i := 0; i < arity && *budget > 0; i++ {
		if r.boolVal() {
			// arity-2 entry-shaped child (feeds read_map's entry/sort/dup paths).
			items = append(items, core.NewTuple(r.randValue(depth-1, budget), r.randValue(depth-1, budget)))
		} else {
			items = append(items, r.randValue(depth-1, budget))
		}
	}
	return core.NewTuple(items...)
}

func (r *lcg) buildValue() core.Value {
	budget := 64
	return r.randValue(5, &budget)
}

var fuzzAlphabet = []rune{'a', 'Z', '0', ' ', '_', '\n', 'é', 'ß', '日', '😀'}

func (r *lcg) randString() string {
	n := r.uintn(12)
	rs := make([]rune, n)
	for i := range rs {
		rs[i] = fuzzAlphabet[r.uintn(len(fuzzAlphabet))]
	}
	return string(rs)
}

// randBigInt: a signed big.Int with a 0..19-byte magnitude — deliberately spanning
// beyond i128/u128 so the unbounded Go binding's wide-magnitude path is exercised
// (the very values Rust's i128 binding reports as IntOutOfRange).
func (r *lcg) randBigInt() *big.Int {
	n := r.uintn(20)
	mag := make([]byte, n)
	for i := range mag {
		mag[i] = r.byteVal()
	}
	v := new(big.Int).SetBytes(mag) // big-endian; leading zeros ignored -> canonical magnitude
	if r.boolVal() && v.Sign() != 0 {
		v.Neg(v) // random sign, but never negative zero
	}
	return v
}

// distinctAtoms returns n pairwise-distinct single-byte atom values, so EncodeMap/
// EncodeSet never hit their duplicate precondition (n is bounded well under 256).
func distinctAtoms(n int) []core.Value {
	out := make([]core.Value, n)
	for i := range out {
		out[i] = core.NewAtom([]byte{byte(i)})
	}
	return out
}

// validEmbedding builds a guaranteed-canonical embedding of a random kind, keeping
// D2/D4 non-vacuous in the sweep (a value that really is recognized).
func (r *lcg) validEmbedding() core.Value {
	switch r.uintn(8) {
	case 0:
		return EncodeInt(r.randBigInt())
	case 1:
		return MustEncodeText(r.randString())
	case 2:
		return EncodeBool(r.boolVal())
	case 3:
		arity := r.uintn(5)
		budget := 32
		elems := make([]core.Value, arity)
		for i := range elems {
			elems[i] = r.randValue(2, &budget)
		}
		return EncodeList(elems)
	case 4:
		arity := r.uintn(5)
		budget := 32
		keys := distinctAtoms(arity)
		entries := make([][2]core.Value, arity)
		for i := range entries {
			entries[i] = [2]core.Value{keys[i], r.randValue(2, &budget)}
		}
		v, err := EncodeMap(entries)
		if err != nil {
			panic("distinct keys never collide: " + err.Error())
		}
		return v
	case 5:
		v, err := EncodeSet(distinctAtoms(r.uintn(5)))
		if err != nil {
			panic("distinct elements never collide: " + err.Error())
		}
		return v
	case 6:
		// decimal: random (possibly > i128) mantissa, small exponent. Go's unbounded
		// *big.Int materializes a wide mantissa, exercising the path Rust reports as
		// IntOutOfRange (§5.9).
		return EncodeDecimal(r.randBigInt(), big.NewInt(int64(r.uintn(41)-20)))
	default:
		// null: the single inhabitant Tuple(Atom("null")) (§5.10).
		return EncodeNull()
	}
}

// ---------------------------------------------------------------------------
// Shared checker: D1 (reaching the end == no panic), D2, D4, D5. Returns the
// number of kinds that recognized v (must be <= 1 by D5).
// ---------------------------------------------------------------------------

func checkRecognizers(tb testing.TB, v core.Value) int {
	tb.Helper()
	matched := 0

	// int — D2 and D4. (Go is unbounded: ReadInt succeeds iff RecognizeInt does.)
	n, readErr := ReadInt(v)
	if readErr == nil {
		if got := EncodeInt(n); !core.Equal(got, v) {
			tb.Fatalf("D2: EncodeInt(ReadInt(v)) != v\n  v:   %s\n  got: %s", v, got)
		}
		matched++
	}
	recOK := RecognizeInt(v) == nil
	if recOK != (readErr == nil) {
		tb.Fatalf("D4: RecognizeInt(v)==nil (%v) disagrees with ReadInt success (%v) for %s", recOK, readErr == nil, v)
	}

	if s, err := ReadText(v); err == nil {
		if got := MustEncodeText(s); !core.Equal(got, v) {
			tb.Fatalf("D2: MustEncodeText(ReadText(v)) != v for %s", v)
		}
		matched++
	}
	if b, err := ReadBool(v); err == nil {
		if got := EncodeBool(b); !core.Equal(got, v) {
			tb.Fatalf("D2: EncodeBool(ReadBool(v)) != v for %s", v)
		}
		matched++
	}
	if elems, err := ReadList(v); err == nil {
		if got := EncodeList(elems); !core.Equal(got, v) {
			tb.Fatalf("D2: EncodeList(ReadList(v)) != v for %s", v)
		}
		matched++
	}
	// map/set: ReadMap/ReadSet succeed only on strictly-ascending, dup-free children,
	// so re-encoding cannot hit the duplicate precondition — an error here is a defect.
	if entries, err := ReadMap(v); err == nil {
		got, e := EncodeMap(entries)
		if e != nil {
			tb.Fatalf("D2: EncodeMap(ReadMap(v)) errored unexpectedly for %s: %v", v, e)
		}
		if !core.Equal(got, v) {
			tb.Fatalf("D2: EncodeMap(ReadMap(v)) != v for %s", v)
		}
		matched++
	}
	if elems, err := ReadSet(v); err == nil {
		got, e := EncodeSet(elems)
		if e != nil {
			tb.Fatalf("D2: EncodeSet(ReadSet(v)) errored unexpectedly for %s: %v", v, e)
		}
		if !core.Equal(got, v) {
			tb.Fatalf("D2: EncodeSet(ReadSet(v)) != v for %s", v)
		}
		matched++
	}
	// decimal — D2 and D4. (Go is unbounded: ReadDecimal succeeds iff RecognizeDecimal
	// does — the recognize/read split only diverges in Rust's bounded i128 binding.)
	mant, exp, decErr := ReadDecimal(v)
	if decErr == nil {
		if got := EncodeDecimal(mant, exp); !core.Equal(got, v) {
			tb.Fatalf("D2: EncodeDecimal(ReadDecimal(v)) != v for %s", v)
		}
		matched++
	}
	decRecOK := RecognizeDecimal(v) == nil
	if decRecOK != (decErr == nil) {
		tb.Fatalf("D4: RecognizeDecimal(v)==nil (%v) disagrees with ReadDecimal success (%v) for %s", decRecOK, decErr == nil, v)
	}
	// null — D2 and D4. null carries no payload, so recognize and read coincide; the
	// re-encoded value is the single inhabitant, so EncodeNull() must reproduce v.
	nullErr := ReadNull(v)
	if nullErr == nil {
		if got := EncodeNull(); !core.Equal(got, v) {
			tb.Fatalf("D2: EncodeNull() != v for %s", v)
		}
		matched++
	}
	nullRecOK := RecognizeNull(v) == nil
	if nullRecOK != (nullErr == nil) {
		tb.Fatalf("D4: RecognizeNull(v)==nil (%v) disagrees with ReadNull success (%v) for %s", nullRecOK, nullErr == nil, v)
	}

	if matched > 1 {
		tb.Fatalf("D5: value recognized as %d kinds (labels must be disjoint): %s", matched, v)
	}
	return matched
}

// ---------------------------------------------------------------------------
// Seed corpus for FuzzData: every valid encoding the vectors pin (codec.json +
// data.json `encode`), plus a few raw edge literals. Decoding these yields the
// Value trees the recognizers should accept; mutations explore the reject paths.
// ---------------------------------------------------------------------------

func seedDataHexes(tb testing.TB) [][]byte {
	tb.Helper()
	wd, err := os.Getwd()
	if err != nil {
		tb.Fatalf("getwd: %v", err)
	}
	var seeds [][]byte
	add := func(h string) {
		if h == "" {
			return
		}
		b, err := hex.DecodeString(h)
		if err != nil {
			tb.Fatalf("bad seed hex %q: %v", h, err)
		}
		seeds = append(seeds, b)
	}
	for _, name := range []string{"data.json", "codec.json"} {
		raw, err := os.ReadFile(filepath.Join(wd, "..", "..", "vectors", name))
		if err != nil {
			tb.Fatalf("read %s: %v", name, err)
		}
		var doc struct {
			Encode []struct {
				Hex string `json:"hex"`
			} `json:"encode"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			tb.Fatalf("parse %s: %v", name, err)
		}
		for _, c := range doc.Encode {
			add(c.Hex)
		}
	}
	// Raw edge literals: empty, bare tags, an unknown tag, a truncated tuple.
	seeds = append(seeds, []byte{})
	for _, h := range []string{"00", "01", "0200", "0102"} {
		add(h)
	}
	return seeds
}

// FuzzData is the Go native-fuzzing entry point: decode arbitrary bytes, then sweep
// every recognizer over whatever materialized (D1/D2/D4/D5). Decode failures are the
// codec's concern (FuzzDecode) and are skipped here.
func FuzzData(f *testing.F) {
	for _, seed := range seedDataHexes(f) {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		v, err := codec.Decode(b)
		if err != nil {
			return
		}
		checkRecognizers(t, v)
	})
}

// ---------------------------------------------------------------------------
// TestDataProperties: the plain-`go test` driver for D1–D5.
// ---------------------------------------------------------------------------

func TestDataProperties(t *testing.T) {
	const (
		seed       uint64 = 0x6F6E746F73646174 // "ontosdat"
		sweepIters        = 30000
		rtIters           = 10000
		decIters          = 30000
		maxBufLen         = 48
	)

	// --- D1/D2/D4/D5 on the seed corpus first (vectors decode to canonical values). ---
	for _, b := range seedDataHexes(t) {
		if v, err := codec.Decode(b); err == nil {
			checkRecognizers(t, v)
		}
	}

	// --- D1/D2/D4/D5: 30k embedding-biased values, half guaranteed-canonical. ---
	r := newLCG(seed)
	recognized := 0
	for i := 0; i < sweepIters; i++ {
		var v core.Value
		if i%2 == 0 {
			v = r.validEmbedding()
		} else {
			v = r.buildValue()
		}
		recognized += checkRecognizers(t, v)
	}
	if recognized == 0 {
		t.Fatalf("expected some values recognized over %d (D2/D4 would be vacuous)", sweepIters)
	}
	t.Logf("D1/D2/D4/D5: swept %d values, %d recognized", sweepIters, recognized)

	// --- D1: recognizers total on values decoded from arbitrary bytes. Two sources:
	// a real encoded embedding-biased value (always decodes, so the sweep reaches the
	// recognizers on recognizable structure), and small-alphabet bytes (decode often,
	// exercising D1 on arbitrary decoded structure). ---
	rb := newLCG(seed ^ 0x9E3779B97F4A7C15)
	decoded, decRecognized := 0, 0
	for i := 0; i < decIters; i++ {
		var buf []byte
		if i%2 == 0 {
			buf = codec.Encode(rb.buildValue())
		} else {
			n := rb.uintn(maxBufLen + 1)
			buf = make([]byte, n)
			for j := range buf {
				buf[j] = byte(rb.next() & 0x07) // small alphabet -> decodes often
			}
		}
		if v, err := codec.Decode(buf); err == nil {
			decoded++
			decRecognized += checkRecognizers(t, v)
		}
	}
	if decoded == 0 {
		t.Fatalf("expected buffers to decode for the recognizer sweep")
	}
	if decRecognized == 0 {
		t.Fatalf("expected some decoded values to be recognized (sweep not vacuous)")
	}
	t.Logf("D1: swept %d decoded values (%d recognized) from %d buffers", decoded, decRecognized, decIters)

	// --- D3: round-trip on produced data, per kind. ---
	rv := newLCG(seed ^ 0x123456789ABCDEF0)
	for i := 0; i < rtIters; i++ {
		// int (including >i128 magnitudes — Go materializes them)
		n := rv.randBigInt()
		if got, err := ReadInt(EncodeInt(n)); err != nil || got.Cmp(n) != 0 {
			t.Fatalf("D3 int: ReadInt(EncodeInt(%s)) = (%v, %v)", n, got, err)
		}
		// utf8-text
		s := rv.randString()
		if got, err := ReadText(MustEncodeText(s)); err != nil || got != s {
			t.Fatalf("D3 text: round-trip %q = (%q, %v)", s, got, err)
		}
		// bool
		b := rv.boolVal()
		if got, err := ReadBool(EncodeBool(b)); err != nil || got != b {
			t.Fatalf("D3 bool: round-trip %v = (%v, %v)", b, got, err)
		}
		// list
		arity := rv.uintn(5)
		budget := 32
		elems := make([]core.Value, arity)
		for j := range elems {
			elems[j] = rv.randValue(2, &budget)
		}
		lv := EncodeList(elems)
		got, err := ReadList(lv)
		if err != nil || len(got) != len(elems) {
			t.Fatalf("D3 list: round-trip len %d = (%d, %v)", len(elems), len(got), err)
		}
		if re := EncodeList(got); !core.Equal(re, lv) {
			t.Fatalf("D3 list: EncodeList(ReadList(v)) != v (elements differ/reordered)")
		}
		// map (distinct keys; compare via the canonical value). Fresh budget so map
		// values get full breadth rather than the depth the list loop left behind.
		arity = rv.uintn(5)
		mbudget := 32
		entries := make([][2]core.Value, arity)
		keys := distinctAtoms(arity)
		for j := range entries {
			entries[j] = [2]core.Value{keys[j], rv.randValue(2, &mbudget)}
		}
		mv, err := EncodeMap(entries)
		if err != nil {
			t.Fatalf("D3 map: EncodeMap: %v", err)
		}
		read, err := ReadMap(mv)
		if err != nil {
			t.Fatalf("D3 map: ReadMap: %v", err)
		}
		if re, err := EncodeMap(read); err != nil || !core.Equal(re, mv) {
			t.Fatalf("D3 map: EncodeMap(ReadMap(v)) != v")
		}
		// set (distinct elements)
		sv, err := EncodeSet(distinctAtoms(rv.uintn(5)))
		if err != nil {
			t.Fatalf("D3 set: EncodeSet: %v", err)
		}
		readS, err := ReadSet(sv)
		if err != nil {
			t.Fatalf("D3 set: ReadSet: %v", err)
		}
		if re, err := EncodeSet(readS); err != nil || !core.Equal(re, sv) {
			t.Fatalf("D3 set: EncodeSet(ReadSet(v)) != v")
		}
		// decimal (read returns the producer-normalized pair; compare via the canonical value)
		dv := EncodeDecimal(rv.randBigInt(), big.NewInt(int64(rv.uintn(41)-20)))
		dm, de, err := ReadDecimal(dv)
		if err != nil {
			t.Fatalf("D3 decimal: ReadDecimal: %v", err)
		}
		if re := EncodeDecimal(dm, de); !core.Equal(re, dv) {
			t.Fatalf("D3 decimal: EncodeDecimal(ReadDecimal(v)) != v")
		}
	}
	t.Logf("D3: %d round-trip iterations across all eight kinds", rtIters)
}
