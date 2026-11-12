package jsontext

import (
	"fmt"
	"unicode/utf8"
)

// NodeKind is the kind of a JSON tree node (total §4.3, "The JSON tree").
type NodeKind uint8

const (
	Object NodeKind = iota
	Array
	String
	Number
	True
	False
	Null
)

// Node is a node of the JSON tree. Its span is [Start, End): a string's from its opening to
// its closing quotation mark, a number's or a literal's lexeme, an object's or an array's
// from its opening to its closing bracket.
type Node struct {
	Kind       NodeKind
	Start, End int
	// Text is a string's decoded content, or a number's lexeme.
	Text string
	// Items are an array's elements.
	Items []*Node
	// Members are an object's members, in source order.
	Members []Member
}

// Member is one member of an object: its decoded name, the span of the name's token (from
// its opening to its closing quotation mark) and its value.
type Member struct {
	Name               string
	NameStart, NameEnd int
	Value              *Node
}

// Member returns the object's member named name, if it has one.
func (x *Node) Member(name string) (Member, bool) {
	for _, m := range x.Members {
		if m.Name == name {
			return m, true
		}
	}
	return Member{}, false
}

// Read runs stages 1 to 3 (total §4.1): the size bound, well-formed UTF-8 and the strict
// JSON reading of §4.3. It returns the root of the JSON tree.
func Read(input []byte, l *Limits) (*Node, *Fault) {
	if f := Text(input, l); f != nil {
		return nil, f
	}
	lx := lexer{b: input, n: len(input), maxDepth: l.JSONDepth}
	return lx.run()
}

// smallObject is the member count up to which a duplicate name is found by a scan rather
// than through a set.
const smallObject = 8

// frame is an array or object that is open while the lexer reads its contents.
type frame struct {
	node *Node
	// index is the index of the array element being read.
	index int
	// name, nameStart and nameEnd are the object member being read.
	name               string
	nameStart, nameEnd int
	// names holds an object's member names once it has more than smallObject of them.
	names map[string]struct{}
}

type lexer struct {
	b        []byte
	n        int
	p        int
	maxDepth int
	stack    []frame
}

// path is the path through the first k open frames: an object adds the name of the member
// being read, an array the index of the element being read. The value being read has the
// path of all frames, and the innermost container's own path leaves out its frame.
func (lx *lexer) path(k int) []Seg {
	out := make([]Seg, k)
	for i := 0; i < k; i++ {
		f := &lx.stack[i]
		if f.node.Kind == Object {
			out[i] = Seg{Name: f.name}
		} else {
			out[i] = Seg{Index: f.index, IsIndex: true}
		}
	}
	return out
}

func isWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

func hexVal(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}

func (lx *lexer) ws() {
	for lx.p < lx.n && isWS(lx.b[lx.p]) {
		lx.p++
	}
}

// charSpan is the span of the character at q, or [n, n) at the end of the input. The input
// is well-formed UTF-8 by stage 2, and q is always at the start of a character.
func (lx *lexer) charSpan(q int) (int, int) {
	if q >= lx.n {
		return lx.n, lx.n
	}
	c := lx.b[q]
	switch {
	case c < 0x80:
		return q, q + 1
	case c < 0xe0:
		return q, q + 2
	case c < 0xf0:
		return q, q + 3
	}
	return q, q + 4
}

func (lx *lexer) describe(q int) string {
	if q >= lx.n {
		return "the end of the input"
	}
	s, e := lx.charSpan(q)
	return fmt.Sprintf("%q", lx.b[s:e])
}

func (lx *lexer) invalid(k int, q int, what string) *Fault {
	s, e := lx.charSpan(q)
	return RefuseSegs(CodeInvalidJSON, lx.path(k), s, e, fmt.Sprintf("expected %s, found %s", what, lx.describe(q)))
}

type lexState uint8

const (
	readValue lexState = iota
	afterValue
	readName
)

// run reads the whole text with an explicit stack of open arrays and objects, in the order
// of total §4.3: the byte order mark, one value, then nothing but whitespace.
func (lx *lexer) run() (*Node, *Fault) {
	b, n := lx.b, lx.n
	if n >= 3 && b[0] == 0xef && b[1] == 0xbb && b[2] == 0xbf {
		return nil, RefuseSegs(CodeByteOrderMark, []Seg{}, 0, 3, "the input begins with a byte order mark")
	}
	lx.ws()
	var done *Node
	state := readValue
	for {
		switch state {
		case readValue:
			k := len(lx.stack)
			if lx.p >= n {
				return nil, RefuseSegs(CodeInvalidJSON, lx.path(k), n, n, "expected a value, found the end of the input")
			}
			start := lx.p
			switch c := b[start]; {
			case c == '{' || c == '[':
				if k+1 > lx.maxDepth {
					return nil, &Fault{Code: CodeLimitExceeded, Kind: KindJSONDepth, Path: lx.path(k), HasSpan: true,
						Start: start, End: start + 1,
						Message: fmt.Sprintf("more than max_json_depth (%d) arrays and objects are open", lx.maxDepth)}
				}
				kind, closer := Object, byte('}')
				if c == '[' {
					kind, closer = Array, ']'
				}
				node := &Node{Kind: kind, Start: start}
				lx.p++
				lx.ws()
				if lx.p < n && b[lx.p] == closer {
					lx.p++
					node.End = lx.p
					done, state = node, afterValue
					continue
				}
				lx.stack = append(lx.stack, frame{node: node})
				if kind == Object {
					state = readName
				}
			case c == '"':
				text, f := lx.str(k)
				if f != nil {
					return nil, f
				}
				done, state = &Node{Kind: String, Start: start, End: lx.p, Text: text}, afterValue
			case c == 't' || c == 'f' || c == 'n':
				node, f := lx.literal(k)
				if f != nil {
					return nil, f
				}
				done, state = node, afterValue
			case c == '-' || isDigit(c):
				node, f := lx.number(k)
				if f != nil {
					return nil, f
				}
				done, state = node, afterValue
			default:
				return nil, lx.invalid(k, start, "a value")
			}

		case afterValue:
			k := len(lx.stack)
			if k == 0 {
				lx.ws()
				if lx.p < n {
					return nil, RefuseSegs(CodeTrailingData, []Seg{}, lx.p, n, "something other than whitespace follows the value")
				}
				return done, nil
			}
			top := &lx.stack[k-1]
			closer := byte(']')
			if top.node.Kind == Object {
				closer = '}'
				top.node.Members = append(top.node.Members, Member{Name: top.name, NameStart: top.nameStart, NameEnd: top.nameEnd, Value: done})
			} else {
				top.node.Items = append(top.node.Items, done)
			}
			lx.ws()
			if lx.p < n && b[lx.p] == ',' {
				lx.p++
				lx.ws()
				if top.node.Kind == Object {
					state = readName
				} else {
					top.index++
					state = readValue
				}
				continue
			}
			if lx.p < n && b[lx.p] == closer {
				lx.p++
				top.node.End = lx.p
				done = top.node
				lx.stack = lx.stack[:k-1]
				continue
			}
			return nil, lx.invalid(k-1, lx.p, fmt.Sprintf("',' or '%c'", closer))

		case readName:
			k := len(lx.stack)
			top := &lx.stack[k-1]
			if lx.p >= n || b[lx.p] != '"' {
				return nil, lx.invalid(k-1, lx.p, "a member name")
			}
			start := lx.p
			name, f := lx.str(k - 1)
			if f != nil {
				return nil, f
			}
			if lx.seen(top, name) {
				path := append(lx.path(k-1), Seg{Name: name})
				return nil, RefuseSegs(CodeDuplicateMember, path, start, lx.p, fmt.Sprintf("the member name %q is repeated", name))
			}
			top.name, top.nameStart, top.nameEnd = name, start, lx.p
			lx.ws()
			if lx.p >= n || b[lx.p] != ':' {
				return nil, lx.invalid(k, lx.p, "':'")
			}
			lx.p++
			lx.ws()
			state = readValue
		}
	}
}

// seen reports whether the object of f already has a member named name.
func (lx *lexer) seen(f *frame, name string) bool {
	members := f.node.Members
	if f.names == nil && len(members) < smallObject {
		for _, m := range members {
			if m.Name == name {
				return true
			}
		}
		return false
	}
	if f.names == nil {
		f.names = make(map[string]struct{}, 2*len(members))
		for _, m := range members {
			f.names[m.Name] = struct{}{}
		}
	}
	if _, ok := f.names[name]; ok {
		return true
	}
	f.names[name] = struct{}{}
	return false
}

// str reads a string from its opening quotation mark and returns its decoded content. A
// refusal inside it has the path of the first k frames.
func (lx *lexer) str(k int) (string, *Fault) {
	b, n := lx.b, lx.n
	lx.p++
	start := lx.p
	q := start
	for q < n && b[q] != '"' && b[q] != '\\' && b[q] >= 0x20 {
		q++
	}
	if q < n && b[q] == '"' {
		lx.p = q + 1
		return string(b[start:q]), nil
	}
	buf := append([]byte(nil), b[start:q]...)
	lx.p = q
	for {
		p := lx.p
		if p >= n {
			return "", RefuseSegs(CodeInvalidJSON, lx.path(k), n, n, "the string is not closed")
		}
		c := b[p]
		switch {
		case c == '"':
			lx.p++
			return string(buf), nil
		case c < 0x20:
			return "", RefuseSegs(CodeInvalidJSON, lx.path(k), p, p+1, fmt.Sprintf("the control character U+%04X is not escaped", c))
		case c == '\\':
			if p+1 >= n {
				return "", RefuseSegs(CodeInvalidJSON, lx.path(k), n, n, "the escape is not complete")
			}
			switch e := b[p+1]; e {
			case '"', '\\', '/':
				buf = append(buf, e)
			case 'b':
				buf = append(buf, '\b')
			case 'f':
				buf = append(buf, '\f')
			case 'n':
				buf = append(buf, '\n')
			case 'r':
				buf = append(buf, '\r')
			case 't':
				buf = append(buf, '\t')
			case 'u':
				cp, f := lx.hex4(p+2, k)
				if f != nil {
					return "", f
				}
				switch {
				case cp >= 0xd800 && cp <= 0xdbff:
					if lo := lx.lowSurrogate(p + 6); lo >= 0 {
						buf = utf8.AppendRune(buf, rune(0x10000+(cp-0xd800)<<10+(lo-0xdc00)))
						lx.p = p + 12
						continue
					}
					return "", RefuseSegs(CodeInvalidUnicodeEscape, lx.path(k), p, p+6,
						fmt.Sprintf("the escape \\u%04x names a high surrogate that no low surrogate escape follows", cp))
				case cp >= 0xdc00 && cp <= 0xdfff:
					return "", RefuseSegs(CodeInvalidUnicodeEscape, lx.path(k), p, p+6,
						fmt.Sprintf("the escape \\u%04x names a lone low surrogate", cp))
				}
				buf = utf8.AppendRune(buf, rune(cp))
				lx.p = p + 6
				continue
			default:
				_, end := lx.charSpan(p + 1)
				return "", RefuseSegs(CodeInvalidJSON, lx.path(k), p, end, fmt.Sprintf("%s is not an escape", b[p:end]))
			}
			lx.p = p + 2
		default:
			q := p + 1
			for q < n && b[q] != '"' && b[q] != '\\' && b[q] >= 0x20 {
				q++
			}
			buf = append(buf, b[p:q]...)
			lx.p = q
		}
	}
}

// hex4 reads the four hexadecimal digits of a \u escape at q.
func (lx *lexer) hex4(q, k int) (int, *Fault) {
	v := 0
	for i := 0; i < 4; i++ {
		if q+i >= lx.n {
			return 0, RefuseSegs(CodeInvalidJSON, lx.path(k), lx.n, lx.n, "the \\u escape is not complete")
		}
		h := hexVal(lx.b[q+i])
		if h < 0 {
			return 0, lx.invalid(k, q+i, "a hexadecimal digit")
		}
		v = v<<4 | h
	}
	return v, nil
}

// lowSurrogate returns the low surrogate that a \u escape at q names, or -1 when the six
// bytes at q are not such an escape.
func (lx *lexer) lowSurrogate(q int) int {
	if q+6 > lx.n || lx.b[q] != '\\' || lx.b[q+1] != 'u' {
		return -1
	}
	v := 0
	for i := 2; i < 6; i++ {
		h := hexVal(lx.b[q+i])
		if h < 0 {
			return -1
		}
		v = v<<4 | h
	}
	if v < 0xdc00 || v > 0xdfff {
		return -1
	}
	return v
}

func (lx *lexer) literal(k int) (*Node, *Fault) {
	start := lx.p
	word, kind := "null", Null
	switch lx.b[start] {
	case 't':
		word, kind = "true", True
	case 'f':
		word, kind = "false", False
	}
	for i := 0; i < len(word); i++ {
		if start+i >= lx.n || lx.b[start+i] != word[i] {
			return nil, lx.invalid(k, start+i, fmt.Sprintf("the literal %s", word))
		}
	}
	lx.p = start + len(word)
	return &Node{Kind: kind, Start: start, End: lx.p, Text: word}, nil
}

// number reads the longest match of RFC 8259's number at p.
func (lx *lexer) number(k int) (*Node, *Fault) {
	b, n := lx.b, lx.n
	start := lx.p
	digits := func() *Fault {
		if lx.p >= n || !isDigit(b[lx.p]) {
			return lx.invalid(k, lx.p, "a digit")
		}
		for lx.p < n && isDigit(b[lx.p]) {
			lx.p++
		}
		return nil
	}
	if b[lx.p] == '-' {
		lx.p++
	}
	if lx.p < n && b[lx.p] == '0' {
		lx.p++
	} else if f := digits(); f != nil {
		return nil, f
	}
	if lx.p < n && b[lx.p] == '.' {
		lx.p++
		if f := digits(); f != nil {
			return nil, f
		}
	}
	if lx.p < n && (b[lx.p] == 'e' || b[lx.p] == 'E') {
		lx.p++
		if lx.p < n && (b[lx.p] == '+' || b[lx.p] == '-') {
			lx.p++
		}
		if f := digits(); f != nil {
			return nil, f
		}
	}
	return &Node{Kind: Number, Start: start, End: lx.p, Text: string(b[start:lx.p])}, nil
}
