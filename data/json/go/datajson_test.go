package datajson_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"

	codec "github.com/bitspark/ontos/codec/go"
	core "github.com/bitspark/ontos/core/go"
	data "github.com/bitspark/ontos/data/go"
	datajson "github.com/bitspark/ontos/data/json/go"
)

// The cross-impl lock: vectors/data-json.json is the frozen byte-contract for
// ontos-data-json/1. These tests project each valid doc with datajson.Project and
// assert the resulting bytes against the locked digests — the inner ontos-codec-v1
// digest of the projected value, and the era-2 domain-separated digest of the
// structural wrap Tuple(Atom(tag), value). Reject cases assert the path-named
// rejection verbatim. Drift here is a real cross-language conformance break.

type vectorFile struct {
	Valid  []vectorCase `json:"valid"`
	Reject []vectorCase `json:"reject"`
}

type vectorCase struct {
	Desc  string `json:"desc"`
	Value struct {
		// Doc is the projection input (already family-preprocessed where a family
		// strips a top-level key — e.g. decl2's `description` is gone from Doc, and
		// the harness `preprocess` field only records that provenance). Read raw so
		// integer literals survive verbatim instead of round-tripping through float64.
		Doc       json.RawMessage `json:"doc"`
		DocSource string          `json:"docSource"`
		CorpusKey string          `json:"corpusKey"`
		Expect    struct {
			CodecSha256 string `json:"codecSha256"`
			Era2        struct {
				Tag             string `json:"tag"`
				TagAtomBytesHex string `json:"tagAtomBytesHex"`
				Digest          string `json:"digest"`
			} `json:"era2"`
			Reject struct {
				Path   string `json:"path"`
				Reason string `json:"reason"`
			} `json:"reject"`
		} `json:"expect"`
	} `json:"value"`
}

func loadVectors(t *testing.T) vectorFile {
	t.Helper()
	// data/json/go -> repo root is three levels up.
	path := filepath.Join("..", "..", "..", "vectors", "data-json.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var vf vectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(vf.Valid) == 0 || len(vf.Reject) == 0 {
		t.Fatalf("empty vector file: %d valid, %d reject", len(vf.Valid), len(vf.Reject))
	}
	return vf
}

func TestVectorsValid(t *testing.T) {
	for _, c := range loadVectors(t).Valid {
		c := c
		t.Run(c.Value.CorpusKey, func(t *testing.T) {
			v, err := datajson.Project(c.Value.Doc)
			if err != nil {
				t.Fatalf("Project(%s): %v", c.Value.CorpusKey, err)
			}

			// (b) inner ontos-codec-v1 digest of the projected value.
			inner := sha256.Sum256(codec.Encode(v))
			if got := hex.EncodeToString(inner[:]); got != c.Value.Expect.CodecSha256 {
				t.Errorf("inner codecSha256 = %s, want %s", got, c.Value.Expect.CodecSha256)
			}

			// (c) era-2 domain-separated digest: SHA-256(codec.Encode(Tuple(Atom(tag), value))).
			tag := c.Value.Expect.Era2.Tag
			if wantHex := hex.EncodeToString([]byte(tag)); wantHex != c.Value.Expect.Era2.TagAtomBytesHex {
				t.Errorf("tag %q bytes = %s, want %s", tag, wantHex, c.Value.Expect.Era2.TagAtomBytesHex)
			}
			pre := core.NewTuple(core.NewAtom([]byte(tag)), v)
			era2 := sha256.Sum256(codec.Encode(pre))
			want := strings.TrimPrefix(c.Value.Expect.Era2.Digest, "sha256:")
			if got := hex.EncodeToString(era2[:]); got != want {
				t.Errorf("era2 digest = sha256:%s, want sha256:%s", got, want)
			}
		})
	}
}

func TestVectorsReject(t *testing.T) {
	for i, c := range loadVectors(t).Reject {
		c, i := c, i
		name := c.Value.CorpusKey
		if name == "" {
			name = fmt.Sprintf("reject%d", i)
		}
		t.Run(name, func(t *testing.T) {
			_, err := datajson.Project(json.RawMessage(c.Value.DocSource))
			if err == nil {
				t.Fatalf("Project(%s): expected rejection, got nil", c.Value.DocSource)
			}
			var pe *datajson.Error
			if !errors.As(err, &pe) {
				t.Fatalf("error type = %T (%v), want *datajson.Error", err, err)
			}
			if pe.Path != c.Value.Expect.Reject.Path {
				t.Errorf("reject path = %q, want %q", pe.Path, c.Value.Expect.Reject.Path)
			}
			if pe.Reason != c.Value.Expect.Reject.Reason {
				t.Errorf("reject reason = %q, want %q", pe.Reason, c.Value.Expect.Reject.Reason)
			}
		})
	}
}

// TestArms proves each projection arm composes the frozen data primitive rather than
// re-deriving a byte form: for every input the projected value's codec bytes must
// equal the bytes of the primitive it is supposed to delegate to. This guards the
// arms the two-family corpus does not exercise directly (null, bool, negative and
// big integers, empty containers).
func TestArms(t *testing.T) {
	bi := func(s string) core.Value {
		n, ok := new(big.Int).SetString(s, 10)
		if !ok {
			t.Fatalf("bad test int %q", s)
		}
		return data.EncodeInt(n)
	}
	mustMap := func(entries [][2]core.Value) core.Value {
		v, err := data.EncodeMap(entries)
		if err != nil {
			t.Fatalf("EncodeMap: %v", err)
		}
		return v
	}
	cases := []struct {
		name string
		in   string
		want core.Value
	}{
		{"null", `null`, data.EncodeNull()},
		{"true", `true`, data.EncodeBool(true)},
		{"false", `false`, data.EncodeBool(false)},
		{"text", `"soil"`, data.MustEncodeText("soil")},
		{"empty-text", `""`, data.MustEncodeText("")},
		{"zero", `0`, bi("0")},
		{"negative", `-14`, bi("-14")},
		{"bigint-beyond-int64", `170141183460469231731687303715884105728`, bi("170141183460469231731687303715884105728")},
		{"empty-array", `[]`, data.EncodeList(nil)},
		{"empty-object", `{}`, mustMap(nil)},
		{"nested", `{"b":[true,null],"a":"x"}`, mustMap([][2]core.Value{
			{data.MustEncodeText("a"), data.MustEncodeText("x")},
			{data.MustEncodeText("b"), data.EncodeList([]core.Value{data.EncodeBool(true), data.EncodeNull()})},
		})},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			v, err := datajson.Project(json.RawMessage(tc.in))
			if err != nil {
				t.Fatalf("Project(%s): %v", tc.in, err)
			}
			got := hex.EncodeToString(codec.Encode(v))
			want := hex.EncodeToString(codec.Encode(tc.want))
			if got != want {
				t.Errorf("Project(%s) bytes = %s, want %s", tc.in, got, want)
			}
		})
	}
}

// TestDecimalArmReject checks the reserved decimal arm rejects by literal FORM, not
// numeric value: 1.0 and 1e3 are whole numbers yet reject like 3.14, and the reason
// is the pinned spec wording. Path threading through arrays/objects is asserted too.
func TestDecimalArmReject(t *testing.T) {
	reason := func(lit string) string {
		return fmt.Sprintf("non-integer number literal %q — fraction/exponent rejected under ontos-data-json/1 (reserved decimal arm ungraduated)", lit)
	}
	cases := []struct {
		name, in, path, reason string
	}{
		{"fraction", `1.5`, "$", reason("1.5")},
		{"whole-with-dot", `1.0`, "$", reason("1.0")},
		{"exponent-lower", `1e3`, "$", reason("1e3")},
		{"exponent-upper", `2E2`, "$", reason("2E2")},
		{"in-array", `[1, 2.5]`, "$[1]", reason("2.5")},
		{"in-object", `{"threshold": 3.14}`, "$.threshold", reason("3.14")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := datajson.Project(json.RawMessage(tc.in))
			var pe *datajson.Error
			if !errors.As(err, &pe) {
				t.Fatalf("Project(%s) err = %v, want *datajson.Error", tc.in, err)
			}
			if pe.Path != tc.path {
				t.Errorf("path = %q, want %q", pe.Path, tc.path)
			}
			if pe.Reason != tc.reason {
				t.Errorf("reason = %q, want %q", pe.Reason, tc.reason)
			}
		})
	}
}

// TestTrailingDataReject checks Project reads exactly one document.
func TestTrailingDataReject(t *testing.T) {
	for _, in := range []string{`{} {}`, `1 2`, `true false`, `[] junk`, `01`} { // 01 reads as 0 + trailing 1, matching the TS reader
		_, err := datajson.Project(json.RawMessage(in))
		var pe *datajson.Error
		if !errors.As(err, &pe) {
			t.Fatalf("Project(%q) err = %v, want *datajson.Error", in, err)
		}
		if pe.Path != "$" || pe.Reason != "trailing data after JSON document" {
			t.Errorf("Project(%q) = {%q, %q}, want {$, trailing data after JSON document}", in, pe.Path, pe.Reason)
		}
	}
}

// TestUTF8FidelityReject checks the ontos-data.md §4.1 fidelity law (ontos-internal#216): a
// string with no UTF-8 encoding — an unpaired \uXXXX surrogate escape — is
// REJECTED path-named with the vector-pinned reason, never silently coerced to
// U+FFFD (which would succeed with a DIFFERENT admissible datum). The index in
// the reason counts UTF-16 code units, matching what the TS peer naturally
// reports.
func TestUTF8FidelityReject(t *testing.T) {
	reason := func(unit uint16, index int) string {
		return fmt.Sprintf("unpaired surrogate 0x%04x at UTF-16 index %d — the string has no UTF-8 encoding, rejected under ontos-data-json/1 (U+FFFD coercion violates the ontos-data.md §4.1 fidelity law)", unit, index)
	}
	cases := []struct {
		name, in, path, reason string
	}{
		{"lone-high-at-root", `"\ud800"`, "$", reason(0xd800, 0)},
		{"lone-low-at-root", `"\udc00"`, "$", reason(0xdc00, 0)},
		{"high-then-high", `"\ud800\ud801"`, "$", reason(0xd800, 0)},
		{"in-object-value", `{"note": "x\udfff"}`, "$.note", reason(0xdfff, 1)},
		{"in-array", `["ok", "\ud800abc"]`, "$[1]", reason(0xd800, 0)},
		// soil- is 5 UTF-16 units, the PAIRED emoji escape combines to one code
		// point of 2 units, the hyphen 1 — so the lone surrogate sits at index 8.
		{"utf16-index-counts-code-units", `"soil-😀-\ud800"`, "$", reason(0xd800, 8)},
		// A defective KEY rejects at the member path. The path interpolates the
		// key as this face holds it (WTF-8 bytes for the lone surrogate); the TS
		// peer interpolates the lone code unit — representation-bound, unpinnable.
		{"in-object-key", `{"a\ud800": 1}`, "$.a\xed\xa0\x80", reason(0xd800, 1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := datajson.Project(json.RawMessage(tc.in))
			var pe *datajson.Error
			if !errors.As(err, &pe) {
				t.Fatalf("Project(%s) err = %v, want *datajson.Error", tc.in, err)
			}
			if pe.Path != tc.path {
				t.Errorf("path = %q, want %q", pe.Path, tc.path)
			}
			if pe.Reason != tc.reason {
				t.Errorf("reason = %q, want %q", pe.Reason, tc.reason)
			}
		})
	}
}

// TestRawInvalidUTF8Reject covers the byte-level form of the same defect: raw
// invalid UTF-8 inside a string literal (unrepresentable in the JSON-hosted
// vector file, hence pinned here). The reader copies the bytes verbatim and
// data.EncodeText refuses them, so the rejection is path-named and carries the
// data-layer reason.
func TestRawInvalidUTF8Reject(t *testing.T) {
	wantReason := "ontos/data: not a well-formed utf8-text: producer: string is not valid UTF-8"
	cases := []struct {
		name string
		in   []byte
		path string
	}{
		{"at-root", []byte{'"', 0x80, '"'}, "$"},
		{"in-object-value", append(append([]byte(`{"k": "`), 0xff), []byte(`"}`)...), "$.k"},
		{"truncated-multibyte", []byte{'"', 0xE2, 0x82, '"'}, "$"}, // e2 82 is a 3-byte sequence cut short
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := datajson.Project(tc.in)
			var pe *datajson.Error
			if !errors.As(err, &pe) {
				t.Fatalf("Project(%q) err = %v, want *datajson.Error", tc.in, err)
			}
			if pe.Path != tc.path {
				t.Errorf("path = %q, want %q", pe.Path, tc.path)
			}
			if pe.Reason != wantReason {
				t.Errorf("reason = %q, want %q", pe.Reason, wantReason)
			}
		})
	}
}

// TestSyntaxReject checks malformed JSON is rejected $-rooted through the
// projection's own reader (encoding/json no longer sits in front of it), never
// thrown raw and never silently repaired.
func TestSyntaxReject(t *testing.T) {
	for _, in := range []string{
		`{`, `[1,]`, `{"a":}`, `{"a" 1}`, `{"a":1,}`,
		`-`, `1e`, `1.`, `+1`,
		`"abc`, `"\x"`, `"\u12g4"`, "\"\x01\"",
		`tru`, `fals`, `nul`,
	} {
		_, err := datajson.Project(json.RawMessage(in))
		var pe *datajson.Error
		if !errors.As(err, &pe) {
			t.Fatalf("Project(%q) err = %v, want *datajson.Error", in, err)
		}
		if pe.Path != "$" || !strings.HasPrefix(pe.Reason, "invalid JSON: ") {
			t.Errorf("Project(%q) = {%q, %q}, want $-rooted invalid JSON", in, pe.Path, pe.Reason)
		}
	}
}

// TestEmptyInputReject checks the empty-document rejection survives the reader
// swap with its wording intact.
func TestEmptyInputReject(t *testing.T) {
	for _, in := range []string{"", "   ", "\n\t"} {
		_, err := datajson.Project(json.RawMessage(in))
		var pe *datajson.Error
		if !errors.As(err, &pe) {
			t.Fatalf("Project(%q) err = %v, want *datajson.Error", in, err)
		}
		if pe.Path != "$" || pe.Reason != "empty input: expected one JSON document" {
			t.Errorf("Project(%q) = {%q, %q}", in, pe.Path, pe.Reason)
		}
	}
}

// TestDepthLimit checks the resource-limit posture (ontos-internal#236): the spec's floor
// (512) must be accepted; above this face's ceiling the reader returns the
// LIMIT class — a *datajson.LimitError, deliberately NOT a *datajson.Error —
// fast, instead of running the stack out (the crash class the own-reader move
// reintroduced until this bound restored encoding/json's old protection).
func TestDepthLimit(t *testing.T) {
	deep := func(n int) []byte {
		return []byte(strings.Repeat("[", n) + "1" + strings.Repeat("]", n))
	}
	// The spec floor accepts.
	if _, err := datajson.Project(deep(512)); err != nil {
		t.Fatalf("depth 512 (the spec floor) must accept, got %v", err)
	}
	// This face's stated ceiling accepts.
	if _, err := datajson.Project(deep(datajson.MaxDepth)); err != nil {
		t.Fatalf("depth %d (this face's ceiling) must accept, got %v", datajson.MaxDepth, err)
	}
	// Ceiling+1 and far beyond both fail FAST with the limit class.
	for _, n := range []int{datajson.MaxDepth + 1, 100_000} {
		_, err := datajson.Project(deep(n))
		var le *datajson.LimitError
		if !errors.As(err, &le) {
			t.Fatalf("depth %d: err = %v, want *datajson.LimitError", n, err)
		}
		if le.Limit != datajson.MaxDepth {
			t.Errorf("depth %d: Limit = %d, want %d", n, le.Limit, datajson.MaxDepth)
		}
		var pe *datajson.Error
		if errors.As(err, &pe) {
			t.Errorf("depth %d: the limit class must be DISTINCT from the domain rejection type", n)
		}
	}
	// Deep OBJECTS are bounded by the same counter.
	deepObj := strings.Repeat(`{"a":`, datajson.MaxDepth+1) + "1" + strings.Repeat("}", datajson.MaxDepth+1)
	var le *datajson.LimitError
	if _, err := datajson.Project([]byte(deepObj)); !errors.As(err, &le) {
		t.Errorf("deep objects: err = %v, want *datajson.LimitError", err)
	}
}

// ---------------------------------------------------------------------------
// duplicateKeys: reject — the opt-in source-admission policy (ontos-internal#322).
// ---------------------------------------------------------------------------

type dupVectorFile struct {
	DuplicateKeys struct {
		Reject []dupCase `json:"reject"`
		Accept []dupCase `json:"accept"`
	} `json:"duplicateKeys"`
}

type dupCase struct {
	Desc  string `json:"desc"`
	Value struct {
		DocSource string `json:"docSource"`
		Expect    struct {
			Reject struct {
				Path string `json:"path"`
				Key  string `json:"key"`
			} `json:"reject"`
			LastWinsEquivalent string `json:"lastWinsEquivalent"`
		} `json:"expect"`
	} `json:"value"`
}

func loadDupVectors(t *testing.T) dupVectorFile {
	t.Helper()
	path := filepath.Join("..", "..", "..", "vectors", "data-json.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var vf dupVectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(vf.DuplicateKeys.Reject) == 0 || len(vf.DuplicateKeys.Accept) == 0 {
		t.Fatalf("empty duplicateKeys section: %d reject, %d accept", len(vf.DuplicateKeys.Reject), len(vf.DuplicateKeys.Accept))
	}
	return vf
}

var strict = datajson.Options{DuplicateKeys: datajson.DuplicateKeysReject}

func mustBytes(t *testing.T, src string, opts datajson.Options) []byte {
	t.Helper()
	v, err := datajson.ProjectWith(json.RawMessage(src), opts)
	if err != nil {
		t.Fatalf("ProjectWith(%s, %+v): %v", src, opts, err)
	}
	return codec.Encode(v)
}

// The strict mode refuses each repeat at the pinned member with the pinned key, as
// the DuplicateKeyError class — never as *Error (a /1 domain rejection) and never
// as *LimitError. The default mode accepts the same document and projects it to the
// bytes of its hand-written last-wins equivalent, which the strict mode also accepts.
func TestDuplicateKeysVectorsReject(t *testing.T) {
	for i, c := range loadDupVectors(t).DuplicateKeys.Reject {
		c, i := c, i
		t.Run(fmt.Sprintf("reject%d", i), func(t *testing.T) {
			src := c.Value.DocSource
			_, err := datajson.ProjectWith(json.RawMessage(src), strict)
			if err == nil {
				t.Fatalf("strict ProjectWith(%s): expected a duplicate-key refusal, got nil", src)
			}
			var de *datajson.DuplicateKeyError
			if !errors.As(err, &de) {
				t.Fatalf("error type = %T (%v), want *datajson.DuplicateKeyError", err, err)
			}
			if de.Path != c.Value.Expect.Reject.Path {
				t.Errorf("path = %q, want %q", de.Path, c.Value.Expect.Reject.Path)
			}
			if de.Key != c.Value.Expect.Reject.Key {
				t.Errorf("key = %q, want %q", de.Key, c.Value.Expect.Reject.Key)
			}
			var pe *datajson.Error
			var le *datajson.LimitError
			if errors.As(err, &pe) || errors.As(err, &le) {
				t.Errorf("the duplicate-key class must be DISTINCT from *Error and *LimitError")
			}
			if !strings.Contains(err.Error(), de.Path) {
				t.Errorf("Error() = %q should carry the path", err.Error())
			}

			// Default mode: last-wins, byte-identical to the collapsed equivalent.
			got := mustBytes(t, src, datajson.Options{})
			want := mustBytes(t, c.Value.Expect.LastWinsEquivalent, datajson.Options{})
			if !bytes.Equal(got, want) {
				t.Errorf("default-mode bytes %x != lastWinsEquivalent bytes %x", got, want)
			}
			// The collapsed equivalent is duplicate-free, so strict accepts it identically.
			if s := mustBytes(t, c.Value.Expect.LastWinsEquivalent, strict); !bytes.Equal(s, want) {
				t.Errorf("strict bytes of the equivalent %x != default bytes %x", s, want)
			}
		})
	}
}

// Duplicate-free documents project byte-identically in both modes.
func TestDuplicateKeysVectorsAccept(t *testing.T) {
	for i, c := range loadDupVectors(t).DuplicateKeys.Accept {
		c, i := c, i
		t.Run(fmt.Sprintf("accept%d", i), func(t *testing.T) {
			d := mustBytes(t, c.Value.DocSource, datajson.Options{})
			s := mustBytes(t, c.Value.DocSource, strict)
			if !bytes.Equal(d, s) {
				t.Errorf("strict bytes %x != default bytes %x", s, d)
			}
		})
	}
}

// The policy is a stricter admission over the SAME mapping: every locked valid
// case reproduces its digests through the strict mode, and every locked reject
// case keeps its path-named /1 rejection — the strict mode changes no outcome
// for a document without a repeated member.
func TestStrictModePreservesLockedOutcomes(t *testing.T) {
	vf := loadVectors(t)
	for _, c := range vf.Valid {
		c := c
		t.Run("valid/"+c.Value.CorpusKey, func(t *testing.T) {
			v, err := datajson.ProjectWith(c.Value.Doc, strict)
			if err != nil {
				t.Fatalf("strict ProjectWith(%s): %v", c.Value.CorpusKey, err)
			}
			inner := sha256.Sum256(codec.Encode(v))
			if got := hex.EncodeToString(inner[:]); got != c.Value.Expect.CodecSha256 {
				t.Errorf("strict inner codecSha256 = %s, want %s", got, c.Value.Expect.CodecSha256)
			}
		})
	}
	for i, c := range vf.Reject {
		c, i := c, i
		t.Run(fmt.Sprintf("reject%d", i), func(t *testing.T) {
			_, err := datajson.ProjectWith(json.RawMessage(c.Value.DocSource), strict)
			var pe *datajson.Error
			if !errors.As(err, &pe) {
				t.Fatalf("strict error type = %T (%v), want *datajson.Error", err, err)
			}
			if pe.Path != c.Value.Expect.Reject.Path || pe.Reason != c.Value.Expect.Reject.Reason {
				t.Errorf("strict rejection = (%q, %q), want (%q, %q)", pe.Path, pe.Reason, c.Value.Expect.Reject.Path, c.Value.Expect.Reject.Reason)
			}
		})
	}
}

// Stage order and class boundaries of the strict mode: the reader refuses a repeat
// before the projection walk runs, so a document with BOTH a repeat and a /1
// defect is refused for the repeat under strict and for the defect under default;
// the depth bound is still the limit class; and a repeated key with no UTF-8
// reading is still a repeat (the default mode rejects it for fidelity instead).
func TestStrictModeClassBoundaries(t *testing.T) {
	both := `{"a": 1, "a": 2, "b": 1.5}`
	var de *datajson.DuplicateKeyError
	if _, err := datajson.ProjectWith(json.RawMessage(both), strict); !errors.As(err, &de) {
		t.Errorf("strict: err = %v, want *DuplicateKeyError (reader precedes the walk)", err)
	} else if de.Path != "$.a" {
		t.Errorf("strict: path = %q, want $.a", de.Path)
	}
	var pe *datajson.Error
	if _, err := datajson.Project(json.RawMessage(both)); !errors.As(err, &pe) || pe.Path != "$.b" {
		t.Errorf("default: err = %v, want the /1 decimal-arm rejection at $.b", err)
	}

	deep := strings.Repeat(`{"a":`, datajson.MaxDepth+1) + "1" + strings.Repeat("}", datajson.MaxDepth+1)
	var le *datajson.LimitError
	if _, err := datajson.ProjectWith(json.RawMessage(deep), strict); !errors.As(err, &le) {
		t.Errorf("strict deep: err = %v, want *LimitError", err)
	}

	lone := `{"\ud800": 1, "\ud800": 2}`
	if _, err := datajson.ProjectWith(json.RawMessage(lone), strict); !errors.As(err, &de) {
		t.Errorf("strict lone-surrogate repeat: err = %v, want *DuplicateKeyError", err)
	}
	if _, err := datajson.Project(json.RawMessage(lone)); !errors.As(err, &pe) {
		t.Errorf("default lone-surrogate: err = %v, want the /1 fidelity rejection", err)
	}

	// The zero Options is Project, spelled out.
	if _, err := datajson.ProjectWith(json.RawMessage(`{"k": 1, "k": 2}`), datajson.Options{}); err != nil {
		t.Errorf("zero Options must be last-wins: %v", err)
	}
}
