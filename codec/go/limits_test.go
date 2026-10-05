package codec

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"testing"
)

// Operational limit reporting (docs/spec/ontos-codec.md §4.2, ontos-internal#352): every
// decoder-produced "limit_exceeded" names the bound that stopped it in LimitKind.

// decodeErr decodes raw under limits and returns the *DecodeError, failing the test
// if decoding succeeded or produced some other error type.
func decodeErr(t *testing.T, raw []byte, limits Limits) *DecodeError {
	t.Helper()
	_, err := DecodeWithLimits(raw, limits)
	if err == nil {
		t.Fatalf("decode of %x: expected an error, got none", raw)
	}
	var de *DecodeError
	if !errors.As(err, &de) {
		t.Fatalf("decode of %x: not a DecodeError: %v", raw, err)
	}
	return de
}

// TestCodecLimitVectors replays vectors/codec-limits.json. A bound absent from a
// case's limits keeps its DefaultLimits value.
func TestCodecLimitVectors(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name   string          `json:"name"`
			Hex    string          `json:"hex"`
			Limits map[string]int  `json:"limits"`
			Expect json.RawMessage `json:"expect"`
		} `json:"cases"`
	}
	readVectors(t, "codec-limits.json", &doc)
	if len(doc.Cases) == 0 {
		t.Fatal("codec-limits.json has no cases")
	}

	for _, c := range doc.Cases {
		limits := DefaultLimits()
		for key, bound := range c.Limits {
			switch key {
			case "maxDepth":
				limits.MaxDepth = bound
			case "maxAtomBytes":
				limits.MaxAtomBytes = bound
			case "maxTupleArity":
				limits.MaxTupleArity = bound
			default:
				t.Fatalf("case %q: unknown limit %q", c.Name, key)
			}
		}
		raw, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatalf("case %q: bad hex: %v", c.Name, err)
		}

		var accept string
		if json.Unmarshal(c.Expect, &accept) == nil {
			if accept != "accept" {
				t.Fatalf("case %q: unknown expectation %q", c.Name, accept)
			}
			if _, err := DecodeWithLimits(raw, limits); err != nil {
				t.Errorf("case %q: expected accept, got %v", c.Name, err)
			}
			continue
		}
		var want struct {
			Code      string          `json:"code"`
			LimitKind DecodeLimitKind `json:"limitKind"`
		}
		if err := json.Unmarshal(c.Expect, &want); err != nil {
			t.Fatalf("case %q: bad expectation: %v", c.Name, err)
		}
		de := decodeErr(t, raw, limits)
		if de.Code != want.Code || de.LimitKind != want.LimitKind {
			t.Errorf("case %q: got (%s, %q) want (%s, %q)", c.Name, de.Code, de.LimitKind, want.Code, want.LimitKind)
		}
	}
}

// TestByteContractRejectsCarryNoLimitKind: a LimitKind belongs to limit_exceeded
// only, so every reject case of the byte corpus leaves it empty.
func TestByteContractRejectsCarryNoLimitKind(t *testing.T) {
	var doc struct {
		Reject []struct {
			Name string `json:"name"`
			Hex  string `json:"hex"`
		} `json:"reject"`
	}
	readVectors(t, "codec.json", &doc)
	for _, c := range doc.Reject {
		raw, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatalf("bad hex %q: %v", c.Hex, err)
		}
		if de := decodeErr(t, raw, DefaultLimits()); de.LimitKind != "" {
			t.Errorf("reject case %q (%s): LimitKind %q, want empty", c.Name, de.Code, de.LimitKind)
		}
	}
}

// atomOfLength is an atom tag followed by a declared byte length and no bytes.
func atomOfLength(length uint64) []byte {
	return append([]byte{tagAtom}, uvarintU64(nil, length)...)
}

// TestNativeWidthKind: a valid uvarint length one past Go's int is native_width, on
// whatever int width this build has (2^63 on 64-bit, 2^31 on a 32-bit build, run in
// CI as GOARCH=386). maxInt itself fits, and fails later as truncation.
func TestNativeWidthKind(t *testing.T) {
	maxIntU64 := uint64(maxInt)
	de := decodeErr(t, atomOfLength(maxIntU64+1), DefaultLimits())
	if de.Code != "limit_exceeded" || de.LimitKind != LimitNativeWidth {
		t.Errorf("length maxInt+1 on a %d-bit int: got (%s, %q) want (limit_exceeded, %q)",
			strconv.IntSize, de.Code, de.LimitKind, LimitNativeWidth)
	}
	de = decodeErr(t, atomOfLength(maxIntU64), DefaultLimits())
	if de.Code != "unexpected_eof" || de.LimitKind != "" {
		t.Errorf("length maxInt on a %d-bit int: got (%s, %q) want (unexpected_eof, \"\")",
			strconv.IntSize, de.Code, de.LimitKind)
	}
}

// TestWorkedCollisionByTarget is the worked example of spec §4.2: with an atom bound
// of 10, a declared 2^60-byte atom is atom_bytes where int holds 2^60 and
// native_width where it does not. Which one a decoder reports is a property of its
// target, which is exactly why a kind is observational.
func TestWorkedCollisionByTarget(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxAtomBytes = 10
	want := LimitAtomBytes
	if strconv.IntSize == 32 {
		want = LimitNativeWidth
	}
	de := decodeErr(t, atomOfLength(1<<60), limits)
	if de.Code != "limit_exceeded" || de.LimitKind != want {
		t.Errorf("2^60-byte atom, atom bound 10, %d-bit int: got (%s, %q) want (limit_exceeded, %q)",
			strconv.IntSize, de.Code, de.LimitKind, want)
	}
}

// TestDecodeErrorCompatibility pins what ontos-internal#352 promised to keep: the parent code,
// keyed construction, errors.As, and Error() text, with a zero LimitKind for a value
// built without one.
func TestDecodeErrorCompatibility(t *testing.T) {
	built := &DecodeError{Code: "limit_exceeded", Message: "from a caller"}
	if built.LimitKind != "" {
		t.Errorf("a keyed literal without LimitKind: got %q, want empty", built.LimitKind)
	}
	if built.Error() != "limit_exceeded: from a caller" {
		t.Errorf("Error(): got %q", built.Error())
	}

	limits := DefaultLimits()
	limits.MaxDepth = 0
	de := decodeErr(t, []byte{0x01, 0x01, 0x00, 0x00}, limits)
	if de.Code != "limit_exceeded" {
		t.Errorf("parent code: got %q, want limit_exceeded", de.Code)
	}
	if de.Error() != "limit_exceeded: decode depth 1 exceeds maximum 0" {
		t.Errorf("Error() text changed: %q", de.Error())
	}

	// An unrecognized kind is still a DecodeError with the generic code; a consumer
	// switching over kinds falls to its default case.
	unknown := &DecodeError{Code: "limit_exceeded", LimitKind: DecodeLimitKind("from_a_later_version")}
	switch unknown.LimitKind {
	case LimitDecodeDepth, LimitAtomBytes, LimitTupleArity, LimitNativeWidth:
		t.Error("an unrecognized kind matched a known one")
	default:
	}
}
