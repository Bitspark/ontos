package data

import (
	"encoding/hex"
	"math/big"
	"testing"

	"github.com/bitspark/ontos/codec/go"
	"github.com/bitspark/ontos/core/go"
)

// recognizes reports whether v is a well-formed canonical embedding of the given
// label, by running the matching recognizer (success == nil error) — `int` via
// RecognizeInt, the others via Read<Kind>, mirroring the CLI's per-kind dispatch so
// the test below pins Labels against the SAME recognition the CLI exercises.
func recognizes(t *testing.T, label string, v core.Value) bool {
	t.Helper()
	var err error
	switch label {
	case labelInt:
		err = RecognizeInt(v)
	case labelText:
		_, err = ReadText(v)
	case labelBool:
		_, err = ReadBool(v)
	case labelList:
		_, err = ReadList(v)
	case labelMap:
		_, err = ReadMap(v)
	case labelSet:
		_, err = ReadSet(v)
	case labelDecimal:
		err = RecognizeDecimal(v)
	case labelNull:
		err = RecognizeNull(v)
	default:
		t.Fatalf("no recognizer for label %q", label)
	}
	return err == nil
}

// canonicalSample returns one canonical embedding value for each registered label,
// so the test can confirm Labels[i] names the recognizer that accepts sample[i].
func canonicalSample(t *testing.T, label string) core.Value {
	t.Helper()
	switch label {
	case labelInt:
		return EncodeInt(big.NewInt(1))
	case labelText:
		return MustEncodeText("x")
	case labelBool:
		return EncodeBool(true)
	case labelList:
		return EncodeList(nil)
	case labelMap:
		v, err := EncodeMap(nil)
		if err != nil {
			t.Fatalf("EncodeMap: %v", err)
		}
		return v
	case labelSet:
		v, err := EncodeSet(nil)
		if err != nil {
			t.Fatalf("EncodeSet: %v", err)
		}
		return v
	case labelDecimal:
		return EncodeDecimal(big.NewInt(1), big.NewInt(0))
	case labelNull:
		return EncodeNull()
	default:
		t.Fatalf("no sample for label %q", label)
		return nil
	}
}

// TestLabelsMatchRecognizedOrder pins Labels — the single source of the registered
// label set and its order (spec §5) — against the actual Read<Kind> recognizers.
// For each label in order, the canonical embedding of that kind must be recognized
// by exactly that label's recognizer (so Labels truly is the recognized order),
// and the slice must be exactly the v1 set in the fixed order. Drift here is a
// real, CI-caught parity bug: the order is part of the CLI's `recognized` JSON
// contract (the CLI keeps its own copy by design — a separate cli-side test pins
// that copy against Labels).
func TestLabelsMatchRecognizedOrder(t *testing.T) {
	want := []string{"int", "utf8-text", "bool", "list", "map", "set", "decimal", "null"}
	if len(Labels) != len(want) {
		t.Fatalf("Labels has %d entries, want %d: %v", len(Labels), len(want), Labels)
	}
	for i, label := range want {
		if Labels[i] != label {
			t.Fatalf("Labels[%d] = %q, want %q (full: %v)", i, Labels[i], label, Labels)
		}
		// The canonical embedding of this kind is recognized by THIS label's
		// recognizer (the order in Labels is the actual recognized order).
		if !recognizes(t, label, canonicalSample(t, label)) {
			t.Fatalf("Labels[%d] = %q: its canonical embedding is not recognized by Read%s", i, label, label)
		}
	}
}

// TestDataErrorCodeIsKind documents the language-local DataError.Code contract: it
// returns the rejected embedding label (a member of Labels), NOT a cross-language
// failure-reason code. This pins the behavior the softened doc-comment describes.
func TestDataErrorCodeIsKind(t *testing.T) {
	for _, label := range Labels {
		e := &DataError{Kind: label, Reason: "test"}
		if got := e.Code(); got != label {
			t.Fatalf("DataError{Kind:%q}.Code() = %q, want %q", label, got, label)
		}
	}
}

// TestIntHostWidthBoundary pins the i128 host-width boundary from the data-spec
// §5.1 "Implementation bindings & integer width" note. Go's *big.Int binding is
// unbounded, so it MATERIALIZES the exact canonical bytes that Rust's i128 binding
// reports as IntOutOfRange: 2^127 (= i128::MAX + 1) and -(2^127 + 1) (= i128::MIN
// - 1). This is the one place the three cores MATERIALIZE different sets of values
// (ontos-internal#67) — recognition is identical; only materialization diverges. These bytes are
// well-formed, not malformed, so they must read AND round-trip. The payloads are
// shared verbatim with the Rust and TS boundary tests.
func TestIntHostWidthBoundary(t *testing.T) {
	two127 := new(big.Int).Lsh(big.NewInt(1), 127) // 2^127 = i128::MAX + 1

	cases := []struct {
		name    string
		payload []byte // sign byte || big-endian minimal magnitude
		want    *big.Int
	}{
		// 2^127: sign 0x00, magnitude 0x80 then 15 zero bytes.
		{"i128_max_plus_1", append([]byte{signNonNeg, 0x80}, make([]byte, 15)...), two127},
		// -(2^127 + 1): sign 0x01, magnitude 0x80, 14 zero bytes, then 0x01.
		{"i128_min_minus_1", append(append([]byte{signNeg, 0x80}, make([]byte, 14)...), 0x01),
			new(big.Int).Neg(new(big.Int).Add(two127, big.NewInt(1)))},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v := core.NewTuple(core.NewAtom([]byte(labelInt)), core.NewAtom(tc.payload))

			got, err := ReadInt(v)
			if err != nil {
				t.Fatalf("ReadInt rejected a well-formed beyond-i128 int: %v", err)
			}
			if got.Cmp(tc.want) != 0 {
				t.Fatalf("ReadInt = %s, want %s", got, tc.want)
			}
			// Round-trips to the very same canonical value, so these bytes are
			// genuinely well-formed — not merely tolerated on read.
			if back := EncodeInt(got); !core.Equal(back, v) {
				t.Fatalf("EncodeInt(ReadInt(v)) != v for %s", tc.name)
			}
		})
	}
}

// TestDecimalRoundTripAndNormalize pins EncodeDecimal/ReadDecimal (spec §5.9): a
// (mantissa, exponent) pair encodes to the canonical value and reads back the NORMALIZED
// pair (trailing base-10 zeros stripped into the exponent; zero is decimal(0,0)).
func TestDecimalRoundTripAndNormalize(t *testing.T) {
	cases := []struct {
		m, e         int64
		wantM, wantE int64
	}{
		{0, 0, 0, 0},
		{1, 0, 1, 0},
		{314, -2, 314, -2},
		{-5, -1, -5, -1},
		{100, 0, 1, 2}, // trailing zeros stripped into the exponent
		{10, 1, 1, 2},  // same value, different surface spelling
		{0, 5, 0, 0},   // zero normalizes its exponent to 0
		{-120, 3, -12, 4},
	}
	for _, tc := range cases {
		v := EncodeDecimal(big.NewInt(tc.m), big.NewInt(tc.e))
		gotM, gotE, err := ReadDecimal(v)
		if err != nil {
			t.Fatalf("ReadDecimal(%d,%d): %v", tc.m, tc.e, err)
		}
		if gotM.Cmp(big.NewInt(tc.wantM)) != 0 || gotE.Cmp(big.NewInt(tc.wantE)) != 0 {
			t.Fatalf("ReadDecimal(%d,%d) = (%s,%s), want (%d,%d)", tc.m, tc.e, gotM, gotE, tc.wantM, tc.wantE)
		}
		// Encoding the normalized pair is idempotent (canonical form is a fixpoint).
		if back := EncodeDecimal(big.NewInt(tc.wantM), big.NewInt(tc.wantE)); !core.Equal(back, v) {
			t.Fatalf("canonical fixpoint failed for (%d,%d)", tc.m, tc.e)
		}
		if err := RecognizeDecimal(v); err != nil {
			t.Fatalf("RecognizeDecimal rejected canonical (%d,%d): %v", tc.m, tc.e, err)
		}
	}
}

// TestDecimalRejectsNonCanonical pins the reject set (spec §5.9), including the
// recursion case: a non-canonical int child makes the whole decimal not well-formed —
// the scalar discipline that distinguishes decimal from the containers list/map/set.
func TestDecimalRejectsNonCanonical(t *testing.T) {
	dec := func(m, e core.Value) core.Value {
		return core.NewTuple(core.NewAtom([]byte(labelDecimal)), m, e)
	}
	bad := []struct {
		name string
		v    core.Value
	}{
		{"trailing_zero_mantissa", dec(EncodeInt(big.NewInt(10)), EncodeInt(big.NewInt(0)))},
		{"zero_nonzero_exponent", dec(EncodeInt(big.NewInt(0)), EncodeInt(big.NewInt(5)))},
		{"noncanonical_int_mantissa", dec(core.NewTuple(core.NewAtom([]byte(labelInt)), core.NewAtom([]byte{0x00, 0x00, 0x01})), EncodeInt(big.NewInt(0)))},
		{"mantissa_not_int", dec(core.NewAtom([]byte{0x01}), EncodeInt(big.NewInt(0)))},
		{"wrong_arity", core.NewTuple(core.NewAtom([]byte(labelDecimal)), EncodeInt(big.NewInt(1)))},
		{"bare_atom", core.NewAtom([]byte(labelDecimal))},
		{"cross_kind_int", EncodeInt(big.NewInt(1))},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			if err := RecognizeDecimal(tc.v); err == nil {
				t.Fatalf("RecognizeDecimal must reject %s", tc.name)
			}
			if _, _, err := ReadDecimal(tc.v); err == nil {
				t.Fatalf("ReadDecimal must reject %s", tc.name)
			}
		})
	}
}

// TestNullCanonicalAndUnique pins EncodeNull/RecognizeNull/ReadNull (spec §5.10): the
// single inhabitant Tuple(Atom("null")) encodes to the frozen byte form, is recognized,
// round-trips, and re-encodes to a fixpoint (there is no value to vary).
func TestNullCanonicalAndUnique(t *testing.T) {
	v := EncodeNull()
	// Exact canonical structure: Tuple(Atom("null")), arity exactly 1.
	want := core.NewTuple(core.NewAtom([]byte("null")))
	if !core.Equal(v, want) {
		t.Fatalf("EncodeNull() = %s, want %s", v, want)
	}
	// Frozen byte form: 01 01 00 04 6e 75 6c 6c (spec §5.10).
	if got := hex.EncodeToString(codec.Encode(v)); got != "010100046e756c6c" {
		t.Fatalf("encode(null) = %s, want 010100046e756c6c", got)
	}
	if err := RecognizeNull(v); err != nil {
		t.Fatalf("RecognizeNull rejected the canonical null: %v", err)
	}
	if err := ReadNull(v); err != nil {
		t.Fatalf("ReadNull rejected the canonical null: %v", err)
	}
	// Re-encoding is idempotent — null is its own fixpoint.
	if back := EncodeNull(); !core.Equal(back, v) {
		t.Fatalf("EncodeNull is not a fixpoint")
	}
}

// TestNullRejectsNonCanonical pins the reject set (spec §5.10): any payload (arity > 1)
// is NOT a well-formed null (guardrail 1 — exactly one inhabitant), the bare empty
// tuple and a bare atom are not null, the wrong label is not null, and a value of
// another kind is not read as null (cross-kind disjointness).
func TestNullRejectsNonCanonical(t *testing.T) {
	nullLabel := core.NewAtom([]byte(labelNull))
	bad := []struct {
		name string
		v    core.Value
	}{
		// arity 2: a "null" with a payload child — present-but-no-value forbids a payload.
		{"null_with_payload", core.NewTuple(nullLabel, core.NewAtom([]byte{0x61}))},
		// arity 3: more payload, still rejected.
		{"null_with_two_payloads", core.NewTuple(nullLabel, core.NewAtom([]byte{0x61}), core.NewAtom([]byte{0x62}))},
		// arity 0: the bare empty tuple is not the null (the null is arity-1).
		{"empty_tuple", core.NewTuple()},
		// a bare atom (even the bytes of "null") is not a null.
		{"bare_atom", nullLabel},
		// near-miss label: arity-1 tuple with a different label.
		{"wrong_label", core.NewTuple(core.NewAtom([]byte("nul")))},
		// cross-kind: a well-formed empty list read as null.
		{"cross_kind_list", EncodeList(nil)},
		// cross-kind: a well-formed bool read as null.
		{"cross_kind_bool", EncodeBool(false)},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			if err := RecognizeNull(tc.v); err == nil {
				t.Fatalf("RecognizeNull must reject %s", tc.name)
			} else if de, ok := err.(*DataError); !ok || de.Code() != labelNull {
				t.Fatalf("RecognizeNull(%s): want *DataError code %q, got %v", tc.name, labelNull, err)
			}
			if err := ReadNull(tc.v); err == nil {
				t.Fatalf("ReadNull must reject %s", tc.name)
			}
		})
	}
}

// TestNullCrossKind confirms the single null value is recognized ONLY as null, never
// as a list/set/map/bool/int — the labels are disjoint (spec §5.10 + §7 D5).
func TestNullCrossKind(t *testing.T) {
	v := EncodeNull()
	if _, err := ReadList(v); err == nil {
		t.Fatalf("the null value must not be read as a list")
	}
	if _, err := ReadSet(v); err == nil {
		t.Fatalf("the null value must not be read as a set")
	}
	if _, err := ReadMap(v); err == nil {
		t.Fatalf("the null value must not be read as a map")
	}
	if _, err := ReadBool(v); err == nil {
		t.Fatalf("the null value must not be read as a bool")
	}
}
