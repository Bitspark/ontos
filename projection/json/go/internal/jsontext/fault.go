// Package jsontext is the module-internal half of the Go JSON projections
// (docs/spec/ontos-total-json.md and docs/spec/ontos-readable-json.md): the stages that
// both profiles share and the total form that the readable profile embeds in its raw arm.
//
//   - Stages 1 to 3 of total §4.1: the size bound, well-formed UTF-8 (§4.2) and the strict
//     JSON reading (§4.3), which yields a JSON tree whose nodes carry their spans.
//   - The interpretation of a JSON node as a total-form value (total §4.4), which the total
//     profile runs at the root and the readable profile runs inside raw.
//   - The writer's emitter, which checks the bounds as the reader's mirror (total §9.3), and
//     the total-form writer (total §5).
//
// Nothing here recurses on the host stack: the lexer, the interpreter, the writer and the
// codec encoder keep explicit stacks, because no depth bound is required (total §9.2).
//
// The public types (Limits, Error, Segment, Span) live in the total package, which the
// readable package re-exports. This package speaks in its own Fault and Seg, which those
// packages convert, so that nothing here depends on either of them.
package jsontext

// Codes shared by both profiles (total §8.4).
const (
	CodeLimitExceeded        = "limit_exceeded"
	CodeInvalidUTF8          = "invalid_utf8"
	CodeByteOrderMark        = "byte_order_mark"
	CodeInvalidJSON          = "invalid_json"
	CodeInvalidUnicodeEscape = "invalid_unicode_escape"
	CodeDuplicateMember      = "duplicate_member"
	CodeTrailingData         = "trailing_data"
	CodeInvalidTotalForm     = "invalid_total_form"
	CodeInvalidHex           = "invalid_hex"
)

// Limit kinds (total §9.1, readable §9). The three value-side kinds are the codec's.
const (
	KindTextBytes     = "text_bytes"
	KindJSONDepth     = "json_depth"
	KindDecodeDepth   = "decode_depth"
	KindAtomBytes     = "atom_bytes"
	KindTupleArity    = "tuple_arity"
	KindIntegerDigits = "integer_digits"
)

// Seg is one step of a path: a member name, or an array index when IsIndex is set. Its
// layout is total.Segment's, so the two convert into each other directly.
type Seg struct {
	Name    string
	Index   int
	IsIndex bool
}

// Path is a persistent path: each node adds one segment to the path it extends, so the
// paths of siblings share their prefix. The nil *Path is the empty path, the root.
type Path struct {
	up  *Path
	seg Seg
	len int
}

// Name extends p by the member name s.
func (p *Path) Name(s string) *Path { return &Path{up: p, seg: Seg{Name: s}, len: p.Len() + 1} }

// Index extends p by the array index i.
func (p *Path) Index(i int) *Path {
	return &Path{up: p, seg: Seg{Index: i, IsIndex: true}, len: p.Len() + 1}
}

// Len is the number of segments in p.
func (p *Path) Len() int {
	if p == nil {
		return 0
	}
	return p.len
}

// Segments returns p's segments from the root, as a fresh slice (never nil).
func (p *Path) Segments() []Seg {
	out := make([]Seg, p.Len())
	for q := p; q != nil; q = q.up {
		out[q.len-1] = q.seg
	}
	return out
}

// Fault is one refusal, before a profile names it: its code, its path, its span when it
// has one (a writer's refusal has none), and its kind for limit_exceeded.
type Fault struct {
	Code    string
	Path    []Seg
	HasSpan bool
	Start   int
	End     int
	Kind    string
	Message string
}

// Refuse builds a reader's refusal with a span.
func Refuse(code string, path *Path, start, end int, message string) *Fault {
	return &Fault{Code: code, Path: path.Segments(), HasSpan: true, Start: start, End: end, Message: message}
}

// RefuseSegs is Refuse for a path already flattened to segments.
func RefuseSegs(code string, path []Seg, start, end int, message string) *Fault {
	return &Fault{Code: code, Path: path, HasSpan: true, Start: start, End: end, Message: message}
}

// Limit builds a reader's limit_exceeded refusal with a span.
func Limit(kind string, path *Path, start, end int, message string) *Fault {
	f := Refuse(CodeLimitExceeded, path, start, end, message)
	f.Kind = kind
	return f
}

// WriteLimit builds a writer's limit_exceeded refusal: no span, and an informative path.
func WriteLimit(kind string, path *Path, message string) *Fault {
	return &Fault{Code: CodeLimitExceeded, Path: path.Segments(), Kind: kind, Message: message}
}
