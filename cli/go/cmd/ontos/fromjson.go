package main

// Reading --from-json (docs/spec/ontos-cli.md "Value input"). The text is read in
// two stages, the same way in all four CLIs:
//
//  1. readJSON reads the text as RFC 8259 JSON, left to right, without recursion:
//     only space/tab/LF/CR as whitespace, nothing after the value, escapes decoded,
//     lone-surrogate escapes refused, and at most jsonNestingCap open arrays and
//     objects. The first fault ends the reading: a 2051st level is limit_exceeded,
//     anything else invalid_json.
//  2. authoringValue checks the JSON value against the authoring notation and builds
//     the core.Value, again without recursion. Duplicate member names keep their
//     last value.
//
// Text that is not UTF-8 is read with U+FFFD in place of each bad sequence
// (readJSONText), as Node does with argv before ts sees it.

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	core "github.com/bitspark/ontos/core/go"
)

// jsonNestingCap is the most arrays and objects the text may have open at once:
// 2·1024 + 2. The deepest value the codec's default decoder accepts is nested 1024
// deep (root at depth 0, ontos-codec.md §4.1); when that deepest value is an empty
// tuple, its 1025 tuples take two levels each ({"tuple":[). Anything deeper in an
// authoring text is a value the decoder would refuse.
const jsonNestingCap = 2*1024 + 2

// errTooDeep is the limit_exceeded fault: the text opens a level past jsonNestingCap.
var errTooDeep = errors.New("more than 2050 nested arrays and objects")

// jsonKind tells the generic JSON node kinds apart. Numbers, true, false and null
// are only ever refused by the shape check, so they share one kind.
type jsonKind uint8

const (
	jsonScalar jsonKind = iota
	jsonString
	jsonArray
	jsonObject
)

// jsonNode is one value of the generic JSON tree that stage 1 builds.
type jsonNode struct {
	kind    jsonKind
	str     string               // jsonString: the decoded text
	items   []*jsonNode          // jsonArray
	members map[string]*jsonNode // jsonObject: a repeated name keeps its last value
}

// readJSONText decodes the --from-json text: invalid UTF-8 becomes U+FFFD. U+FFFD
// is never hex and never part of a member name, so such text can only be accepted
// when the replacement lands inside an overwritten member.
func readJSONText(raw []byte) string {
	return strings.ToValidUTF8(string(raw), "�")
}

// jsonReader is stage 1's cursor over the text.
type jsonReader struct {
	s   string
	pos int
}

// errMalformed is the invalid_json fault, with the offset for the human diagnostic.
func (r *jsonReader) errMalformed(what string) error {
	return fmt.Errorf("malformed json at byte %d: %s", r.pos, what)
}

// peek returns the byte at the cursor, or -1 at the end of the text.
func (r *jsonReader) peek() int {
	if r.pos < len(r.s) {
		return int(r.s[r.pos])
	}
	return -1
}

// ws skips RFC 8259 whitespace: space, tab, LF and CR, nothing else.
func (r *jsonReader) ws() {
	for r.pos < len(r.s) {
		switch r.s[r.pos] {
		case ' ', '\t', '\n', '\r':
			r.pos++
		default:
			return
		}
	}
}

// readJSON is stage 1: it reads the whole text as one JSON value. It returns
// errTooDeep for a 2051st nesting level and another error for any other fault,
// whichever comes first in the text.
func readJSON(s string) (*jsonNode, error) {
	r := &jsonReader{s: s}
	// The open arrays and objects, innermost last; key is the member name the next
	// value of an open object belongs to.
	type open struct {
		node *jsonNode
		key  string
	}
	var stack []open
	r.ws()
	for {
		// A value starts at the cursor.
		var v *jsonNode
		switch c := r.peek(); {
		case c == '{' || c == '[':
			if len(stack) == jsonNestingCap {
				return nil, errTooDeep
			}
			r.pos++
			n := &jsonNode{kind: jsonArray}
			end := int(']')
			if c == '{' {
				n = &jsonNode{kind: jsonObject, members: map[string]*jsonNode{}}
				end = int('}')
			}
			r.ws()
			if r.peek() == end {
				r.pos++
				v = n
				break
			}
			key := ""
			if n.kind == jsonObject {
				k, err := r.memberName()
				if err != nil {
					return nil, err
				}
				key = k
			}
			stack = append(stack, open{node: n, key: key})
			r.ws()
			continue
		case c == '"':
			str, err := r.str()
			if err != nil {
				return nil, err
			}
			v = &jsonNode{kind: jsonString, str: str}
		case c == 't':
			if err := r.literal("true"); err != nil {
				return nil, err
			}
			v = &jsonNode{kind: jsonScalar}
		case c == 'f':
			if err := r.literal("false"); err != nil {
				return nil, err
			}
			v = &jsonNode{kind: jsonScalar}
		case c == 'n':
			if err := r.literal("null"); err != nil {
				return nil, err
			}
			v = &jsonNode{kind: jsonScalar}
		case c == '-' || (c >= '0' && c <= '9'):
			if err := r.number(); err != nil {
				return nil, err
			}
			v = &jsonNode{kind: jsonScalar}
		default:
			return nil, r.errMalformed("expected a value")
		}

		// v is complete: hand it to the innermost open container, closing each
		// container whose end follows.
		for {
			if len(stack) == 0 {
				r.ws()
				if r.pos != len(r.s) {
					return nil, r.errMalformed("data after the value")
				}
				return v, nil
			}
			top := &stack[len(stack)-1]
			if top.node.kind == jsonArray {
				top.node.items = append(top.node.items, v)
			} else {
				top.node.members[top.key] = v
			}
			r.ws()
			c := r.peek()
			if c == ',' {
				r.pos++
				if top.node.kind == jsonObject {
					k, err := r.memberName()
					if err != nil {
						return nil, err
					}
					top.key = k
				}
				r.ws()
				break
			}
			if (top.node.kind == jsonArray && c == ']') || (top.node.kind == jsonObject && c == '}') {
				r.pos++
				v = top.node
				stack = stack[:len(stack)-1]
				continue
			}
			return nil, r.errMalformed("expected ',' or the container's end")
		}
	}
}

// memberName reads `"name" :` (with whitespace around) and returns the name.
func (r *jsonReader) memberName() (string, error) {
	r.ws()
	if r.peek() != '"' {
		return "", r.errMalformed("expected a member name")
	}
	name, err := r.str()
	if err != nil {
		return "", err
	}
	r.ws()
	if r.peek() != ':' {
		return "", r.errMalformed("expected ':'")
	}
	r.pos++
	return name, nil
}

// literal reads exactly the given keyword.
func (r *jsonReader) literal(word string) error {
	if !strings.HasPrefix(r.s[r.pos:], word) {
		return r.errMalformed("expected " + word)
	}
	r.pos += len(word)
	return nil
}

// number checks the RFC 8259 number grammar. Its value is never used, so a number
// of any length is fine.
func (r *jsonReader) number() error {
	if r.peek() == '-' {
		r.pos++
	}
	switch c := r.peek(); {
	case c == '0':
		r.pos++
	case c >= '1' && c <= '9':
		r.digits()
	default:
		return r.errMalformed("expected a digit")
	}
	if r.peek() == '.' {
		r.pos++
		if !isDigit(r.peek()) {
			return r.errMalformed("expected a digit after '.'")
		}
		r.digits()
	}
	if c := r.peek(); c == 'e' || c == 'E' {
		r.pos++
		if c := r.peek(); c == '+' || c == '-' {
			r.pos++
		}
		if !isDigit(r.peek()) {
			return r.errMalformed("expected a digit in the exponent")
		}
		r.digits()
	}
	return nil
}

func (r *jsonReader) digits() {
	for isDigit(r.peek()) {
		r.pos++
	}
}

func isDigit(c int) bool { return c >= '0' && c <= '9' }

// str reads a string (the cursor is on its opening quote) and returns its decoded
// text. A control character must be escaped; a \u escape of a surrogate must be a
// high one followed at once by an escaped low one.
func (r *jsonReader) str() (string, error) {
	r.pos++
	var out strings.Builder
	for {
		c := r.peek()
		switch {
		case c < 0:
			return "", r.errMalformed("unterminated string")
		case c == '"':
			r.pos++
			return out.String(), nil
		case c < 0x20:
			return "", r.errMalformed("unescaped control character")
		case c == '\\':
			r.pos++
			e := r.peek()
			r.pos++
			switch e {
			case '"', '\\', '/':
				out.WriteByte(byte(e))
			case 'b':
				out.WriteByte('\b')
			case 'f':
				out.WriteByte('\f')
			case 'n':
				out.WriteByte('\n')
			case 'r':
				out.WriteByte('\r')
			case 't':
				out.WriteByte('\t')
			case 'u':
				cp, err := r.unicodeEscape()
				if err != nil {
					return "", err
				}
				out.WriteRune(cp)
			default:
				r.pos--
				return "", r.errMalformed("unknown escape")
			}
		default:
			// The text is valid UTF-8 (readJSONText), so copy one code point.
			_, size := utf8.DecodeRuneInString(r.s[r.pos:])
			out.WriteString(r.s[r.pos : r.pos+size])
			r.pos += size
		}
	}
}

// unicodeEscape reads the XXXX of a \uXXXX escape (the \u is consumed), and the
// low half of a surrogate pair when the first is a high surrogate.
func (r *jsonReader) unicodeEscape() (rune, error) {
	first, err := r.hex4()
	if err != nil {
		return 0, err
	}
	switch {
	case first >= 0xD800 && first <= 0xDBFF:
		if !strings.HasPrefix(r.s[r.pos:], `\u`) {
			return 0, r.errMalformed("lone high surrogate")
		}
		r.pos += 2
		second, err := r.hex4()
		if err != nil {
			return 0, err
		}
		if second < 0xDC00 || second > 0xDFFF {
			return 0, r.errMalformed("lone high surrogate")
		}
		return 0x10000 + (first-0xD800)<<10 + (second - 0xDC00), nil
	case first >= 0xDC00 && first <= 0xDFFF:
		return 0, r.errMalformed("lone low surrogate")
	}
	return first, nil
}

// hex4 reads four hex digits, either case.
func (r *jsonReader) hex4() (rune, error) {
	var v rune
	for i := 0; i < 4; i++ {
		c := r.peek()
		var d int
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, r.errMalformed("expected four hex digits")
		}
		v = v*16 + rune(d)
		r.pos++
	}
	return v, nil
}

// authoringValue is stage 2: it checks the JSON value against the authoring
// notation — the exact inverse of the --format json value rendering — and builds
// the core.Value:
//
//	value ::= { "atom":  "<lowercase-hex>" }   // even-length; "" = empty atom
//	        | { "tuple": [ value, … ] }         // [] = empty tuple
//
// Every object must have exactly one member (after repeated names keep their last
// value), "atom" or "tuple". Any other shape is an error, which the caller reports
// as invalid_json. It walks the tree with an explicit stack.
func authoringValue(root *jsonNode) (core.Value, error) {
	v, items, err := authoringNode(root)
	if err != nil {
		return nil, fmt.Errorf("$: %w", err)
	}
	if items == nil {
		return v, nil
	}
	// An open tuple: its children, the next one to check, and those built so far.
	type open struct {
		items []*jsonNode
		next  int
		built []core.Value
	}
	stack := []*open{{items: items, built: make([]core.Value, 0, len(items))}}
	for {
		top := stack[len(stack)-1]
		if top.next == len(top.items) {
			t := core.NewTuple(top.built...)
			stack = stack[:len(stack)-1]
			if len(stack) == 0 {
				return t, nil
			}
			parent := stack[len(stack)-1]
			parent.built = append(parent.built, t)
			continue
		}
		child := top.items[top.next]
		top.next++
		v, items, err := authoringNode(child)
		if err != nil {
			// The breadcrumb for the (human-only) diagnostic: $.tuple[i].tuple[j]…
			var path strings.Builder
			path.WriteString("$")
			for _, o := range stack {
				fmt.Fprintf(&path, ".tuple[%d]", o.next-1)
			}
			return nil, fmt.Errorf("%s: %w", path.String(), err)
		}
		if items == nil {
			top.built = append(top.built, v)
		} else {
			stack = append(stack, &open{items: items, built: make([]core.Value, 0, len(items))})
		}
	}
}

// authoringNode checks one node: an atom comes back as its Value, a tuple as its
// children (non-nil, possibly empty) for the caller to walk.
func authoringNode(n *jsonNode) (core.Value, []*jsonNode, error) {
	if n.kind != jsonObject {
		return nil, nil, errors.New(`value must be an object with one of "atom"/"tuple"`)
	}
	if len(n.members) != 1 {
		return nil, nil, errors.New(`value must have exactly one member, "atom" or "tuple"`)
	}
	if a, ok := n.members["atom"]; ok {
		if a.kind != jsonString {
			return nil, nil, errors.New(`"atom" must be a string`)
		}
		b, err := authoringHex(a.str)
		if err != nil {
			return nil, nil, err
		}
		return core.NewAtom(b), nil, nil
	}
	if t, ok := n.members["tuple"]; ok {
		if t.kind != jsonArray {
			return nil, nil, errors.New(`"tuple" must be an array`)
		}
		if t.items == nil {
			return nil, []*jsonNode{}, nil
		}
		return nil, t.items, nil
	}
	return nil, nil, errors.New(`value must have exactly one member, "atom" or "tuple"`)
}

// authoringHex validates an atom string as even-length LOWERCASE hex ("" is the
// empty atom) and returns its bytes. It rejects uppercase explicitly because
// encoding/hex would otherwise accept it, which would break round-trip with the
// lowercase json rendering and the cross-core agreement.
func authoringHex(s string) ([]byte, error) {
	if len(s)%2 != 0 {
		return nil, errors.New(`"atom" must be even-length hex`)
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return nil, fmt.Errorf(`"atom" must be lowercase hex (got %q)`, s)
		}
	}
	return hex.DecodeString(s)
}
