// Package data is ontos/data (L2): the registered canonical embeddings of common
// data into ontos/core L0 values — ontos-data-v1. The v1 scalars and list (int,
// utf8-text, bool, list) were frozen 2026-05-31; the structural pair map and set
// (spec §5.7–§5.8) were frozen 2026-06-01. See docs/spec/ontos-data.md.
//
// An embedding is a recognized L1 labeled compound Tuple(Atom(label), payload…)
// whose label is registered here and whose payload shape is fixed by the spec.
// Each datum has exactly ONE canonical form; this layer introduces NO new value
// and NO new equality — identity is L0 structural identity, always (spec §2).
//
//	int       Tuple(Atom("int"),       Atom(sign ‖ big-endian minimal magnitude))
//	utf8-text Tuple(Atom("utf8-text"), Atom(valid UTF-8 bytes, verbatim))
//	bool      Tuple(Atom("bool"),      Atom(0x00 = false | 0x01 = true))
//	list      Tuple(Atom("list"),      elem₀ … elemₙ₋₁)
//	map       Tuple(Atom("map"),       Tuple(k₀,v₀) … Tuple(kₙ₋₁,vₙ₋₁))
//	set       Tuple(Atom("set"),       e₀ … eₙ₋₁)
//	decimal   Tuple(Atom("decimal"),   int(mantissa), int(exponent))   // mantissa × 10^exponent
//
// Two directions per embedding: Encode<Kind> builds the canonical L0 value from a
// typed datum (the producer normalizes before building, spec §4); Read<Kind>
// recognizes whether an L0 value is a well-formed canonical embedding of that kind
// and returns the typed datum, or signals NOT-RECOGNIZED via a *DataError.
// Recognition is partial and opt-in (spec §1, §7): every non-canonical or
// malformed form is rejected (never quotiented to equal data, spec §2). Reads
// never panic on untrusted input — a not-recognized value is an error, not a crash.
//
// map (spec §5.7) and set (spec §5.8) are the embeddings whose canonical form
// depends on the codec rather than on L0 structure alone: map's entries are sorted
// strictly ascending by the ontos-codec-v1 byte order on the key, and set's
// elements strictly ascending by that order on the whole element (so EncodeMap/
// ReadMap/EncodeSet/ReadSet call codec.Encode at runtime). set is map's
// key-discipline with no values — the unordered, unique sibling of list/map. Both
// are codec-version-relative — frozen against ontos-codec-v1.
//
// decimal (spec §5.9, frozen 2026-06-06) is the fourth scalar: a label "decimal"
// followed by two int children, the value mantissa × 10^exponent. A non-zero mantissa
// is not divisible by 10 (no trailing base-10 zero) and zero is decimal(int 0, int 0),
// so each decimal has one canonical spelling. Unlike the containers list/map/set,
// decimal RECURSES into its children — they must be canonical ints (the scalar
// discipline). It is codec-INdependent (its canonical form is purely structural) and
// mirrors int's recognize/read split (RecognizeDecimal is structural; ReadDecimal
// materializes to *big.Int, which here is unbounded so it never hits a host limit).
//
// This package is kept beside the model (it imports core, never the reverse). It
// has no runtime dependency beyond core, ontos/codec (for the map key order, §5.7),
// and the standard library.
package data

import (
	"bytes"
	"fmt"
	"math/big"
	"sort"
	"unicode/utf8"

	"github.com/bitspark/ontos/codec/go"
	"github.com/bitspark/ontos/core/go"
)

// Registered label bytes (spec §5), named for readability. A label is the meaning
// under an adopted profile, so the label set is a reserved namespace (spec §1.1).
const (
	labelInt     = "int"
	labelText    = "utf8-text"
	labelBool    = "bool"
	labelList    = "list"
	labelMap     = "map"
	labelSet     = "set"
	labelDecimal = "decimal"
	labelNull    = "null"
)

// Labels is the canonical ordered list of ontos-data-v1 embedding labels, in the
// fixed recognition order (spec §5: int, utf8-text, bool, list, map, set, decimal,
// null). It is the ONE source of the registered label set and its order within this
// module — built from the named label* constants above so the spelling lives in one
// place, and pinned against the actual Read<Kind> recognizers by
// TestLabelsMatchRecognizedOrder. decimal (§5.9) was appended 2026-06-06 and null
// (§5.10) on 2026-06-13; the order carries no meaning beyond the recognition
// sequence, so a new label appends rather than reordering.
//
// The CLI keeps its own copy of this order by deliberate design (so it does not
// depend on this being exported); a cli-side parity test pins that copy against
// Labels. The order is part of the CLI's `recognized` JSON contract, so drift is a
// real, CI-caught parity bug — hence the single source here.
var Labels = []string{labelInt, labelText, labelBool, labelList, labelMap, labelSet, labelDecimal, labelNull}

// Sign bytes for the int payload's leading octet (spec §5.1).
const (
	signNonNeg = 0x00
	signNeg    = 0x01
)

// DataError reports that a value is not a well-formed canonical embedding of the
// named kind (NOT-RECOGNIZED). It mirrors codec.DecodeError: a stable, diagnostic
// Kind plus a human-readable Reason. The Kind is the embedding label ("int",
// "bool", "utf8-text", "list", "map", "set"); the Reason is diagnostic only.
type DataError struct {
	Kind   string
	Reason string
}

func (e *DataError) Error() string {
	return fmt.Sprintf("ontos/data: not a well-formed %s: %s", e.Kind, e.Reason)
}

// Code returns the embedding label this error rejected (one of Labels: "int",
// "utf8-text", "bool", "list", "map", "set"). It is a LANGUAGE-LOCAL diagnostic,
// NOT a cross-language contract: the three data cores expose codes on different
// axes (Go returns the rejected kind; Rust and TS return failure-reason sets that
// themselves differ), and unlike the codec's DecodeError.Code these are NOT pinned
// in the conformance vectors — recognition is partial and opt-in (spec §1, §7).
// Use it for local diagnostics only; do not rely on it across cores or as a stable
// wire contract.
func (e *DataError) Code() string { return e.Kind }

func notRecognized(kind, format string, args ...any) *DataError {
	return &DataError{Kind: kind, Reason: fmt.Sprintf(format, args...)}
}

// labeledPayload checks that v is a Tuple(Atom(label), Atom(payload)) — the shape
// shared by every scalar embedding (arity 2, atom label, atom payload) — and
// returns the payload bytes. The label comparison and the atom-ness of both
// children are the only structural gates; payload validation is the caller's.
func labeledPayload(v core.Value, kind, label string) ([]byte, error) {
	t, ok := v.(core.Tuple)
	if !ok {
		return nil, notRecognized(kind, "value is not a tuple")
	}
	if t.Len() != 2 {
		return nil, notRecognized(kind, "tuple arity %d, want 2", t.Len())
	}
	head, ok := t.At(0).(core.Atom)
	if !ok {
		return nil, notRecognized(kind, "label child is not an atom")
	}
	if string(head.Bytes()) != label {
		return nil, notRecognized(kind, "label is not %q", label)
	}
	payload, ok := t.At(1).(core.Atom)
	if !ok {
		return nil, notRecognized(kind, "payload child is not an atom")
	}
	return payload.Bytes(), nil
}

// EncodeInt builds the canonical int embedding of n (spec §5.1): a one-byte sign
// (0x00 non-negative, 0x01 negative) followed by the big-endian minimal-length
// magnitude of |n|. Zero is the single byte 0x00; there is no negative zero.
func EncodeInt(n *big.Int) core.Value {
	sign := byte(signNonNeg)
	if n.Sign() < 0 {
		sign = signNeg
	}
	// big.Int.Bytes returns the big-endian minimal magnitude (empty for zero), so
	// zero yields exactly the one-byte payload {0x00}.
	magnitude := new(big.Int).Abs(n).Bytes()
	payload := make([]byte, 0, 1+len(magnitude))
	payload = append(payload, sign)
	payload = append(payload, magnitude...)
	return core.NewTuple(core.NewAtom([]byte(labelInt)), core.NewAtom(payload))
}

// intPayload validates the canonical int structure and returns (sign, magnitude) if
// v is a well-formed canonical int — for ANY magnitude, including one beyond a fixed
// host integer width. It is the recognition gate shared by RecognizeInt and ReadInt:
// it runs every canonical-form check (shape, label, sign byte, minimal magnitude, no
// negative zero) on the RAW payload bytes but builds NO big.Int, so it cannot drift
// from ReadInt on what counts as canonical. Validation is on the raw bytes BEFORE any
// big.Int, because big.Int.SetBytes silently ignores leading zero bytes (which would
// let a non-canonical magnitude through). The zero case returns an empty magnitude
// with signNonNeg.
func intPayload(v core.Value) (sign byte, magnitude []byte, err error) {
	payload, err := labeledPayload(v, labelInt, labelInt)
	if err != nil {
		return 0, nil, err
	}
	if len(payload) < 1 {
		return 0, nil, notRecognized(labelInt, "empty payload (no sign byte)")
	}
	sign = payload[0]
	if sign != signNonNeg && sign != signNeg {
		return 0, nil, notRecognized(labelInt, "sign byte 0x%02x is not 0x00 or 0x01", sign)
	}
	magnitude = payload[1:]
	if len(magnitude) == 0 {
		// Empty magnitude is zero, which must carry the non-negative sign — there
		// is no negative zero.
		if sign == signNeg {
			return 0, nil, notRecognized(labelInt, "negative zero is not canonical")
		}
		return sign, magnitude, nil
	}
	if magnitude[0] == 0x00 {
		return 0, nil, notRecognized(labelInt, "magnitude has a leading 0x00 byte")
	}
	return sign, magnitude, nil
}

// RecognizeInt reports whether v is a well-formed canonical int embedding WITHOUT
// materializing it into a host integer type: nil for every canonical int (including a
// magnitude beyond any fixed host width), or a *DataError for a non-canonical form.
//
// Recognition is STRUCTURAL — "does v have the frozen canonical int form?" — distinct
// from materialization ("can a binding's host integer type hold it?"). This Go binding
// is arbitrary-precision (*big.Int), so it can always materialize what it recognizes;
// the distinction is load-bearing for a binding with a bounded host integer (e.g.
// Rust's i128), and ontos's tri-core CLIs use this surface for `read --kind int` so
// they agree on recognition regardless of host width (ontos-data.md §5.1). Never panics.
func RecognizeInt(v core.Value) error {
	_, _, err := intPayload(v)
	return err
}

// ReadInt recognizes a canonical int embedding and returns its integer value, or a
// *DataError if v is not a well-formed int — the same canonical-form validation as
// RecognizeInt (see intPayload). This binding is unbounded (*big.Int), so it never
// reports a host-width resource limit. Accepted iff: arity-2 tuple, label "int", atom
// payload p with len(p) >= 1, p[0] in {0x00, 0x01}, magnitude m = p[1:] has no leading
// 0x00, and not negative zero (empty magnitude with sign 0x01).
func ReadInt(v core.Value) (*big.Int, error) {
	sign, magnitude, err := intPayload(v)
	if err != nil {
		return nil, err
	}
	if len(magnitude) == 0 {
		return big.NewInt(0), nil
	}
	n := new(big.Int).SetBytes(magnitude)
	if sign == signNeg {
		n.Neg(n)
	}
	return n, nil
}

// EncodeBool builds the canonical bool embedding of b (spec §5.3): payload is the
// single byte 0x01 (true) or 0x00 (false).
func EncodeBool(b bool) core.Value {
	payload := byte(0x00)
	if b {
		payload = 0x01
	}
	return core.NewTuple(core.NewAtom([]byte(labelBool)), core.NewAtom([]byte{payload}))
}

// ReadBool recognizes a canonical bool embedding and returns its value, or a
// *DataError. Accepted iff: arity-2 tuple, label "bool", single-byte atom payload
// equal to 0x00 (false) or 0x01 (true). Any other payload (empty, longer, or a
// different byte) is not a well-formed bool.
func ReadBool(v core.Value) (bool, error) {
	payload, err := labeledPayload(v, labelBool, labelBool)
	if err != nil {
		return false, err
	}
	if len(payload) != 1 {
		return false, notRecognized(labelBool, "payload length %d, want 1", len(payload))
	}
	switch payload[0] {
	case 0x00:
		return false, nil
	case 0x01:
		return true, nil
	default:
		return false, notRecognized(labelBool, "payload byte 0x%02x is not 0x00 or 0x01", payload[0])
	}
}

// EncodeText builds the canonical utf8-text embedding of s (spec §5.2): the
// payload atom is the string's UTF-8 bytes verbatim, with NO Unicode
// normalization. The empty string yields the empty-atom payload.
//
// FALLIBLE (spec §4.1). A Go string is an arbitrary immutable byte sequence and is
// NOT guaranteed to be valid UTF-8 — string([]byte{0x80}) is a perfectly ordinary
// Go string. Such a string is outside utf8-text's admissible domain and is
// REJECTED here.
//
// It is rejected rather than encoded because writing the bytes through verbatim
// mints a value that this package's own ReadText refuses (it requires a valid-UTF-8
// payload) — spec §4.1 law 1, producer soundness. The result would be a value only
// this producer can make and no reader can read, which no caller can detect without
// re-reading its own output.
//
// This signature was previously total, and returning the bytes unchecked was
// justified in a comment claiming "a Go string is already a UTF-8 byte sequence".
// That is false: Go source literals are UTF-8, but a string built from bytes, read
// off a socket, or sliced mid-rune is not. Correcting it necessarily changes the
// signature — §4.1 makes fallibility a conformance property, not a style choice.
func EncodeText(s string) (core.Value, error) {
	if !utf8.ValidString(s) {
		return nil, notRecognized(labelText, "producer: string is not valid UTF-8")
	}
	return core.NewTuple(core.NewAtom([]byte(labelText)), core.NewAtom([]byte(s))), nil
}

// MustEncodeText is EncodeText for callers holding a string already known to be
// valid UTF-8 — a source literal, or text just returned by ReadText. It panics on
// an invalid string rather than minting an unreadable value.
//
// Prefer EncodeText anywhere the string's provenance is not locally obvious: this
// helper trades a silent corruption for a loud crash, which is the right trade only
// when the caller can genuinely rule the input out.
func MustEncodeText(s string) core.Value {
	v, err := EncodeText(s)
	if err != nil {
		panic(err)
	}
	return v
}

// ReadText recognizes a canonical utf8-text embedding and returns the string, or
// a *DataError. Accepted iff: arity-2 tuple, label "utf8-text", atom payload whose
// bytes are valid UTF-8 (the empty atom — the empty string — is valid). The bytes
// are returned verbatim, with no normalization.
func ReadText(v core.Value) (string, error) {
	payload, err := labeledPayload(v, labelText, labelText)
	if err != nil {
		return "", err
	}
	if !utf8.Valid(payload) {
		return "", notRecognized(labelText, "payload is not valid UTF-8")
	}
	return string(payload), nil
}

// EncodeList builds the canonical list embedding of elems (spec §5.5): the "list"
// label followed by the elements in order (tuple arity len(elems)+1). Elements are
// arbitrary L0 values, each expected to already be in its own canonical form (the
// value-not-position rule, spec §2.1); the wrapper adds no further normalization.
// The empty list is Tuple(Atom("list")) (arity 1). Order and multiplicity are
// identity — the list is never sorted or deduplicated.
func EncodeList(elems []core.Value) core.Value {
	items := make([]core.Value, 0, 1+len(elems))
	items = append(items, core.NewAtom([]byte(labelList)))
	items = append(items, elems...)
	return core.NewTuple(items...)
}

// ReadList recognizes a canonical list embedding and returns its element values
// (possibly empty), or a *DataError. Accepted iff: tuple of arity >= 1 whose first
// child is the atom "list". The elements are the remaining children, returned in
// order with NO per-element validation (list constrains only its own shape, never
// element kind, spec §5.5). The bare unlabeled Tuple(elem…) form is NOT a list,
// and the arity-0 empty tuple is NOT the empty list (the empty list is the
// arity-1 Tuple(Atom("list"))).
func ReadList(v core.Value) ([]core.Value, error) {
	t, ok := v.(core.Tuple)
	if !ok {
		return nil, notRecognized(labelList, "value is not a tuple")
	}
	if t.Len() < 1 {
		return nil, notRecognized(labelList, "tuple arity 0, want >= 1 (missing label)")
	}
	head, ok := t.At(0).(core.Atom)
	if !ok {
		return nil, notRecognized(labelList, "label child is not an atom")
	}
	if string(head.Bytes()) != labelList {
		return nil, notRecognized(labelList, "label is not %q", labelList)
	}
	items := t.Items()
	// Drop the label; the rest, in order, are the elements (possibly empty).
	elems := make([]core.Value, len(items)-1)
	copy(elems, items[1:])
	return elems, nil
}

// EncodeMap builds the canonical map embedding of entries (spec §5.7): the "map"
// label followed by the (key, value) entries as arity-2 tuples, SORTED strictly
// ascending by the ontos-codec-v1 byte order on the key (tuple arity len+1). Keys
// and values are arbitrary L0 values, each expected to already be in its own
// canonical form (the value-not-position rule, spec §2.1); the wrapper adds no
// further normalization and does NOT recurse into a key/value that claims an
// embedding label.
//
// Unlike the other encoders, EncodeMap is FALLIBLE: duplicate keys (two entries
// whose key encodings are EQUAL) are forbidden, and EncodeMap does NOT pick a
// winner — the producer must resolve duplicate intent before calling (spec §5.7,
// §4). It returns a *DataError (Kind "map") when two keys collide; the order is
// over codec bytes, never numeric or Unicode collation. The empty map is
// Tuple(Atom("map")) (arity 1).
func EncodeMap(entries [][2]core.Value) (core.Value, error) {
	// Pre-encode each key once so the sort and the duplicate check both compare
	// the same bytes (encode(key) is the codec total order, spec §5.7).
	type kv struct {
		key, val core.Value
		enc      []byte
	}
	sorted := make([]kv, len(entries))
	for i, e := range entries {
		sorted[i] = kv{key: e[0], val: e[1], enc: codec.Encode(e[0])}
	}
	sort.Slice(sorted, func(i, j int) bool {
		return bytes.Compare(sorted[i].enc, sorted[j].enc) < 0
	})
	for i := 1; i < len(sorted); i++ {
		// Equal adjacent key encodings after sorting => duplicate key. By codec
		// injectivity, equal bytes means the same L0 key value.
		if bytes.Equal(sorted[i-1].enc, sorted[i].enc) {
			return nil, notRecognized(labelMap, "duplicate key (entries %d and %d have equal key encodings)", i-1, i)
		}
	}
	items := make([]core.Value, 0, 1+len(sorted))
	items = append(items, core.NewAtom([]byte(labelMap)))
	for _, e := range sorted {
		items = append(items, core.NewTuple(e.key, e.val))
	}
	return core.NewTuple(items...), nil
}

// ReadMap recognizes a canonical map embedding and returns its (key, value)
// entries in order (possibly empty), or a *DataError. In a single left-to-right
// pass (spec §5.7): (1) v is a Tuple of arity >= 1 whose child 0 is the atom "map"
// (else not recognized); (2) arity 1 => the empty map, no entries; (3) every later
// child is a Tuple of arity EXACTLY 2 (else not recognized); (4) for each entry
// after the first, encode(prevKey) < encode(key) STRICTLY — this single comparison
// rejects both mis-sorted (greater) and duplicate (equal, by codec injectivity)
// entries. There is NO per-entry validation of whether a key or value that claims
// an embedding label is itself canonical (a non-canonical-int key is an accepted
// key, spec §5.7), mirroring ReadList. Never panics on untrusted input.
func ReadMap(v core.Value) ([][2]core.Value, error) {
	t, ok := v.(core.Tuple)
	if !ok {
		return nil, notRecognized(labelMap, "value is not a tuple")
	}
	if t.Len() < 1 {
		return nil, notRecognized(labelMap, "tuple arity 0, want >= 1 (missing label)")
	}
	head, ok := t.At(0).(core.Atom)
	if !ok {
		return nil, notRecognized(labelMap, "label child is not an atom")
	}
	if string(head.Bytes()) != labelMap {
		return nil, notRecognized(labelMap, "label is not %q", labelMap)
	}
	n := t.Len() - 1
	entries := make([][2]core.Value, 0, n)
	var prevEnc []byte
	for i := 1; i < t.Len(); i++ {
		entry, ok := t.At(i).(core.Tuple)
		if !ok {
			return nil, notRecognized(labelMap, "entry %d is not a tuple", i-1)
		}
		if entry.Len() != 2 {
			return nil, notRecognized(labelMap, "entry %d arity %d, want exactly 2", i-1, entry.Len())
		}
		key, val := entry.At(0), entry.At(1)
		enc := codec.Encode(key)
		if prevEnc != nil {
			if c := bytes.Compare(prevEnc, enc); c == 0 {
				return nil, notRecognized(labelMap, "duplicate key at entry %d (equal key encodings)", i-1)
			} else if c > 0 {
				return nil, notRecognized(labelMap, "entries out of key order at entry %d (key < previous key)", i-1)
			}
		}
		entries = append(entries, [2]core.Value{key, val})
		prevEnc = enc
	}
	return entries, nil
}

// EncodeSet builds the canonical set embedding of elems (spec §5.8): the "set"
// label followed by the elements, SORTED strictly ascending by the
// ontos-codec-v1 byte order on the WHOLE element (tuple arity len+1). It is
// `map` (§5.7) with no values — the same total order, but the elements are single
// L0 values, not (key, value) entries, so there is no entry-arity shape. Elements
// are arbitrary L0 values, each expected to already be in its own canonical form
// (the value-not-position rule, spec §2.1); the wrapper adds no further
// normalization and does NOT recurse into an element that claims an embedding
// label.
//
// Like EncodeMap, EncodeSet is FALLIBLE: duplicate elements (two whose encodings
// are EQUAL) are forbidden, and EncodeSet does NOT pick a winner — the producer
// must remove duplicates before calling (spec §5.8, §4). It returns a *DataError
// (Kind "set") when two elements collide; the order is over codec bytes, never
// numeric or Unicode collation. The empty set is Tuple(Atom("set")) (arity 1).
func EncodeSet(elems []core.Value) (core.Value, error) {
	// Pre-encode each element once so the sort and the duplicate check both
	// compare the same bytes (encode(elem) is the codec total order, spec §5.8).
	type elem struct {
		val core.Value
		enc []byte
	}
	sorted := make([]elem, len(elems))
	for i, e := range elems {
		sorted[i] = elem{val: e, enc: codec.Encode(e)}
	}
	sort.Slice(sorted, func(i, j int) bool {
		return bytes.Compare(sorted[i].enc, sorted[j].enc) < 0
	})
	for i := 1; i < len(sorted); i++ {
		// Equal adjacent element encodings after sorting => duplicate element. By
		// codec injectivity, equal bytes means the same L0 element value.
		if bytes.Equal(sorted[i-1].enc, sorted[i].enc) {
			return nil, notRecognized(labelSet, "duplicate element (elements %d and %d have equal encodings)", i-1, i)
		}
	}
	items := make([]core.Value, 0, 1+len(sorted))
	items = append(items, core.NewAtom([]byte(labelSet)))
	for _, e := range sorted {
		items = append(items, e.val)
	}
	return core.NewTuple(items...), nil
}

// ReadSet recognizes a canonical set embedding and returns its element values in
// order (possibly empty), or a *DataError. In a single left-to-right pass (spec
// §5.8): (1) v is a Tuple of arity >= 1 whose child 0 is the atom "set" (else not
// recognized); (2) arity 1 => the empty set, no elements; (3) for each element
// after the first, encode(prev) < encode(elem) STRICTLY — this single comparison
// rejects both mis-sorted (greater) and duplicate (equal, by codec injectivity)
// elements. Unlike ReadMap there is NO per-element arity check: elements are
// single values, not arity-2 entry tuples. There is NO recursion into whether an
// element that claims an embedding label is itself canonical (a non-canonical-int
// element is accepted, spec §5.8), mirroring ReadList/ReadMap. Never panics on
// untrusted input.
func ReadSet(v core.Value) ([]core.Value, error) {
	t, ok := v.(core.Tuple)
	if !ok {
		return nil, notRecognized(labelSet, "value is not a tuple")
	}
	if t.Len() < 1 {
		return nil, notRecognized(labelSet, "tuple arity 0, want >= 1 (missing label)")
	}
	head, ok := t.At(0).(core.Atom)
	if !ok {
		return nil, notRecognized(labelSet, "label child is not an atom")
	}
	if string(head.Bytes()) != labelSet {
		return nil, notRecognized(labelSet, "label is not %q", labelSet)
	}
	n := t.Len() - 1
	elems := make([]core.Value, 0, n)
	var prevEnc []byte
	for i := 1; i < t.Len(); i++ {
		e := t.At(i)
		enc := codec.Encode(e)
		if prevEnc != nil {
			if c := bytes.Compare(prevEnc, enc); c == 0 {
				return nil, notRecognized(labelSet, "duplicate element at %d (equal encodings)", i-1)
			} else if c > 0 {
				return nil, notRecognized(labelSet, "elements out of order at %d (element < previous element)", i-1)
			}
		}
		elems = append(elems, e)
		prevEnc = enc
	}
	return elems, nil
}

// bigTen is the constant 10 for the decimal trailing-zero normalization.
var bigTen = big.NewInt(10)

// magnitudeMod10 returns |n| mod 10 for a big-endian magnitude byte string (empty
// magnitude = 0), computed on the bytes so it is independent of any host integer width
// (spec §5.9). Each step folds one base-256 digit: rem = (rem*256 + b) mod 10.
func magnitudeMod10(magnitude []byte) byte {
	var rem uint16
	for _, b := range magnitude {
		rem = (rem*256 + uint16(b)) % 10
	}
	return byte(rem)
}

// normalizeDecimal returns the canonical decimal pair (spec §5.9): a non-zero mantissa
// is stripped of trailing base-10 zeros (each carried into the exponent), and zero is
// (0, 0). It does not mutate its arguments.
func normalizeDecimal(mantissa, exponent *big.Int) (*big.Int, *big.Int) {
	if mantissa.Sign() == 0 {
		return big.NewInt(0), big.NewInt(0)
	}
	m := new(big.Int).Set(mantissa)
	e := new(big.Int).Set(exponent)
	q := new(big.Int)
	r := new(big.Int)
	for {
		q.QuoRem(m, bigTen, r) // truncated division: r has the sign of m, r==0 iff 10 | m
		if r.Sign() != 0 {
			break
		}
		m.Set(q)
		e.Add(e, big.NewInt(1))
	}
	return m, e
}

// decimalParts validates the canonical decimal structure and returns its int mantissa
// and exponent child values if v is a well-formed canonical decimal — for ANY
// mantissa/exponent magnitude. The recognition gate shared by RecognizeDecimal and
// ReadDecimal: shape (arity-3 tuple, "decimal" label) + both children canonical ints
// (intPayload, structural so a beyond-host child is still accepted) + the
// canonical-decimal rule — zero is decimal(int 0, int 0), and a non-zero mantissa is
// not divisible by 10 (decided on the magnitude bytes via magnitudeMod10).
//
// Unlike list/map/set, decimal RECURSES into its children: it is a scalar (identity =
// the number it denotes), so one-spelling-per-value requires canonical-int children —
// the scalar discipline, not the container discipline (spec §5.9). Never panics.
func decimalParts(v core.Value) (mantissa, exponent core.Value, err error) {
	t, ok := v.(core.Tuple)
	if !ok {
		return nil, nil, notRecognized(labelDecimal, "value is not a tuple")
	}
	if t.Len() != 3 {
		return nil, nil, notRecognized(labelDecimal, "tuple arity %d, want 3", t.Len())
	}
	head, ok := t.At(0).(core.Atom)
	if !ok {
		return nil, nil, notRecognized(labelDecimal, "label child is not an atom")
	}
	if string(head.Bytes()) != labelDecimal {
		return nil, nil, notRecognized(labelDecimal, "label is not %q", labelDecimal)
	}
	mantissa, exponent = t.At(1), t.At(2)
	_, mMag, err := intPayload(mantissa)
	if err != nil {
		return nil, nil, notRecognized(labelDecimal, "mantissa is not a canonical int: %v", err)
	}
	_, eMag, err := intPayload(exponent)
	if err != nil {
		return nil, nil, notRecognized(labelDecimal, "exponent is not a canonical int: %v", err)
	}
	if len(mMag) == 0 {
		// mantissa == 0 ⇒ the exponent must be canonical zero (empty magnitude).
		if len(eMag) != 0 {
			return nil, nil, notRecognized(labelDecimal, "zero mantissa requires a zero exponent")
		}
	} else if magnitudeMod10(mMag) == 0 {
		return nil, nil, notRecognized(labelDecimal, "non-zero mantissa is divisible by 10 (trailing base-10 zero)")
	}
	return mantissa, exponent, nil
}

// EncodeDecimal builds the canonical decimal embedding of mantissa × 10^exponent
// (spec §5.9): Tuple(Atom("decimal"), int(mantissa), int(exponent)). The producer
// normalizes first (normalizeDecimal): a non-zero mantissa is stripped of trailing
// base-10 zeros into the exponent, and zero is decimal(int 0, int 0). The children are
// the full canonical int embedding (§5.1), per the value-not-position rule (§2.1).
func EncodeDecimal(mantissa, exponent *big.Int) core.Value {
	m, e := normalizeDecimal(mantissa, exponent)
	return core.NewTuple(core.NewAtom([]byte(labelDecimal)), EncodeInt(m), EncodeInt(e))
}

// RecognizeDecimal reports whether v is a well-formed canonical decimal embedding
// WITHOUT materializing its mantissa/exponent: nil for every canonical decimal
// (including one whose mantissa or exponent magnitude exceeds any fixed host width), or
// a *DataError. Structural, like RecognizeInt; this Go binding is arbitrary-precision
// (*big.Int) so it can always materialize what it recognizes, but ontos's tri-core CLIs
// use this surface for `read --kind decimal` so they agree regardless of host width
// (spec §5.9). Never panics.
func RecognizeDecimal(v core.Value) error {
	_, _, err := decimalParts(v)
	return err
}

// ReadDecimal recognizes a canonical decimal embedding and returns (mantissa, exponent)
// as *big.Int (the value is mantissa × 10^exponent), or a *DataError — the same
// canonical-form validation as RecognizeDecimal. This binding is unbounded (*big.Int),
// so it never reports a host-width resource limit. Never panics on untrusted input.
func ReadDecimal(v core.Value) (mantissa, exponent *big.Int, err error) {
	mv, ev, err := decimalParts(v)
	if err != nil {
		return nil, nil, err
	}
	if mantissa, err = ReadInt(mv); err != nil {
		return nil, nil, err
	}
	if exponent, err = ReadInt(ev); err != nil {
		return nil, nil, err
	}
	return mantissa, exponent, nil
}

// EncodeNull builds the canonical null embedding (spec §5.10): the nullary compound
// Tuple(Atom("null")) — the "null" label with NO payload children (tuple arity
// exactly 1). null is the single canonical spelling of present-but-no-value; it has
// exactly one inhabitant (there is no value to vary), so EncodeNull takes no argument
// and always returns the same value. Its byte form is fixed by structure alone, so —
// like list and bool — it is codec-independent and not codec-version-relative.
func EncodeNull() core.Value {
	return core.NewTuple(core.NewAtom([]byte(labelNull)))
}

// RecognizeNull reports whether v is the canonical null embedding (spec §5.10): nil
// iff v is a tuple of arity EXACTLY 1 whose only child is the atom "null", or a
// *DataError otherwise. Any payload (arity > 1) is NOT a well-formed null — it remains
// a valid L0 value, merely unrecognized (the typed not-recognized rejection, never a
// panic and never a quotient). null carries no value to materialize, so this is also
// the read surface; ReadNull is the alias the tri-core CLIs would use. The bare
// unlabeled Tuple() (arity 0) and a bare Atom("null") are likewise not a null.
func RecognizeNull(v core.Value) error {
	t, ok := v.(core.Tuple)
	if !ok {
		return notRecognized(labelNull, "value is not a tuple")
	}
	if t.Len() != 1 {
		return notRecognized(labelNull, "tuple arity %d, want exactly 1 (null carries no payload)", t.Len())
	}
	head, ok := t.At(0).(core.Atom)
	if !ok {
		return notRecognized(labelNull, "label child is not an atom")
	}
	if string(head.Bytes()) != labelNull {
		return notRecognized(labelNull, "label is not %q", labelNull)
	}
	return nil
}

// ReadNull recognizes the canonical null embedding (spec §5.10), returning a *DataError
// iff v is not the single inhabitant Tuple(Atom("null")). There is no value to return —
// null is present-but-no-value — so a nil error is the whole result; it never panics.
// Identical validation to RecognizeNull (null has no payload, so recognize and read
// coincide, as they do for the empty containers).
func ReadNull(v core.Value) error {
	return RecognizeNull(v)
}
