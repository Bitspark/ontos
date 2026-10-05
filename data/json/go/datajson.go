// Package datajson implements ontos-data-json/1: the named, TOTAL projection of a
// domain-JSON document to an ontos/data value (docs/spec/ontos-data-json.md).
//
// It is the first-class, importable realization of that projection, driven by the
// cross-impl conformance lock in vectors/data-json.json. Consumers that need the
// ontos reading of a JSON value — e.g. domain-separated identity digests — call
// [Project] directly instead of re-implementing the walk; a re-implementation is
// the preimage-drift class this package exists to remove.
//
// The projection is total over the accepted JSON forms and composes the frozen
// ontos/data primitives (it never re-derives a byte form):
//
//	JSON object            -> data map        (data.EncodeMap)
//	JSON array             -> data list       (data.EncodeList)
//	JSON string            -> utf8-text       (data.EncodeText)
//	JSON integer literal   -> int             (data.EncodeInt, arbitrary precision)
//	JSON true / false      -> bool            (data.EncodeBool)
//	JSON null              -> null()          (data.EncodeNull)
//
// A JSON number carrying a fraction or exponent (1.5, 1e3, 1.0) falls in the
// RESERVED decimal arm, which ontos-data-json/1 does not graduate: Project rejects
// it path-named rather than coercing to a float or a decimal. Acceptance is by the
// literal FORM, not the numeric value — 1.0 and 1e3 reject even though they are
// whole numbers.
//
// Project reads exactly one JSON document; trailing data after it is rejected.
//
// WHY THIS PACKAGE PARSES JSON ITSELF, instead of encoding/json
// -------------------------------------------------------------
// Two acceptance decisions are destroyed by the stock decoder before the
// projection can see them:
//
//   - The number LITERAL. Acceptance is decided on the literal form (1e3 vs
//     1000), which json.Decoder.UseNumber() happens to preserve — that alone
//     once kept encoding/json viable here.
//
//   - String FIDELITY. encoding/json substitutes U+FFFD for invalid UTF-8 and
//     for unpaired \uXXXX surrogate escapes while decoding, and then SUCCEEDS.
//     U+FFFD is admissible, so the result is a well-formed value whose digest is
//     not the digest of the input — a producer succeeding with a DIFFERENT
//     admissible datum, which ontos-data.md §4.1 law 2 forbids outright (ontos-internal#216).
//     This projection exists to produce identity digests; a silent preimage
//     substitution is the worst outcome available and is invisible at every
//     layer.
//
// The reader below therefore accepts exactly RFC 8259 and nothing more,
// mirroring the TS peer's reader: number literals are captured verbatim, string
// content bytes are copied verbatim, and an unpaired surrogate escape is decoded
// to its WTF-8 bytes — which no valid UTF-8 string contains — so the walk can
// reject it path-named with the reason vectors/data-json.json pins, instead of
// silently reading a different string. Raw invalid UTF-8 inside a string literal
// likewise survives to the walk, where data.EncodeText refuses it (spec §4.1).
package datajson

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	core "github.com/bitspark/ontos/core/go"
	data "github.com/bitspark/ontos/data/go"
)

// Error is a projection failure carrying the JSONPath of the offending node ($ for
// the root, $.key for an object member, $[i] for an array element) and a stable,
// spec-worded reason. The reason strings are part of the ontos-data-json/1
// conformance surface — vectors/data-json.json pins them — so they are formatted
// here to match the lock byte-for-byte.
type Error struct {
	Path   string
	Reason string
}

func (e *Error) Error() string { return e.Path + ": " + e.Reason }

// LimitError reports that the document exceeded this face's nesting-depth
// ceiling (an IMPLEMENTATION BOUND, ontos-data-json/1 resource-limit posture,
// ontos-internal#236). It is deliberately a distinct type from [Error]: a depth limit does
// not say the document is inadmissible under /1 — another conformant face with
// a higher ceiling may accept it — so conflating the two would put the limit
// into the profile's semantics. The spec's floor is 512; this face's ceiling is
// [MaxDepth]. Mirrors ontos-codec's decode-limit class (limit_exceeded, never a
// domain error).
type LimitError struct {
	Limit int
}

func (e *LimitError) Error() string {
	return fmt.Sprintf("nesting depth exceeds this face's limit (%d) — implementation bound, not a rejection of the document under ontos-data-json/1", e.Limit)
}

// MaxDepth is this face's nesting-depth ceiling: the depth of the deepest
// object/array nesting Project reads before returning a [*LimitError]. It
// restores the protection the stock decoder carried (encoding/json capped at
// 10000) that the own-reader move dropped (ontos-internal#236). Conformance requires
// accepting at least the spec's floor of 512; the ceiling itself is per-face
// and never pinned by vectors.
const MaxDepth = 10000

// DuplicateKeys selects how [ProjectWith] treats a JSON object that repeats a
// member name (ontos-data-json.md §"The projection", *Duplicate object keys*).
type DuplicateKeys int

const (
	// DuplicateKeysLastWins is the ontos-data-json/1 default and what [Project]
	// does: repeated members collapse to the LAST occurrence at the reader, before
	// any ontos/data value is built.
	DuplicateKeysLastWins DuplicateKeys = iota
	// DuplicateKeysReject refuses the document at the first repeated member with a
	// [*DuplicateKeyError]. It is a stricter SOURCE-ADMISSION policy over the same
	// mapping, not a different reading: every document it accepts projects to
	// exactly the value (and bytes) [Project] emits for it. Names collide on their
	// exact decoded content — an escaped and a literal spelling of the same name
	// are one name; two names that differ in bytes are two names, even when
	// canonically equivalent (no Unicode normalization, ontos-data §5.2). Ontos
	// ontos-internal#322.
	DuplicateKeysReject
)

// Options tunes [ProjectWith]. The zero value is exactly [Project].
type Options struct {
	DuplicateKeys DuplicateKeys
}

// DuplicateKeyError is the strict-mode refusal: under [DuplicateKeysReject] the
// object at the parent of Path repeated the member Key. It is a source-admission
// class like [Error] — the document was refused, not a resource bound hit — and
// deliberately a distinct type from both [Error] (the /1 domain rejections, whose
// reasons the vectors pin verbatim) and [LimitError] (the resource-limit class),
// so a caller can tell "the admission policy it opted into refused this" from
// "the profile has no reading for it". The reader stops at the FIRST repeat it
// meets in source order; Path names that member (e.g. `$.items[1].id`) and Key
// is the name as decoded.
type DuplicateKeyError struct {
	Path string
	Key  string
}

func (e *DuplicateKeyError) Error() string {
	return fmt.Sprintf("%s: duplicate object key %q — rejected under duplicateKeys: reject (the ontos-data-json/1 default is last-wins)", e.Path, e.Key)
}

// Project reads a single domain-JSON document and returns its ontos-data-json/1
// value. See the package doc for the arm table and the reserved decimal arm. On any
// rejected form it returns an [*Error] carrying the JSONPath of the offending node.
// Repeated object members collapse last-wins; see [ProjectWith] to refuse them.
func Project(raw json.RawMessage) (core.Value, error) {
	return ProjectWith(raw, Options{})
}

// ProjectWith is [Project] with [Options]. With the zero Options it is Project;
// with [DuplicateKeysReject] it additionally returns a [*DuplicateKeyError] for a
// document that repeats an object member. Every other outcome — the accepted
// value and its bytes, the path-named [*Error] rejections, the [*LimitError]
// class — is identical between the two modes.
func ProjectWith(raw json.RawMessage, opts Options) (core.Value, error) {
	r := &reader{src: raw, strict: opts.DuplicateKeys == DuplicateKeysReject}
	node, err := r.readDocument()
	if err != nil {
		var pe *Error
		if errors.As(err, &pe) {
			return nil, pe
		}
		var se *syntaxError
		if errors.As(err, &se) {
			return nil, &Error{Path: "$", Reason: "invalid JSON: " + se.Error()}
		}
		return nil, err // *LimitError and *DuplicateKeyError pass through as themselves
	}
	return project(node, "$")
}

// ---------------------------------------------------------------------------
// JSON reading — literal-preserving, fidelity-preserving, RFC 8259 exact.
// ---------------------------------------------------------------------------

// numberLiteral is a JSON number kept as its source literal, never as a float.
type numberLiteral string

// jsonNode is the reader's tree: nil, bool, string, numberLiteral, []jsonNode, or
// map[string]jsonNode (duplicate keys collapsed last-wins at the reader, matching
// the TS peer and the spec's duplicate-keys rule). Strings are NOT guaranteed
// valid UTF-8: an unpaired surrogate escape arrives as WTF-8 bytes and raw
// invalid input bytes arrive verbatim — the walk rejects both path-named.
type jsonNode interface{}

// syntaxError is a malformed-JSON failure; Project reports it $-rooted.
type syntaxError struct {
	msg    string
	offset int
}

func (e *syntaxError) Error() string { return fmt.Sprintf("%s at offset %d", e.msg, e.offset) }

type reader struct {
	src   []byte
	i     int
	depth int // current object/array nesting; bounded by MaxDepth (ontos-internal#236)

	// strict is DuplicateKeysReject: the reader refuses a repeated object member
	// instead of collapsing it. path is maintained only in strict mode, so the
	// refusal can name the member; the default reader does not pay for it.
	strict bool
	path   []pathSeg
}

// pathSeg is one step of the reader's JSONPath: an object member or an array index.
type pathSeg struct {
	key   string
	index int
	isIdx bool
}

// memberPath renders the JSONPath of member key under the current object, in the
// same `$.key` / `$[i]` spelling the projection walk uses for its rejections.
func (r *reader) memberPath(key string) string {
	var sb strings.Builder
	sb.WriteString("$")
	for _, s := range r.path {
		if s.isIdx {
			fmt.Fprintf(&sb, "[%d]", s.index)
		} else {
			sb.WriteString(".")
			sb.WriteString(s.key)
		}
	}
	sb.WriteString(".")
	sb.WriteString(key)
	return sb.String()
}

// push counts one level of object/array nesting; the reader is recursive, so
// this counter is what keeps a hostile "[[[[…" document from running the stack
// out from under every caller (the crash class ontos-internal#236 measured on all three
// faces). Called on entry to readObject/readArray; pop on exit.
func (r *reader) push() error {
	r.depth++
	if r.depth > MaxDepth {
		return &LimitError{Limit: MaxDepth}
	}
	return nil
}

func (r *reader) pop() { r.depth-- }

func (r *reader) fail(msg string) error { return &syntaxError{msg: msg, offset: r.i} }

func (r *reader) skipWhitespace() {
	for r.i < len(r.src) {
		switch r.src[r.i] {
		case ' ', '\t', '\n', '\r':
			r.i++
		default:
			return
		}
	}
}

// readDocument reads one complete JSON value, then requires end-of-input.
func (r *reader) readDocument() (jsonNode, error) {
	r.skipWhitespace()
	if r.i >= len(r.src) {
		return nil, &Error{Path: "$", Reason: "empty input: expected one JSON document"}
	}
	node, err := r.readValue()
	if err != nil {
		return nil, err
	}
	r.skipWhitespace()
	if r.i < len(r.src) {
		return nil, &Error{Path: "$", Reason: "trailing data after JSON document"}
	}
	return node, nil
}

func (r *reader) readValue() (jsonNode, error) {
	if r.i >= len(r.src) {
		return nil, r.fail("unexpected end of input")
	}
	switch c := r.src[r.i]; {
	case c == '{':
		return r.readObject()
	case c == '[':
		return r.readArray()
	case c == '"':
		return r.readString()
	case c == 't':
		return r.literal("true", true)
	case c == 'f':
		return r.literal("false", false)
	case c == 'n':
		return r.literal("null", nil)
	case c == '-' || (c >= '0' && c <= '9'):
		return r.readNumber()
	default:
		return nil, r.fail(fmt.Sprintf("unexpected character %q", c))
	}
}

func (r *reader) literal(word string, v jsonNode) (jsonNode, error) {
	if bytes.HasPrefix(r.src[r.i:], []byte(word)) {
		r.i += len(word)
		return v, nil
	}
	return nil, r.fail("invalid literal")
}

func (r *reader) readObject() (jsonNode, error) {
	if err := r.push(); err != nil {
		return nil, err
	}
	defer r.pop()
	r.i++ // '{'
	out := map[string]jsonNode{}
	r.skipWhitespace()
	if r.i < len(r.src) && r.src[r.i] == '}' {
		r.i++
		return out, nil
	}
	for {
		r.skipWhitespace()
		if r.i >= len(r.src) || r.src[r.i] != '"' {
			return nil, r.fail("expected object key")
		}
		key, err := r.readString()
		if err != nil {
			return nil, err
		}
		k := key.(string)
		if r.strict {
			// Exact decoded content: readString has already resolved escapes, so
			// "a" and "\u0061" meet here as the same string; no normalization.
			if _, dup := out[k]; dup {
				return nil, &DuplicateKeyError{Path: r.memberPath(k), Key: k}
			}
			r.path = append(r.path, pathSeg{key: k})
		}
		r.skipWhitespace()
		if r.i >= len(r.src) || r.src[r.i] != ':' {
			return nil, r.fail("expected ':' after object key")
		}
		r.i++
		r.skipWhitespace()
		val, err := r.readValue()
		if err != nil {
			return nil, err
		}
		if r.strict {
			r.path = r.path[:len(r.path)-1]
		}
		out[k] = val // last-wins on duplicate keys (default mode)
		r.skipWhitespace()
		if r.i >= len(r.src) {
			return nil, r.fail("expected ',' or '}' in object")
		}
		switch r.src[r.i] {
		case ',':
			r.i++
		case '}':
			r.i++
			return out, nil
		default:
			return nil, r.fail("expected ',' or '}' in object")
		}
	}
}

func (r *reader) readArray() (jsonNode, error) {
	if err := r.push(); err != nil {
		return nil, err
	}
	defer r.pop()
	r.i++ // '['
	out := []jsonNode{}
	r.skipWhitespace()
	if r.i < len(r.src) && r.src[r.i] == ']' {
		r.i++
		return out, nil
	}
	for i := 0; ; i++ {
		r.skipWhitespace()
		if r.strict {
			r.path = append(r.path, pathSeg{index: i, isIdx: true})
		}
		v, err := r.readValue()
		if err != nil {
			return nil, err
		}
		if r.strict {
			r.path = r.path[:len(r.path)-1]
		}
		out = append(out, v)
		r.skipWhitespace()
		if r.i >= len(r.src) {
			return nil, r.fail("expected ',' or ']' in array")
		}
		switch r.src[r.i] {
		case ',':
			r.i++
		case ']':
			r.i++
			return out, nil
		default:
			return nil, r.fail("expected ',' or ']' in array")
		}
	}
}

// readString decodes one string literal. Content bytes are copied VERBATIM (no
// validation, no substitution — fidelity is the point); escapes are decoded per
// RFC 8259, with a paired \uXXXX\uXXXX surrogate pair combining to one code
// point and an unpaired surrogate kept addressable as WTF-8 for the walk to
// reject.
func (r *reader) readString() (jsonNode, error) {
	r.i++ // opening quote
	var b []byte
	for {
		if r.i >= len(r.src) {
			return nil, r.fail("unterminated string")
		}
		c := r.src[r.i]
		if c == '"' {
			r.i++
			return string(b), nil
		}
		if c == '\\' {
			r.i++
			var err error
			b, err = r.appendEscape(b)
			if err != nil {
				return nil, err
			}
			continue
		}
		// RFC 8259: raw control characters below U+0020 must be escaped.
		if c < 0x20 {
			return nil, r.fail("unescaped control character in string")
		}
		b = append(b, c)
		r.i++
	}
}

func (r *reader) appendEscape(b []byte) ([]byte, error) {
	if r.i >= len(r.src) {
		return nil, r.fail("unterminated escape")
	}
	c := r.src[r.i]
	r.i++
	switch c {
	case '"', '\\', '/':
		return append(b, c), nil
	case 'b':
		return append(b, '\b'), nil
	case 'f':
		return append(b, '\f'), nil
	case 'n':
		return append(b, '\n'), nil
	case 'r':
		return append(b, '\r'), nil
	case 't':
		return append(b, '\t'), nil
	case 'u':
		u1, err := r.hex4()
		if err != nil {
			return nil, err
		}
		if u1 >= 0xD800 && u1 <= 0xDBFF {
			// High surrogate: it pairs with an immediately following \uXXXX low
			// surrogate into one code point; anything else leaves it unpaired.
			if r.i+1 < len(r.src) && r.src[r.i] == '\\' && r.src[r.i+1] == 'u' {
				save := r.i
				r.i += 2
				u2, err := r.hex4()
				if err != nil {
					return nil, err
				}
				if u2 >= 0xDC00 && u2 <= 0xDFFF {
					return utf8.AppendRune(b, utf16.DecodeRune(rune(u1), rune(u2))), nil
				}
				r.i = save // not the pair's low half — that escape reads on its own
			}
			return appendWTF8(b, u1), nil
		}
		if u1 >= 0xDC00 && u1 <= 0xDFFF {
			return appendWTF8(b, u1), nil // low surrogate with no preceding high
		}
		return utf8.AppendRune(b, rune(u1)), nil
	default:
		return nil, r.fail(fmt.Sprintf("invalid escape \\%c", c))
	}
}

func (r *reader) hex4() (uint16, error) {
	if r.i+4 > len(r.src) {
		return 0, r.fail("invalid \\u escape")
	}
	var v uint16
	for k := 0; k < 4; k++ {
		c := r.src[r.i+k]
		var d byte
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, r.fail("invalid \\u escape")
		}
		v = v<<4 | uint16(d)
	}
	r.i += 4
	return v, nil
}

// appendWTF8 appends the WTF-8 (UTF-8-shaped, but invalid) encoding of a lone
// surrogate code unit. No valid UTF-8 string contains these bytes, so the walk
// can recover the exact code unit for the pinned rejection reason.
func appendWTF8(b []byte, u uint16) []byte {
	return append(b, 0xE0|byte(u>>12), 0x80|byte((u>>6)&0x3F), 0x80|byte(u&0x3F))
}

// readNumber captures the number literal verbatim, per the RFC 8259 grammar.
func (r *reader) readNumber() (jsonNode, error) {
	start := r.i
	if r.src[r.i] == '-' {
		r.i++
	}
	// int: 0 | [1-9][0-9]*  — a leading zero may not be followed by digits.
	switch {
	case r.i < len(r.src) && r.src[r.i] == '0':
		r.i++
	case r.i < len(r.src) && r.src[r.i] >= '1' && r.src[r.i] <= '9':
		for r.i < len(r.src) && isDigit(r.src[r.i]) {
			r.i++
		}
	default:
		return nil, r.fail("expected digit in number")
	}
	// frac
	if r.i < len(r.src) && r.src[r.i] == '.' {
		r.i++
		if r.i >= len(r.src) || !isDigit(r.src[r.i]) {
			return nil, r.fail("expected digit after '.' in number")
		}
		for r.i < len(r.src) && isDigit(r.src[r.i]) {
			r.i++
		}
	}
	// exp
	if r.i < len(r.src) && (r.src[r.i] == 'e' || r.src[r.i] == 'E') {
		r.i++
		if r.i < len(r.src) && (r.src[r.i] == '+' || r.src[r.i] == '-') {
			r.i++
		}
		if r.i >= len(r.src) || !isDigit(r.src[r.i]) {
			return nil, r.fail("expected digit in number exponent")
		}
		for r.i < len(r.src) && isDigit(r.src[r.i]) {
			r.i++
		}
	}
	return numberLiteral(r.src[start:r.i]), nil
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

func project(node jsonNode, path string) (core.Value, error) {
	switch v := node.(type) {
	case nil:
		return data.EncodeNull(), nil
	case bool:
		return data.EncodeBool(v), nil
	case string:
		return projectText(v, path)
	case numberLiteral:
		return projectNumber(string(v), path)
	case []jsonNode:
		elems := make([]core.Value, len(v))
		for i, e := range v {
			cv, err := project(e, fmt.Sprintf("%s[%d]", path, i))
			if err != nil {
				return nil, err
			}
			elems[i] = cv
		}
		return data.EncodeList(elems), nil
	case map[string]jsonNode:
		// Iterate keys in sorted order purely for DETERMINISTIC error paths when a
		// document has more than one offending node; it does not affect the emitted
		// bytes, because data.EncodeMap re-sorts entries canonically by encoded key.
		// Duplicate JSON keys have already collapsed last-wins in the reader above,
		// so the map is duplicate-free before EncodeMap ever sees it.
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		entries := make([][2]core.Value, 0, len(keys))
		for _, k := range keys {
			cv, err := project(v[k], path+"."+k)
			if err != nil {
				return nil, err
			}
			kv, err := projectText(k, path+"."+k)
			if err != nil {
				return nil, err
			}
			entries = append(entries, [2]core.Value{kv, cv})
		}
		return data.EncodeMap(entries)
	default:
		return nil, &Error{Path: path, Reason: fmt.Sprintf("unsupported JSON value %T", node)}
	}
}

// projectText reads a string node as utf8-text, enforcing the ontos-data.md §4.1
// fidelity law (ontos-internal#216): a string with no UTF-8 encoding is REJECTED path-named,
// never coerced to U+FFFD — the substitution would succeed with a different
// admissible datum, invisible to every caller of an identity-digest projection.
// The unpaired-surrogate reason is pinned by vectors/data-json.json, shared
// byte-for-byte with the TS peer.
func projectText(s, path string) (core.Value, error) {
	if bad := surrogateDefect(s); bad != nil {
		return nil, &Error{
			Path: path,
			Reason: fmt.Sprintf("unpaired surrogate 0x%04x at UTF-16 index %d — the string has no UTF-8 encoding, rejected under ontos-data-json/1 (U+FFFD coercion violates the ontos-data.md §4.1 fidelity law)",
				bad.unit, bad.index),
		}
	}
	// Raw invalid UTF-8 (byte-level, not escape-level) lands here: the reader
	// copied the bytes verbatim, and EncodeText refuses them (spec §4.1).
	tv, err := data.EncodeText(s)
	if err != nil {
		return nil, &Error{Path: path, Reason: err.Error()}
	}
	return tv, nil
}

type unpairedSurrogate struct {
	unit  uint16 // the surrogate UTF-16 code unit
	index int    // its UTF-16 code-unit index within the decoded string
}

// surrogateDefect scans s for the first WTF-8-encoded surrogate — the trace the
// reader leaves for an unpaired \uXXXX surrogate escape — and reports its code
// unit and UTF-16 index (the coordinates the TS peer naturally reports, since a
// JS string holds the lone code unit directly). A raw invalid byte encountered
// first returns nil: that defect class is EncodeText's to name.
func surrogateDefect(s string) *unpairedSurrogate {
	u16 := 0
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			if u, ok := wtf8Surrogate(s[i:]); ok {
				return &unpairedSurrogate{unit: u, index: u16}
			}
			return nil
		}
		u16 += utf16.RuneLen(r)
		i += size
	}
	return nil
}

// wtf8Surrogate reports whether s begins with the 3-byte WTF-8 encoding of a
// surrogate code point (0xED 0xA0..0xBF 0x80..0xBF), and which one.
func wtf8Surrogate(s string) (uint16, bool) {
	if len(s) >= 3 && s[0] == 0xED && s[1] >= 0xA0 && s[1] <= 0xBF && s[2] >= 0x80 && s[2] <= 0xBF {
		return 0xD000 | uint16(s[1]&0x3F)<<6 | uint16(s[2]&0x3F), true
	}
	return 0, false
}

// projectNumber reads a JSON number literal. An integer literal (^-?[0-9]+$) maps to
// ontos int at arbitrary precision; any literal carrying a fraction or exponent is
// the reserved decimal arm and is rejected path-named. The classification is lexical
// — the literal string, not its numeric value — so 1e3 and 1.0 reject like 3.14.
func projectNumber(lit, path string) (core.Value, error) {
	if strings.ContainsAny(lit, ".eE") {
		return nil, &Error{
			Path:   path,
			Reason: fmt.Sprintf("non-integer number literal %q — fraction/exponent rejected under ontos-data-json/1 (reserved decimal arm ungraduated)", lit),
		}
	}
	n, ok := new(big.Int).SetString(lit, 10)
	if !ok {
		// A literal without . e or E that big.Int cannot parse should not occur
		// for well-formed JSON, but fail loudly rather than emit an unlocked shape.
		return nil, &Error{Path: path, Reason: fmt.Sprintf("malformed integer literal %q", lit)}
	}
	return data.EncodeInt(n), nil
}
