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

// vectorsDir resolves <repo-root>/vectors from this package dir. data/go's test
// working dir is the package dir, two levels below the repo root.
func vectorsDir(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	return filepath.Join(wd, "..", "..", "vectors")
}

func readVectors(t *testing.T, name string, into any) {
	t.Helper()
	path := filepath.Join(vectorsDir(t), name)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}

// jsonValue is the {atom:hex}|{tuple:[...]} authoring notation (mirrors codec/go).
type jsonValue struct {
	Atom  *string     `json:"atom"`
	Tuple []jsonValue `json:"tuple"`
}

func (j jsonValue) build(t *testing.T) core.Value {
	t.Helper()
	if j.Atom != nil {
		b, err := hex.DecodeString(*j.Atom)
		if err != nil {
			t.Fatalf("bad hex %q: %v", *j.Atom, err)
		}
		return core.NewAtom(b)
	}
	items := make([]core.Value, 0, len(j.Tuple))
	for _, child := range j.Tuple {
		items = append(items, child.build(t))
	}
	return core.NewTuple(items...)
}

// atom is a small constructor helper for authoring local (non-vector) values.
func atom(b ...byte) core.Value { return core.NewAtom(b) }

// label returns the bytes of v's first child, or "" if v is not a tuple with an
// atom head. The vector runner dispatches on this to pick the embedding kind.
func label(v core.Value) string {
	t, ok := v.(core.Tuple)
	if !ok || t.Len() < 1 {
		return ""
	}
	head, ok := t.At(0).(core.Atom)
	if !ok {
		return ""
	}
	return string(head.Bytes())
}

// TestDataVectors replays vectors/data.json: for each encode case it parses the
// authoring value into a core.Value V, dispatches on V's label, and asserts
// (a) encode<Kind>(datum) == V, (b) read<Kind>(V) == datum and the encode∘read
// round-trip == V, and (c) the FULL byte chain codec.Encode(V) == case.hex. A
// default branch fails on any unrecognized label, and the loop must process > 0
// cases, so any future vector forces this test to be updated.
func TestDataVectors(t *testing.T) {
	var doc struct {
		Encode []struct {
			Name  string    `json:"name"`
			Datum string    `json:"datum"`
			Value jsonValue `json:"value"`
			Hex   string    `json:"hex"`
		} `json:"encode"`
	}
	readVectors(t, "data.json", &doc)
	if len(doc.Encode) == 0 {
		t.Fatal("no data cases loaded")
	}

	processed := 0
	for _, c := range doc.Encode {
		v := c.Value.build(t)

		switch label(v) {
		case labelInt:
			n, ok := new(big.Int).SetString(c.Datum, 10)
			if !ok {
				t.Fatalf("case %q: bad int datum %q", c.Name, c.Datum)
			}
			if got := EncodeInt(n); !core.Equal(got, v) {
				t.Errorf("case %q: EncodeInt(%s) = %s, want %s", c.Name, n, got, v)
			}
			read, err := ReadInt(v)
			if err != nil {
				t.Errorf("case %q: ReadInt failed: %v", c.Name, err)
			} else {
				if read.Cmp(n) != 0 {
					t.Errorf("case %q: ReadInt = %s, want %s", c.Name, read, n)
				}
				if got := EncodeInt(read); !core.Equal(got, v) {
					t.Errorf("case %q: encode∘read = %s, want %s", c.Name, got, v)
				}
			}

		case labelBool:
			var want bool
			switch c.Datum {
			case "true":
				want = true
			case "false":
				want = false
			default:
				t.Fatalf("case %q: bad bool datum %q", c.Name, c.Datum)
			}
			if got := EncodeBool(want); !core.Equal(got, v) {
				t.Errorf("case %q: EncodeBool(%v) = %s, want %s", c.Name, want, got, v)
			}
			read, err := ReadBool(v)
			if err != nil {
				t.Errorf("case %q: ReadBool failed: %v", c.Name, err)
			} else {
				if read != want {
					t.Errorf("case %q: ReadBool = %v, want %v", c.Name, read, want)
				}
				if got := EncodeBool(read); !core.Equal(got, v) {
					t.Errorf("case %q: encode∘read = %s, want %s", c.Name, got, v)
				}
			}

		case labelText:
			// Datum is display-only; derive the string structurally from V's
			// payload atom (the UTF-8 decode of child 1).
			want := string(v.(core.Tuple).At(1).(core.Atom).Bytes())
			if got := MustEncodeText(want); !core.Equal(got, v) {
				t.Errorf("case %q: MustEncodeText(%q) = %s, want %s", c.Name, want, got, v)
			}
			read, err := ReadText(v)
			if err != nil {
				t.Errorf("case %q: ReadText failed: %v", c.Name, err)
			} else {
				if read != want {
					t.Errorf("case %q: ReadText = %q, want %q", c.Name, read, want)
				}
				if got := MustEncodeText(read); !core.Equal(got, v) {
					t.Errorf("case %q: encode∘read = %s, want %s", c.Name, got, v)
				}
			}

		case labelList:
			// Datum is display-only; derive the elements structurally from V's
			// children after the label.
			want := v.(core.Tuple).Items()[1:]
			if got := EncodeList(want); !core.Equal(got, v) {
				t.Errorf("case %q: EncodeList(...) = %s, want %s", c.Name, got, v)
			}
			read, err := ReadList(v)
			if err != nil {
				t.Errorf("case %q: ReadList failed: %v", c.Name, err)
			} else {
				if len(read) != len(want) {
					t.Errorf("case %q: ReadList len = %d, want %d", c.Name, len(read), len(want))
				} else {
					for i := range read {
						if !core.Equal(read[i], want[i]) {
							t.Errorf("case %q: ReadList[%d] = %s, want %s", c.Name, i, read[i], want[i])
						}
					}
				}
				if got := EncodeList(read); !core.Equal(got, v) {
					t.Errorf("case %q: encode∘read = %s, want %s", c.Name, got, v)
				}
			}

		case labelMap:
			// Datum is display-only; derive the entries structurally from V's
			// children after the label, each an arity-2 (key, value) tuple.
			children := v.(core.Tuple).Items()[1:]
			want := make([][2]core.Value, len(children))
			for i, child := range children {
				e := child.(core.Tuple)
				if e.Len() != 2 {
					t.Fatalf("case %q: vector entry %d arity %d, want 2", c.Name, i, e.Len())
				}
				want[i] = [2]core.Value{e.At(0), e.At(1)}
			}
			// (a) EncodeMap reproduces V from the (already-sorted) entries.
			got, err := EncodeMap(want)
			if err != nil {
				t.Errorf("case %q: EncodeMap failed: %v", c.Name, err)
			} else if !core.Equal(got, v) {
				t.Errorf("case %q: EncodeMap(...) = %s, want %s", c.Name, got, v)
			}
			// EncodeMap SORTS, not merely preserves: feeding the entries REVERSED
			// must still yield the canonical (sorted) V.
			rev := make([][2]core.Value, len(want))
			for i := range want {
				rev[i] = want[len(want)-1-i]
			}
			if gotRev, err := EncodeMap(rev); err != nil {
				t.Errorf("case %q: EncodeMap(reversed) failed: %v", c.Name, err)
			} else if !core.Equal(gotRev, v) {
				t.Errorf("case %q: EncodeMap(reversed) = %s, want %s (encode_map must sort)", c.Name, gotRev, v)
			}
			// (b) ReadMap(V) == those entries, and encode∘read round-trips to V.
			read, err := ReadMap(v)
			if err != nil {
				t.Errorf("case %q: ReadMap failed: %v", c.Name, err)
			} else {
				if len(read) != len(want) {
					t.Errorf("case %q: ReadMap len = %d, want %d", c.Name, len(read), len(want))
				} else {
					for i := range read {
						if !core.Equal(read[i][0], want[i][0]) || !core.Equal(read[i][1], want[i][1]) {
							t.Errorf("case %q: ReadMap[%d] = (%s,%s), want (%s,%s)", c.Name, i, read[i][0], read[i][1], want[i][0], want[i][1])
						}
					}
				}
				if got, err := EncodeMap(read); err != nil {
					t.Errorf("case %q: EncodeMap(read) failed: %v", c.Name, err)
				} else if !core.Equal(got, v) {
					t.Errorf("case %q: encode∘read = %s, want %s", c.Name, got, v)
				}
			}

		case labelSet:
			// Datum is display-only; derive the elements structurally from V's
			// children after the label (each a single, arbitrary L0 value).
			want := v.(core.Tuple).Items()[1:]
			// (a) EncodeSet reproduces V from the (already-sorted) elements.
			got, err := EncodeSet(want)
			if err != nil {
				t.Errorf("case %q: EncodeSet failed: %v", c.Name, err)
			} else if !core.Equal(got, v) {
				t.Errorf("case %q: EncodeSet(...) = %s, want %s", c.Name, got, v)
			}
			// EncodeSet SORTS, not merely preserves: feeding the elements REVERSED
			// must still yield the canonical (sorted) V.
			rev := make([]core.Value, len(want))
			for i := range want {
				rev[i] = want[len(want)-1-i]
			}
			if gotRev, err := EncodeSet(rev); err != nil {
				t.Errorf("case %q: EncodeSet(reversed) failed: %v", c.Name, err)
			} else if !core.Equal(gotRev, v) {
				t.Errorf("case %q: EncodeSet(reversed) = %s, want %s (encode_set must sort)", c.Name, gotRev, v)
			}
			// (b) ReadSet(V) == those elements, and encode∘read round-trips to V.
			read, err := ReadSet(v)
			if err != nil {
				t.Errorf("case %q: ReadSet failed: %v", c.Name, err)
			} else {
				if len(read) != len(want) {
					t.Errorf("case %q: ReadSet len = %d, want %d", c.Name, len(read), len(want))
				} else {
					for i := range read {
						if !core.Equal(read[i], want[i]) {
							t.Errorf("case %q: ReadSet[%d] = %s, want %s", c.Name, i, read[i], want[i])
						}
					}
				}
				if got, err := EncodeSet(read); err != nil {
					t.Errorf("case %q: EncodeSet(read) failed: %v", c.Name, err)
				} else if !core.Equal(got, v) {
					t.Errorf("case %q: encode∘read = %s, want %s", c.Name, got, v)
				}
			}

		case labelDecimal:
			// Datum is display-only; derive (mantissa, exponent) structurally from V via
			// ReadDecimal. This Go binding is unbounded (*big.Int), so even the beyond-i128
			// mantissa (decimal_2pow128_mantissa) materializes and round-trips here — the
			// recognize/read split only diverges in the bounded Rust i128 binding (§5.9).
			mant, exp, err := ReadDecimal(v)
			if err != nil {
				t.Errorf("case %q: ReadDecimal failed: %v", c.Name, err)
			} else if got := EncodeDecimal(mant, exp); !core.Equal(got, v) {
				t.Errorf("case %q: encode∘read = %s, want %s", c.Name, got, v)
			}
			if err := RecognizeDecimal(v); err != nil {
				t.Errorf("case %q: RecognizeDecimal failed: %v", c.Name, err)
			}

		case labelNull:
			// null is the single inhabitant; there is no datum to derive — EncodeNull()
			// must reproduce V exactly, and recognize/read both accept it.
			if got := EncodeNull(); !core.Equal(got, v) {
				t.Errorf("case %q: EncodeNull() = %s, want %s", c.Name, got, v)
			}
			if err := RecognizeNull(v); err != nil {
				t.Errorf("case %q: RecognizeNull failed: %v", c.Name, err)
			}
			if err := ReadNull(v); err != nil {
				t.Errorf("case %q: ReadNull failed: %v", c.Name, err)
			}

		default:
			t.Fatalf("case %q: unrecognized label %q — vectors changed, update this test", c.Name, label(v))
		}

		// (c) Full byte chain: datum -> Value -> bytes, end to end.
		if got := hex.EncodeToString(codec.Encode(v)); got != c.Hex {
			t.Errorf("case %q: codec.Encode = %s, want %s", c.Name, got, c.Hex)
		}
		processed++
	}

	if processed == 0 {
		t.Fatal("processed 0 cases")
	}
}

// TestDataRejectVectors replays vectors/data.json's `reject` array: each case is
// an L0 value that is valid at L0 but NOT a well-formed embedding of its `kind`,
// so Read<Kind> must reject it. The reject DECISION is cross-language pinned here;
// the specific *DataError code stays implementation-local. A default branch fails
// on an unknown kind, and the loop must process > 0 cases.
func TestDataRejectVectors(t *testing.T) {
	var doc struct {
		Reject []struct {
			Name  string    `json:"name"`
			Kind  string    `json:"kind"`
			Value jsonValue `json:"value"`
		} `json:"reject"`
	}
	readVectors(t, "data.json", &doc)
	if len(doc.Reject) == 0 {
		t.Fatal("no data reject cases loaded")
	}
	for _, c := range doc.Reject {
		v := c.Value.build(t)
		var err error
		switch c.Kind {
		case labelInt:
			_, err = ReadInt(v)
		case labelBool:
			_, err = ReadBool(v)
		case labelText:
			_, err = ReadText(v)
		case labelList:
			_, err = ReadList(v)
		case labelMap:
			_, err = ReadMap(v)
		case labelSet:
			_, err = ReadSet(v)
		case labelDecimal:
			_, _, err = ReadDecimal(v)
		case labelNull:
			err = ReadNull(v)
		default:
			t.Fatalf("reject case %q: unknown kind %q — update this test", c.Name, c.Kind)
		}
		if err == nil {
			t.Errorf("reject case %q (kind %s): expected rejection, got nil", c.Name, c.Kind)
			continue
		}
		if _, ok := err.(*DataError); !ok {
			t.Errorf("reject case %q: error is not a *DataError: %v", c.Name, err)
		}
	}
}

// --- B) Local recognition (negative) tests, authored here, not in the vectors ---

func TestReadIntRejects(t *testing.T) {
	cases := []struct {
		name string
		v    core.Value
	}{
		{"non-tuple", atom(0x00, 0x01)},
		{"wrong arity 1", core.NewTuple(core.NewAtom([]byte(labelInt)))},
		{"wrong arity 3", core.NewTuple(core.NewAtom([]byte(labelInt)), atom(0x00), atom(0x01))},
		{"wrong label (bool value)", EncodeBool(true)},
		{"label not atom", core.NewTuple(core.NewTuple(), atom(0x00))},
		{"payload not atom", core.NewTuple(core.NewAtom([]byte(labelInt)), core.NewTuple())},
		{"empty payload", core.NewTuple(core.NewAtom([]byte(labelInt)), atom())},
		{"sign byte 0x02", core.NewTuple(core.NewAtom([]byte(labelInt)), atom(0x02, 0x01))},
		{"negative zero", core.NewTuple(core.NewAtom([]byte(labelInt)), atom(0x01))},
		{"leading-zero magnitude", core.NewTuple(core.NewAtom([]byte(labelInt)), atom(0x00, 0x00, 0x01))},
	}
	for _, c := range cases {
		if _, err := ReadInt(c.v); err == nil {
			t.Errorf("ReadInt(%s) [%s]: expected error, got nil", c.v, c.name)
		} else if de, ok := err.(*DataError); !ok || de.Code() != labelInt {
			t.Errorf("ReadInt [%s]: want *DataError code %q, got %v", c.name, labelInt, err)
		}
	}
}

func TestReadBoolRejects(t *testing.T) {
	cases := []struct {
		name string
		v    core.Value
	}{
		{"non-tuple", atom(0x00)},
		{"wrong label (int value)", EncodeInt(big.NewInt(1))},
		{"empty payload", core.NewTuple(core.NewAtom([]byte(labelBool)), atom())},
		{"payload 0x02", core.NewTuple(core.NewAtom([]byte(labelBool)), atom(0x02))},
		{"two-byte payload", core.NewTuple(core.NewAtom([]byte(labelBool)), atom(0x00, 0x00))},
	}
	for _, c := range cases {
		if _, err := ReadBool(c.v); err == nil {
			t.Errorf("ReadBool(%s) [%s]: expected error, got nil", c.v, c.name)
		} else if de, ok := err.(*DataError); !ok || de.Code() != labelBool {
			t.Errorf("ReadBool [%s]: want *DataError code %q, got %v", c.name, labelBool, err)
		}
	}
}

func TestReadTextRejectsAndAcceptsEmpty(t *testing.T) {
	rejects := []struct {
		name string
		v    core.Value
	}{
		{"non-tuple", atom(0x68, 0x69)},
		{"wrong label (bool value)", EncodeBool(false)},
		{"invalid UTF-8 payload", core.NewTuple(core.NewAtom([]byte(labelText)), atom(0xff))},
	}
	for _, c := range rejects {
		if _, err := ReadText(c.v); err == nil {
			t.Errorf("ReadText(%s) [%s]: expected error, got nil", c.v, c.name)
		} else if de, ok := err.(*DataError); !ok || de.Code() != labelText {
			t.Errorf("ReadText [%s]: want *DataError code %q, got %v", c.name, labelText, err)
		}
	}
	// Accepts the empty string (empty-atom payload).
	empty := core.NewTuple(core.NewAtom([]byte(labelText)), atom())
	got, err := ReadText(empty)
	if err != nil {
		t.Errorf("ReadText(empty): unexpected error %v", err)
	}
	if got != "" {
		t.Errorf("ReadText(empty) = %q, want empty string", got)
	}
}

func TestReadListRejectsAndAcceptsEmpty(t *testing.T) {
	rejects := []struct {
		name string
		v    core.Value
	}{
		// A bare Tuple of two atoms with no "list" label is NOT a list (spec §5.5).
		{"bare tuple", core.NewTuple(atom(0x61), atom(0x62))},
		{"non-tuple", atom(0x6c, 0x69, 0x73, 0x74)},
		{"arity-0 empty tuple", core.NewTuple()},
		{"wrong label (int value)", EncodeInt(big.NewInt(0))},
	}
	for _, c := range rejects {
		if _, err := ReadList(c.v); err == nil {
			t.Errorf("ReadList(%s) [%s]: expected error, got nil", c.v, c.name)
		} else if de, ok := err.(*DataError); !ok || de.Code() != labelList {
			t.Errorf("ReadList [%s]: want *DataError code %q, got %v", c.name, labelList, err)
		}
	}
	// Accepts the empty list Tuple(Atom("list")) -> [].
	empty := core.NewTuple(core.NewAtom([]byte(labelList)))
	got, err := ReadList(empty)
	if err != nil {
		t.Errorf("ReadList(empty): unexpected error %v", err)
	}
	if len(got) != 0 {
		t.Errorf("ReadList(empty) = %v, want []", got)
	}
}

// Cross-kind: ReadInt on a list value is rejected.
func TestReadIntOnListRejected(t *testing.T) {
	list := EncodeList([]core.Value{atom(0x61)})
	if _, err := ReadInt(list); err == nil {
		t.Error("ReadInt(list): expected error, got nil")
	} else if de, ok := err.(*DataError); !ok || de.Code() != labelInt {
		t.Errorf("ReadInt(list): want *DataError code %q, got %v", labelInt, err)
	}
}

// --- C) Positive round-trips beyond the vectors ---

func TestIntRoundTrip(t *testing.T) {
	big1 := new(big.Int).Lsh(big.NewInt(1), 256) // 2^256, well beyond i64.
	bigNeg := new(big.Int).Neg(big1)
	values := []*big.Int{
		big.NewInt(0), big.NewInt(1), big.NewInt(-1), big.NewInt(255), big.NewInt(256),
		big.NewInt(9223372036854775807), // max int64
		big1, bigNeg,
	}
	for _, n := range values {
		v := EncodeInt(n)
		read, err := ReadInt(v)
		if err != nil {
			t.Errorf("ReadInt(EncodeInt(%s)): %v", n, err)
			continue
		}
		if read.Cmp(n) != 0 {
			t.Errorf("int round-trip: got %s, want %s", read, n)
		}
	}
}

// TestRecognizeIntStructuralBeyondHostWidth pins that RecognizeInt is purely
// structural: it accepts a canonical int whose magnitude exceeds any fixed host
// integer width (2^128, beyond Rust's i128), distinct from ReadInt's materialization.
// Go's binding is unbounded, so ReadInt also succeeds here; the cross-core point is
// that recognition agrees regardless of host width (ontos-data.md §5.1). It rejects
// every non-canonical form ReadInt rejects, since both share intPayload.
func TestRecognizeIntStructuralBeyondHostWidth(t *testing.T) {
	intLabel := core.NewAtom([]byte(labelInt))
	// 2^128: sign 0x00, magnitude 0x01 then sixteen 0x00 (17 magnitude bytes).
	twoPow128 := core.NewTuple(intLabel, core.NewAtom(append([]byte{0x00, 0x01}, make([]byte, 16)...)))
	if err := RecognizeInt(twoPow128); err != nil {
		t.Errorf("RecognizeInt(2^128): want nil, got %v", err)
	}
	// Go materializes it (unbounded); Rust's i128 binding would resource-limit here.
	if _, err := ReadInt(twoPow128); err != nil {
		t.Errorf("ReadInt(2^128) on the unbounded Go binding: want nil, got %v", err)
	}
	// Non-canonical forms are rejected by RecognizeInt exactly as by ReadInt.
	noncanonical := []core.Value{
		atom(0x00),                                      // not a tuple
		core.NewTuple(intLabel, atom()),                 // empty payload
		core.NewTuple(intLabel, atom(0x02, 0x01)),       // sign byte 0x02
		core.NewTuple(intLabel, atom(0x01)),             // negative zero
		core.NewTuple(intLabel, atom(0x00, 0x00, 0x01)), // leading-zero magnitude
		EncodeBool(true),                                // wrong label
	}
	for _, v := range noncanonical {
		if RecognizeInt(v) == nil {
			t.Errorf("RecognizeInt(%s): want error, got nil", v)
		}
		if _, err := ReadInt(v); err == nil {
			t.Errorf("ReadInt(%s): want error, got nil", v)
		}
	}
}

func TestBoolRoundTrip(t *testing.T) {
	for _, b := range []bool{false, true} {
		read, err := ReadBool(EncodeBool(b))
		if err != nil {
			t.Errorf("ReadBool(EncodeBool(%v)): %v", b, err)
			continue
		}
		if read != b {
			t.Errorf("bool round-trip: got %v, want %v", read, b)
		}
	}
}

func TestTextRoundTrip(t *testing.T) {
	for _, s := range []string{"", "hi", "héllo", "日本語", "a\x00b"} {
		read, err := ReadText(MustEncodeText(s))
		if err != nil {
			t.Errorf("ReadText(MustEncodeText(%q)): %v", s, err)
			continue
		}
		if read != s {
			t.Errorf("text round-trip: got %q, want %q", read, s)
		}
	}
}

func TestListRoundTrip(t *testing.T) {
	// Heterogeneous and nested: bytes, an int embedding, a text embedding, an
	// empty list, and a nested non-empty list.
	elems := []core.Value{
		atom(0x61),
		EncodeInt(big.NewInt(42)),
		MustEncodeText("hi"),
		EncodeList(nil),
		EncodeList([]core.Value{atom(0x62), EncodeBool(true)}),
	}
	v := EncodeList(elems)
	read, err := ReadList(v)
	if err != nil {
		t.Fatalf("ReadList: %v", err)
	}
	if len(read) != len(elems) {
		t.Fatalf("list round-trip: len %d, want %d", len(read), len(elems))
	}
	for i := range elems {
		if !core.Equal(read[i], elems[i]) {
			t.Errorf("list round-trip [%d]: got %s, want %s", i, read[i], elems[i])
		}
	}
	if got := EncodeList(read); !core.Equal(got, v) {
		t.Errorf("list encode∘read: got %s, want %s", got, v)
	}
}

// mustEncodeMap is a helper for building a canonical map in tests; it fails the
// test on a duplicate-key error.
func mustEncodeMap(t *testing.T, entries [][2]core.Value) core.Value {
	t.Helper()
	v, err := EncodeMap(entries)
	if err != nil {
		t.Fatalf("EncodeMap: unexpected error %v", err)
	}
	return v
}

// TestMapRoundTrip covers a spread of canonical maps: empty, single, several
// entries with heterogeneous keys, a nested map VALUE, a map-as-KEY, and a
// non-canonical-int key (which must be ACCEPTED — no recursion, spec §5.7).
func TestMapRoundTrip(t *testing.T) {
	nonCanonicalInt := core.NewTuple(core.NewAtom([]byte(labelInt)), atom(0x00, 0x00, 0x01)) // leading-zero magnitude
	mapAsKey := mustEncodeMap(t, [][2]core.Value{{atom(0x61), EncodeInt(big.NewInt(1))}})

	cases := []struct {
		name    string
		entries [][2]core.Value
	}{
		{"empty", nil},
		{"single", [][2]core.Value{{EncodeInt(big.NewInt(1)), MustEncodeText("hi")}}},
		{"several heterogeneous keys", [][2]core.Value{
			{atom(0x61), EncodeBool(true)},
			{EncodeInt(big.NewInt(1)), EncodeBool(false)},
			{MustEncodeText("a"), EncodeInt(big.NewInt(256))},
		}},
		{"nested map value", [][2]core.Value{
			{atom(0x6b), mustEncodeMap(t, nil)},
		}},
		{"map as key", [][2]core.Value{
			{mapAsKey, EncodeBool(true)},
		}},
		{"non-canonical int key accepted", [][2]core.Value{
			{nonCanonicalInt, atom(0x00)},
		}},
	}
	for _, c := range cases {
		v := mustEncodeMap(t, c.entries)
		read, err := ReadMap(v)
		if err != nil {
			t.Errorf("ReadMap [%s]: unexpected error %v", c.name, err)
			continue
		}
		if len(read) != len(c.entries) {
			t.Errorf("ReadMap [%s]: len %d, want %d", c.name, len(read), len(c.entries))
		}
		// encode∘read must reproduce the canonical value.
		if got, err := EncodeMap(read); err != nil {
			t.Errorf("EncodeMap(read) [%s]: %v", c.name, err)
		} else if !core.Equal(got, v) {
			t.Errorf("map encode∘read [%s]: got %s, want %s", c.name, got, v)
		}
	}
}

// TestEncodeMapSorts verifies EncodeMap puts entries in codec-byte key order
// regardless of input order: feeding entries reversed yields the same value.
func TestEncodeMapSorts(t *testing.T) {
	entries := [][2]core.Value{
		{atom(0x61), atom(0x00)}, // key 0x61
		{atom(0x62), atom(0x00)}, // key 0x62 (encode(0x61) < encode(0x62))
	}
	forward := mustEncodeMap(t, entries)
	reversed := mustEncodeMap(t, [][2]core.Value{entries[1], entries[0]})
	if !core.Equal(forward, reversed) {
		t.Errorf("EncodeMap not sorting: forward %s != reversed %s", forward, reversed)
	}
	// First entry's key after sorting must be 0x61.
	first := forward.(core.Tuple).At(1).(core.Tuple).At(0)
	if !core.Equal(first, atom(0x61)) {
		t.Errorf("EncodeMap sort: first key = %s, want %s", first, atom(0x61))
	}
}

// TestEncodeMapRejectsDuplicateKeys: two entries with equal key encodings are a
// duplicate-key precondition violation; EncodeMap must FAIL (it never picks a
// winner, spec §5.7).
func TestEncodeMapRejectsDuplicateKeys(t *testing.T) {
	entries := [][2]core.Value{
		{atom(0x61), atom(0x00)},
		{atom(0x61), atom(0x01)}, // same key 0x61, different value
	}
	if _, err := EncodeMap(entries); err == nil {
		t.Error("EncodeMap(duplicate keys): expected error, got nil")
	} else if de, ok := err.(*DataError); !ok || de.Code() != labelMap {
		t.Errorf("EncodeMap(duplicate keys): want *DataError code %q, got %v", labelMap, err)
	}
	// Also a non-bare key that collides: two equal int keys.
	dup := [][2]core.Value{
		{EncodeInt(big.NewInt(7)), atom(0x00)},
		{EncodeInt(big.NewInt(7)), atom(0x01)},
	}
	if _, err := EncodeMap(dup); err == nil {
		t.Error("EncodeMap(duplicate int keys): expected error, got nil")
	}
}

// TestReadMapRejectsAndAcceptsEmpty: rejects unsorted, duplicate, arity-3 entry,
// flat (non-tuple child), and unlabeled forms; accepts the empty map.
func TestReadMapRejectsAndAcceptsEmpty(t *testing.T) {
	mapLabel := core.NewAtom([]byte(labelMap))
	rejects := []struct {
		name string
		v    core.Value
	}{
		// entries out of key order: 0x62 before 0x61.
		{"unsorted", core.NewTuple(mapLabel,
			core.NewTuple(atom(0x62), atom(0x00)),
			core.NewTuple(atom(0x61), atom(0x00)))},
		// duplicate key 0x61 (equal adjacent key encodings).
		{"duplicate", core.NewTuple(mapLabel,
			core.NewTuple(atom(0x61), atom(0x00)),
			core.NewTuple(atom(0x61), atom(0x01)))},
		// an entry has arity 3, want exactly 2.
		{"entry arity 3", core.NewTuple(mapLabel,
			core.NewTuple(atom(0x61), atom(0x00), atom(0x01)))},
		// an entry has arity 1, want exactly 2.
		{"entry arity 1", core.NewTuple(mapLabel,
			core.NewTuple(atom(0x61)))},
		// flat: key,value children are not arity-2 entry tuples (child is an atom).
		{"flat non-tuple child", core.NewTuple(mapLabel, atom(0x61), atom(0x00))},
		// no map label — first child is an entry tuple, not Atom("map").
		{"unlabeled", core.NewTuple(core.NewTuple(atom(0x61), atom(0x00)))},
		// the arity-0 empty tuple is not the empty map.
		{"empty tuple", core.NewTuple()},
		// a bare atom is not a map.
		{"non-tuple", mapLabel},
		// cross-kind: a well-formed list read as map.
		{"on list value", EncodeList([]core.Value{atom(0x61)})},
	}
	for _, c := range rejects {
		if _, err := ReadMap(c.v); err == nil {
			t.Errorf("ReadMap(%s) [%s]: expected error, got nil", c.v, c.name)
		} else if de, ok := err.(*DataError); !ok || de.Code() != labelMap {
			t.Errorf("ReadMap [%s]: want *DataError code %q, got %v", c.name, labelMap, err)
		}
	}
	// Accepts the empty map Tuple(Atom("map")) -> [].
	empty := core.NewTuple(mapLabel)
	got, err := ReadMap(empty)
	if err != nil {
		t.Errorf("ReadMap(empty): unexpected error %v", err)
	}
	if len(got) != 0 {
		t.Errorf("ReadMap(empty) = %v, want []", got)
	}
}

// --- set (spec §5.8) ---

// mustEncodeSet builds a canonical set in tests; it fails on a duplicate-element
// error.
func mustEncodeSet(t *testing.T, elems []core.Value) core.Value {
	t.Helper()
	v, err := EncodeSet(elems)
	if err != nil {
		t.Fatalf("EncodeSet: unexpected error %v", err)
	}
	return v
}

// TestSetRoundTrip covers a spread of canonical sets: empty, single, several
// heterogeneous elements, a nested set-of-sets, and a non-canonical-int element
// (which must be ACCEPTED — no recursion, spec §5.8).
func TestSetRoundTrip(t *testing.T) {
	nonCanonicalInt := core.NewTuple(core.NewAtom([]byte(labelInt)), atom(0x00, 0x00, 0x01)) // leading-zero magnitude
	nestedSet := mustEncodeSet(t, []core.Value{atom(0x61)})

	cases := []struct {
		name  string
		elems []core.Value
	}{
		{"empty", nil},
		{"single", []core.Value{EncodeInt(big.NewInt(1))}},
		{"several heterogeneous", []core.Value{
			atom(0x61),
			EncodeInt(big.NewInt(1)),
			MustEncodeText("a"),
			EncodeBool(true),
		}},
		{"nested set of sets", []core.Value{
			mustEncodeSet(t, nil),
			nestedSet,
		}},
		{"non-canonical int element accepted", []core.Value{nonCanonicalInt}},
	}
	for _, c := range cases {
		v := mustEncodeSet(t, c.elems)
		read, err := ReadSet(v)
		if err != nil {
			t.Errorf("ReadSet [%s]: unexpected error %v", c.name, err)
			continue
		}
		if len(read) != len(c.elems) {
			t.Errorf("ReadSet [%s]: len %d, want %d", c.name, len(read), len(c.elems))
		}
		// encode∘read must reproduce the canonical value.
		if got, err := EncodeSet(read); err != nil {
			t.Errorf("EncodeSet(read) [%s]: %v", c.name, err)
		} else if !core.Equal(got, v) {
			t.Errorf("set encode∘read [%s]: got %s, want %s", c.name, got, v)
		}
	}
}

// TestEncodeSetSorts verifies EncodeSet puts elements in codec-byte order
// regardless of input order: feeding elements reversed yields the same value.
func TestEncodeSetSorts(t *testing.T) {
	elems := []core.Value{atom(0x62), atom(0x61)} // encode(0x61) < encode(0x62)
	forward := mustEncodeSet(t, elems)
	reversed := mustEncodeSet(t, []core.Value{elems[1], elems[0]})
	if !core.Equal(forward, reversed) {
		t.Errorf("EncodeSet not sorting: forward %s != reversed %s", forward, reversed)
	}
	// First element after the label must be 0x61.
	first := forward.(core.Tuple).At(1)
	if !core.Equal(first, atom(0x61)) {
		t.Errorf("EncodeSet sort: first element = %s, want %s", first, atom(0x61))
	}
}

// TestEncodeSetRejectsDuplicateElements: two elements with equal encodings are a
// duplicate-element precondition violation; EncodeSet must FAIL (it never picks a
// winner, spec §5.8).
func TestEncodeSetRejectsDuplicateElements(t *testing.T) {
	if _, err := EncodeSet([]core.Value{atom(0x61), atom(0x61)}); err == nil {
		t.Error("EncodeSet(duplicate atoms): expected error, got nil")
	} else if de, ok := err.(*DataError); !ok || de.Code() != labelSet {
		t.Errorf("EncodeSet(duplicate atoms): want *DataError code %q, got %v", labelSet, err)
	}
	// Also a non-bare element that collides: two equal int elements.
	if _, err := EncodeSet([]core.Value{EncodeInt(big.NewInt(7)), EncodeInt(big.NewInt(7))}); err == nil {
		t.Error("EncodeSet(duplicate int elements): expected error, got nil")
	}
}

// TestReadSetRejectsAndAcceptsEmpty: rejects unsorted, duplicate, unlabeled,
// empty-tuple, and bare-atom forms; accepts the empty set.
func TestReadSetRejectsAndAcceptsEmpty(t *testing.T) {
	setLabel := core.NewAtom([]byte(labelSet))
	rejects := []struct {
		name string
		v    core.Value
	}{
		// elements out of order: 0x62 before 0x61.
		{"unsorted", core.NewTuple(setLabel, atom(0x62), atom(0x61))},
		// duplicate element 0x61 (equal adjacent encodings).
		{"duplicate", core.NewTuple(setLabel, atom(0x61), atom(0x61))},
		// no set label — first child is an element, not Atom("set").
		{"unlabeled", core.NewTuple(atom(0x61), atom(0x62))},
		// the arity-0 empty tuple is not the empty set.
		{"empty tuple", core.NewTuple()},
		// a bare atom (even the bytes of "set") is not a set.
		{"non-tuple", setLabel},
		// cross-kind: a well-formed list read as set.
		{"on list value", EncodeList([]core.Value{atom(0x61)})},
	}
	for _, c := range rejects {
		if _, err := ReadSet(c.v); err == nil {
			t.Errorf("ReadSet(%s) [%s]: expected error, got nil", c.v, c.name)
		} else if de, ok := err.(*DataError); !ok || de.Code() != labelSet {
			t.Errorf("ReadSet [%s]: want *DataError code %q, got %v", c.name, labelSet, err)
		}
	}
	// Accepts the empty set Tuple(Atom("set")) -> [].
	empty := core.NewTuple(setLabel)
	got, err := ReadSet(empty)
	if err != nil {
		t.Errorf("ReadSet(empty): unexpected error %v", err)
	}
	if len(got) != 0 {
		t.Errorf("ReadSet(empty) = %v, want []", got)
	}
}
