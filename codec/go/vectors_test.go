package codec

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/bitspark/ontos/core/go"
)

// vectorsDir resolves <repo-root>/vectors from this package dir (core/go's and
// codec/go's test working dir is the package dir).
func vectorsDir(t *testing.T) string {
	t.Helper()
	// codec/go -> repo root is two levels up.
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	return filepath.Join(wd, "..", "..", "vectors")
}

func readVectors(t *testing.T, name string, into any) {
	t.Helper()
	path := filepath.Join(vectorsDir(t), name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if err := json.Unmarshal(data, into); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}

// jsonValue is the {atom:hex}|{tuple:[...]} authoring notation.
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

func TestIdentityVectors(t *testing.T) {
	var doc struct {
		Cases []struct {
			Name  string    `json:"name"`
			Left  jsonValue `json:"left"`
			Right jsonValue `json:"right"`
			Equal bool      `json:"equal"`
		} `json:"cases"`
	}
	readVectors(t, "identity.json", &doc)
	if len(doc.Cases) == 0 {
		t.Fatal("no identity cases loaded")
	}
	for _, c := range doc.Cases {
		got := core.Equal(c.Left.build(t), c.Right.build(t))
		if got != c.Equal {
			t.Errorf("identity case %q: got equal=%v want %v", c.Name, got, c.Equal)
		}
	}
}

func TestCodecVectors(t *testing.T) {
	var doc struct {
		Uvarint []struct {
			N   int    `json:"n"`
			Hex string `json:"hex"`
		} `json:"uvarint"`
		Encode []struct {
			Name  string    `json:"name"`
			Value jsonValue `json:"value"`
			Hex   string    `json:"hex"`
		} `json:"encode"`
		Reject []struct {
			Name string `json:"name"`
			Hex  string `json:"hex"`
			Code string `json:"code"`
		} `json:"reject"`
	}
	readVectors(t, "codec.json", &doc)

	for _, c := range doc.Uvarint {
		if got := hex.EncodeToString(EncodeUvarint(c.N)); got != c.Hex {
			t.Errorf("uvarint(%d): got %s want %s", c.N, got, c.Hex)
		}
	}

	for _, c := range doc.Encode {
		value := c.Value.build(t)
		if got := hex.EncodeToString(Encode(value)); got != c.Hex {
			t.Errorf("encode %q: got %s want %s", c.Name, got, c.Hex)
		}
		raw, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatalf("bad hex %q: %v", c.Hex, err)
		}
		decoded, err := Decode(raw)
		if err != nil {
			t.Errorf("roundtrip %q: decode failed: %v", c.Name, err)
			continue
		}
		if !core.Equal(decoded, value) {
			t.Errorf("roundtrip %q: decoded %s != %s", c.Name, decoded, value)
		}
	}

	for _, c := range doc.Reject {
		raw, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatalf("bad hex %q: %v", c.Hex, err)
		}
		_, decErr := Decode(raw)
		if decErr == nil {
			t.Errorf("reject case %q: unexpectedly decoded", c.Name)
			continue
		}
		var de *DecodeError
		if !errors.As(decErr, &de) {
			t.Errorf("reject case %q: not a DecodeError: %v", c.Name, decErr)
			continue
		}
		if de.Code != c.Code {
			t.Errorf("reject case %q: got code %q want %q", c.Name, de.Code, c.Code)
		}
	}
}

// TestUvarintLimitExceededBoundary pins this implementation's LOCAL
// materialization boundary, which is NOT cross-core vector-pinned (spec §3.1):
// Go's usable length type is a signed int (maxInt = 2^63-1). A uvarint that is a
// VALID u64 (canonical, <= 10 bytes, < 2^64) but whose value exceeds maxInt must
// be rejected as "limit_exceeded" (a resource-limit class), NEVER as
// "uvarint_overflow". Only a value >= 2^64 is "uvarint_overflow".
func TestUvarintLimitExceededBoundary(t *testing.T) {
	const maxIntU64 = uint64(^uint(0) >> 1) // 2^63-1 on 64-bit; this is `maxInt`.

	codeFor := func(t *testing.T, lengthValue uint64) string {
		t.Helper()
		// 0x00 (atom tag) followed by `lengthValue` as a canonical u64 uvarint.
		input := append([]byte{tagAtom}, uvarintU64(nil, lengthValue)...)
		_, err := Decode(input)
		if err == nil {
			t.Fatalf("decode of length %d: expected error, got nil", lengthValue)
		}
		var de *DecodeError
		if !errors.As(err, &de) {
			t.Fatalf("decode of length %d: not a DecodeError: %v", lengthValue, err)
		}
		return de.Code
	}

	// First value over the Go boundary: 2^63 = maxInt+1. Valid u64, but exceeds
	// the usable int width -> limit_exceeded (NOT uvarint_overflow).
	if got := codeFor(t, maxIntU64+1); got != "limit_exceeded" {
		t.Errorf("length 2^63 (maxInt+1): got code %q want %q", got, "limit_exceeded")
	}

	// 2^64-1: still a valid u64, still over maxInt -> limit_exceeded.
	if got := codeFor(t, ^uint64(0)); got != "limit_exceeded" {
		t.Errorf("length 2^64-1: got code %q want %q", got, "limit_exceeded")
	}

	// maxInt itself is materializable: it passes the uvarint stage, so the
	// failure must NOT be a uvarint/limit code — here it is unexpected_eof
	// (declared atom length far exceeds the available bytes).
	if got := codeFor(t, maxIntU64); got == "limit_exceeded" || got == "uvarint_overflow" {
		t.Errorf("length maxInt (2^63-1): got code %q, want a non-limit/non-overflow code", got)
	}

	// A 10-byte uvarint whose 10th byte's high bits push the value to >= 2^64 is
	// "uvarint_overflow" (value over the u64 ceiling), NOT limit_exceeded and NOT
	// non_canonical. This is the Go decoder's structural 10th-byte ceiling check
	// (00 = atom tag, then ff*9 7f = 10-byte uvarint >= 2^64).
	raw, err := hex.DecodeString("00ffffffffffffffffff7f")
	if err != nil {
		t.Fatalf("bad hex: %v", err)
	}
	if _, err := Decode(raw); err == nil {
		t.Fatal("10-byte over-ceiling uvarint: expected error, got nil")
	} else {
		var de *DecodeError
		if !errors.As(err, &de) {
			t.Fatalf("10-byte over-ceiling uvarint: not a DecodeError: %v", err)
		}
		if de.Code != "uvarint_overflow" {
			t.Errorf("10-byte over-ceiling uvarint: got code %q want %q", de.Code, "uvarint_overflow")
		}
	}
}

func TestDataVectors(t *testing.T) {
	// ontos/data (L2) embeddings pinned as full ontos-codec-v1 encodings —
	// same encode+roundtrip contract as codec.json's encode cases.
	var doc struct {
		Encode []struct {
			Name  string    `json:"name"`
			Value jsonValue `json:"value"`
			Hex   string    `json:"hex"`
		} `json:"encode"`
	}
	readVectors(t, "data.json", &doc)
	if len(doc.Encode) == 0 {
		t.Fatal("no data cases loaded")
	}
	for _, c := range doc.Encode {
		value := c.Value.build(t)
		if got := hex.EncodeToString(Encode(value)); got != c.Hex {
			t.Errorf("data encode %q: got %s want %s", c.Name, got, c.Hex)
		}
		raw, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatalf("bad hex %q: %v", c.Hex, err)
		}
		decoded, err := Decode(raw)
		if err != nil {
			t.Errorf("data roundtrip %q: decode failed: %v", c.Name, err)
			continue
		}
		if !core.Equal(decoded, value) {
			t.Errorf("data roundtrip %q: decoded %s != %s", c.Name, decoded, value)
		}
	}
}
