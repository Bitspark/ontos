package codec

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/bitspark/ontos/core/go"
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

// limitCase is one case in codec-limits.json's shape, which the generated corpus's
// differential section shares.
type limitCase struct {
	Name   string          `json:"name"`
	Hex    string          `json:"hex"`
	Limits map[string]int  `json:"limits"`
	Expect json.RawMessage `json:"expect"`
}

// limitExpect is a case's expectation: Accept, or the code and kind of the rejection.
type limitExpect struct {
	Accept    bool
	Code      string          `json:"code"`
	LimitKind DecodeLimitKind `json:"limitKind"`
}

// limitsFrom is DefaultLimits with a case's explicit bounds applied.
func limitsFrom(t *testing.T, name string, set map[string]int) Limits {
	t.Helper()
	limits := DefaultLimits()
	for key, bound := range set {
		switch key {
		case "maxDepth":
			limits.MaxDepth = bound
		case "maxAtomBytes":
			limits.MaxAtomBytes = bound
		case "maxTupleArity":
			limits.MaxTupleArity = bound
		default:
			t.Fatalf("case %q: unknown limit %q", name, key)
		}
	}
	return limits
}

// expectFrom reads "accept" or {"code", "limitKind"}.
func expectFrom(t *testing.T, name string, raw json.RawMessage) limitExpect {
	t.Helper()
	var accept string
	if json.Unmarshal(raw, &accept) == nil {
		if accept != "accept" {
			t.Fatalf("case %q: unknown expectation %q", name, accept)
		}
		return limitExpect{Accept: true}
	}
	var want limitExpect
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatalf("case %q: bad expectation: %v", name, err)
	}
	return want
}

// judgeLimit decodes raw under limits and requires want: acceptance of a value that
// re-encodes to the same bytes, or a *DecodeError with exactly the expected code and
// kind. Anything else (another error, a missing kind, a different datum) fails. It
// returns the outcome's label, "accept" or the kind.
func judgeLimit(t *testing.T, name string, raw []byte, limits Limits, want limitExpect) string {
	t.Helper()
	v, err := DecodeWithLimits(raw, limits)
	if want.Accept {
		if err != nil {
			t.Errorf("case %q: expected accept, got %v", name, err)
		} else if got := Encode(v); !bytes.Equal(got, raw) {
			t.Errorf("case %q: accepted a different datum: re-encodes to %x", name, got)
		}
		return "accept"
	}
	var de *DecodeError
	if err == nil || !errors.As(err, &de) {
		t.Errorf("case %q: expected (%s, %q), got %v", name, want.Code, want.LimitKind, err)
	} else if de.Code != want.Code || de.LimitKind != want.LimitKind {
		t.Errorf("case %q: got (%s, %q) want (%s, %q)", name, de.Code, de.LimitKind, want.Code, want.LimitKind)
	}
	return string(want.LimitKind)
}

// TestCodecLimitVectors replays vectors/codec-limits.json. A bound absent from a
// case's limits keeps its DefaultLimits value.
func TestCodecLimitVectors(t *testing.T) {
	var doc struct {
		Cases []limitCase `json:"cases"`
	}
	readVectors(t, "codec-limits.json", &doc)
	if len(doc.Cases) == 0 {
		t.Fatal("codec-limits.json has no cases")
	}

	for _, c := range doc.Cases {
		raw, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatalf("case %q: bad hex: %v", c.Name, err)
		}
		judgeLimit(t, c.Name, raw, limitsFrom(t, c.Name, c.Limits), expectFrom(t, c.Name, c.Expect))
	}
}

// ----- the generated limit-policy tests (Bitspark/ontos#13, docs/design/0009) -----

// policyCorpus is vectors/codec-limits.generated.json, from tools/limit-policy/gen.mjs.
type policyCorpus struct {
	Seed   string `json:"seed"`
	Counts struct {
		Differential int `json:"differential"`
		Metamorphic  int `json:"metamorphic"`
	} `json:"counts"`
	Differential []limitCase `json:"differential"`
	Metamorphic  []struct {
		Name string `json:"name"`
		Hex  string `json:"hex"`
	} `json:"metamorphic"`
}

// readPolicyCorpus reads the committed corpus, or the one ONTOS_LIMIT_POLICY_CORPUS
// names, which is how scripts/check.sh fuzz replays a fresh seed.
func readPolicyCorpus(t *testing.T) (string, policyCorpus) {
	t.Helper()
	path := os.Getenv("ONTOS_LIMIT_POLICY_CORPUS")
	if path == "" {
		path = filepath.Join(vectorsDir(t), "codec-limits.generated.json")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc policyCorpus
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	return path, doc
}

// policyBounds are the zone's three bounds, in the order the faces report them.
var policyBounds = []struct {
	key  string
	kind DecodeLimitKind
	need func(policyNeeds) int
	set  func(*Limits, int)
}{
	{"maxDepth", LimitDecodeDepth, func(n policyNeeds) int { return n.depth }, func(l *Limits, v int) { l.MaxDepth = v }},
	{"maxAtomBytes", LimitAtomBytes, func(n policyNeeds) int { return n.atom }, func(l *Limits, v int) { l.MaxAtomBytes = v }},
	{"maxTupleArity", LimitTupleArity, func(n policyNeeds) int { return n.arity }, func(l *Limits, v int) { l.MaxTupleArity = v }},
}

// policyNeeds is what a value needs from each bound: its depth (the root at 0), its
// longest atom and its widest tuple.
type policyNeeds struct{ depth, atom, arity int }

// needsOf walks a decoded value with an explicit stack.
func needsOf(v core.Value) policyNeeds {
	type frame struct {
		v     core.Value
		depth int
	}
	var n policyNeeds
	stack := []frame{{v, 0}}
	for len(stack) > 0 {
		f := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		n.depth = max(n.depth, f.depth)
		switch x := f.v.(type) {
		case core.Atom:
			n.atom = max(n.atom, x.Len())
		case core.Tuple:
			n.arity = max(n.arity, x.Len())
			for _, item := range x.Items() {
				stack = append(stack, frame{item, f.depth + 1})
			}
		}
	}
	return n
}

// newTally has every outcome at zero, so an outcome never seen still shows.
func newTally() map[string]int {
	return map[string]int{"accept": 0, string(LimitDecodeDepth): 0, string(LimitAtomBytes): 0, string(LimitTupleArity): 0}
}

func showTally(seen map[string]int) string {
	parts := []string{fmt.Sprintf("accept %d", seen["accept"])}
	for _, b := range policyBounds {
		parts = append(parts, fmt.Sprintf("%s %d", b.kind, seen[string(b.kind)]))
	}
	return strings.Join(parts, ", ")
}

// TestLimitPolicyDifferential: inside the agreement zone (a small valid encoding, one
// bound lowered, every other bound absent or at least the value's need) each case has one
// outcome, and every face must produce it.
func TestLimitPolicyDifferential(t *testing.T) {
	path, doc := readPolicyCorpus(t)
	if len(doc.Differential) != doc.Counts.Differential {
		t.Fatalf("%d differential cases, the corpus declares %d", len(doc.Differential), doc.Counts.Differential)
	}
	seen := newTally()
	for _, c := range doc.Differential {
		raw, err := hex.DecodeString(c.Hex)
		if err != nil {
			t.Fatalf("case %q: bad hex: %v", c.Name, err)
		}
		seen[judgeLimit(t, c.Name, raw, limitsFrom(t, c.Name, c.Limits), expectFrom(t, c.Name, c.Expect))]++
	}
	for outcome, n := range seen {
		if n == 0 {
			t.Errorf("no differential case expects %s", outcome)
		}
	}
	t.Logf("go differential (%d-bit int): %d cases judged (%s); %s seed %s",
		strconv.IntSize, len(doc.Differential), showTally(seen), path, doc.Seed)
}

// TestLimitPolicyMetamorphic: a value the defaults accept is accepted with every bound at
// exactly its need, and lowering one bound below its need (to need-1 and to 0, the others
// at their defaults or at their needs) names that bound.
func TestLimitPolicyMetamorphic(t *testing.T) {
	path, doc := readPolicyCorpus(t)
	if len(doc.Metamorphic) != doc.Counts.Metamorphic {
		t.Fatalf("%d metamorphic values, the corpus declares %d", len(doc.Metamorphic), doc.Counts.Metamorphic)
	}
	seen := newTally()
	for _, m := range doc.Metamorphic {
		raw, err := hex.DecodeString(m.Hex)
		if err != nil {
			t.Fatalf("value %q: bad hex: %v", m.Name, err)
		}
		// The precondition, observed here rather than assumed: the defaults accept it.
		seen[judgeLimit(t, m.Name+" under the defaults", raw, DefaultLimits(), limitExpect{Accept: true})]++
		v, err := Decode(raw)
		if err != nil {
			continue // reported just above
		}
		needs := needsOf(v)
		tight := Limits{MaxDepth: needs.depth, MaxAtomBytes: needs.atom, MaxTupleArity: needs.arity}
		seen[judgeLimit(t, m.Name+" at its needs", raw, tight, limitExpect{Accept: true})]++
		for _, b := range policyBounds {
			need := b.need(needs)
			if need == 0 {
				continue // nothing to lower below
			}
			lowered := []int{need - 1}
			if need > 1 {
				lowered = append(lowered, 0)
			}
			for _, l := range lowered {
				for _, base := range []struct {
					label  string
					limits Limits
				}{{"defaults", DefaultLimits()}, {"needs", tight}} {
					limits := base.limits
					b.set(&limits, l)
					name := fmt.Sprintf("%s: %s=%d < %d, others at %s", m.Name, b.key, l, need, base.label)
					seen[judgeLimit(t, name, raw, limits, limitExpect{Code: "limit_exceeded", LimitKind: b.kind})]++
				}
			}
		}
	}
	decodes := 0
	for outcome, n := range seen {
		decodes += n
		if n == 0 {
			t.Errorf("the metamorphic relation never produced %s", outcome)
		}
	}
	t.Logf("go metamorphic (%d-bit int): %d values, %d decodes judged (%s); %s seed %s",
		strconv.IntSize, len(doc.Metamorphic), decodes, showTally(seen), path, doc.Seed)
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
