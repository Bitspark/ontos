package readable

import (
	"bytes"
	"fmt"
	"slices"
	"strings"

	"github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/data/go"
	"github.com/bitspark/ontos/projection/json/go/internal/jsontext"
)

// The JSON node kinds, by their internal names.
const (
	jObject = jsontext.Object
	jArray  = jsontext.Array
	jString = jsontext.String
	jNumber = jsontext.Number
	jTrue   = jsontext.True
	jFalse  = jsontext.False
	jNull   = jsontext.Null
)

type (
	node   = jsontext.Node
	path   = jsontext.Path
	origin = jsontext.Origin
	fault  = jsontext.Fault
)

// reader is stage 4 (spec §4): it interprets the JSON tree with an explicit stack of the
// containers whose children are being interpreted. Each node runs its own checks, then its
// limit checks (§4.9), then its children in document order, each subtree completing before
// the next begins.
type reader struct {
	l       *jsontext.Limits
	origins bool
	stack   []frame
}

// frame is a container whose children are being interpreted.
type frame interface {
	// next returns the next child to interpret, with its value depth and path, or ok
	// false when every child is done.
	next() (x *node, d int, p *path, ok bool)
	// accept takes the value of the child that next returned.
	accept(v core.Value, o *origin) *fault
	// finish builds the container's value.
	finish() (core.Value, *origin)
}

func (r *reader) run(root *node) (core.Value, *origin, *fault) {
	x, d, p := root, 0, (*path)(nil)
	for {
		v, o, fr, f := r.head(x, d, p)
		if f != nil {
			return nil, nil, f
		}
		if fr != nil {
			r.stack = append(r.stack, fr)
		}
		for {
			if v != nil {
				if len(r.stack) == 0 {
					return v, o, nil
				}
				if f := r.stack[len(r.stack)-1].accept(v, o); f != nil {
					return nil, nil, f
				}
				v, o = nil, nil
			}
			top := r.stack[len(r.stack)-1]
			var ok bool
			if x, d, p, ok = top.next(); ok {
				break
			}
			r.stack = r.stack[:len(r.stack)-1]
			v, o = top.finish()
		}
	}
}

func refuse(code string, p *path, x *node, format string, args ...any) *fault {
	return jsontext.Refuse(code, p, x.Start, x.End, fmt.Sprintf(format, args...))
}

// check runs a node's limit checks (spec §4.9), with the integer conversion between the
// digit count and the atom lengths that it yields: decode_depth, tuple_arity,
// integer_digits, then atom_bytes.
func (r *reader) check(p *path, x *node, depth, arity, digits int, atoms func() []int) *fault {
	kind := r.l.Shape(depth, arity)
	if kind == "" {
		kind = r.l.Digits(digits)
	}
	if kind == "" && atoms != nil {
		kind = r.l.Atoms(atoms()...)
	}
	if kind != "" {
		return jsontext.Limit(kind, p, x.Start, x.End, jsontext.Message(kind, r.l))
	}
	return nil
}

func atoms(lengths ...int) func() []int { return func() []int { return lengths } }

// uniform is the origin of a whole value: the node x at path p.
func (r *reader) uniform(p *path, x *node) *origin {
	if !r.origins {
		return nil
	}
	return jsontext.UniformAt(p, x)
}

// head interprets the node x at value depth d and path p: a value it completes at once, or
// a frame for its children.
func (r *reader) head(x *node, d int, p *path) (core.Value, *origin, frame, *fault) {
	switch x.Kind {
	case jNull:
		if f := r.check(p, x, d+1, 1, -1, atoms(lenNull)); f != nil {
			return nil, nil, nil, f
		}
		return core.NewTuple(labelNull), r.uniform(p, x), nil, nil
	case jTrue, jFalse:
		if f := r.check(p, x, d+1, 2, -1, atoms(lenBool, 1)); f != nil {
			return nil, nil, nil, f
		}
		return data.EncodeBool(x.Kind == jTrue), r.uniform(p, x), nil, nil
	case jString:
		if f := r.check(p, x, d+1, 2, -1, atoms(lenText, len(x.Text))); f != nil {
			return nil, nil, nil, f
		}
		return textValue(x.Text), r.uniform(p, x), nil, nil
	case jNumber:
		if strings.ContainsAny(x.Text, ".eE") {
			return nil, nil, nil, refuse(CodeInvalidNumber, p, x, "the number %s has a fraction or an exponent", x.Text)
		}
		if !isSafe(x.Text) {
			return nil, nil, nil, refuse(CodeUnsafeIntegerLiteral, p, x,
				"the integer %s lies outside ±(2⁵³ − 1); spell it {\"$ontos\":[\"int\",\"%s\"]}", x.Text, x.Text)
		}
		v, f := r.integer(p, x, d, x.Text)
		if f != nil {
			return nil, nil, nil, f
		}
		return v, r.uniform(p, x), nil, nil
	case jArray:
		if f := r.check(p, x, d+1, len(x.Items)+1, -1, atoms(lenList)); f != nil {
			return nil, nil, nil, f
		}
		fr := &listFrame{r: r, x: x, d: d, p: p, items: make([]core.Value, 1, len(x.Items)+1)}
		fr.items[0] = labelList
		if r.origins {
			fr.kids = append(make([]*origin, 0, len(x.Items)+1), jsontext.UniformAt(p, x))
		}
		return nil, nil, fr, nil
	case jObject:
		if _, ok := x.Member("$ontos"); ok {
			return r.envelope(x, d, p)
		}
		return nil, nil, r.object(x, d, p), r.checkObject(x, d, p)
	}
	panic("readable: unknown JSON node kind")
}

// integer runs the limit checks of the node x, at value depth d, that carries the integer
// text (a literal or an int tag), and converts the text between its digit count and its
// atom lengths (spec §4.9). text is canonical, or the literal -0.
func (r *reader) integer(p *path, x *node, d int, text string) (core.Value, *fault) {
	var v core.Value
	f := r.check(p, x, d+1, 2, digitCount(text), func() []int {
		var n int
		v, n = intValue(text)
		return []int{lenInt, n}
	})
	if f != nil {
		return nil, f
	}
	return v, nil
}

func (r *reader) checkObject(x *node, d int, p *path) *fault {
	n := len(x.Members)
	depth, arity := d+1, 1
	if n > 0 {
		depth, arity = d+3, max(n+1, 2)
	}
	return r.check(p, x, depth, arity, -1, func() []int {
		lens := make([]int, 0, n+2)
		lens = append(lens, lenMap)
		if n > 0 {
			lens = append(lens, lenText)
		}
		for _, m := range x.Members {
			lens = append(lens, len(m.Name))
		}
		return lens
	})
}

// entry is a map entry being collected: its key and value, the key's sort key (its codec
// encoding, or for an object the part of it after the shared prefix), and its origin.
type entry struct {
	key, value core.Value
	sortKey    []byte
	origin     *origin
}

func sortEntries(entries []entry) {
	slices.SortFunc(entries, func(a, b entry) int { return bytes.Compare(a.sortKey, b.sortKey) })
}

// mapValue builds a map from entries already sorted, with its origin.
func (r *reader) mapValue(entries []entry, p *path, x *node) (core.Value, *origin) {
	items := make([]core.Value, 1, len(entries)+1)
	items[0] = labelMap
	for _, e := range entries {
		items = append(items, core.NewTuple(e.key, e.value))
	}
	if !r.origins {
		return core.NewTuple(items...), nil
	}
	kids := make([]*origin, 1, len(entries)+1)
	kids[0] = jsontext.UniformAt(p, x)
	for _, e := range entries {
		kids = append(kids, e.origin)
	}
	return core.NewTuple(items...), &origin{Path: p, Start: x.Start, End: x.End, Kids: kids}
}

// listFrame interprets an array's elements (spec §4.2).
type listFrame struct {
	r     *reader
	x     *node
	d     int
	p     *path
	items []core.Value // the label, then the elements
	kids  []*origin
}

func (f *listFrame) next() (*node, int, *path, bool) {
	i := len(f.items) - 1
	if i >= len(f.x.Items) {
		return nil, 0, nil, false
	}
	return f.x.Items[i], f.d + 1, f.p.Index(i), true
}

func (f *listFrame) accept(v core.Value, o *origin) *fault {
	f.items = append(f.items, v)
	if f.r.origins {
		f.kids = append(f.kids, o)
	}
	return nil
}

func (f *listFrame) finish() (core.Value, *origin) {
	v := core.NewTuple(f.items...)
	if !f.r.origins {
		return v, nil
	}
	return v, &origin{Path: f.p, Start: f.x.Start, End: f.x.End, Kids: f.kids}
}

// objectFrame interprets an object's member values, then sorts its members by codec
// order (spec §4.2, §4.8).
type objectFrame struct {
	r       *reader
	x       *node
	d       int
	p       *path
	member  *path // the path of the member being interpreted
	entries []entry
}

func (r *reader) object(x *node, d int, p *path) *objectFrame {
	return &objectFrame{r: r, x: x, d: d, p: p, entries: make([]entry, 0, len(x.Members))}
}

func (f *objectFrame) next() (*node, int, *path, bool) {
	i := len(f.entries)
	if i >= len(f.x.Members) {
		return nil, 0, nil, false
	}
	m := f.x.Members[i]
	f.member = f.p.Name(m.Name)
	return m.Value, f.d + 2, f.member, true
}

func (f *objectFrame) accept(v core.Value, o *origin) *fault {
	m := f.x.Members[len(f.entries)]
	e := entry{key: textValue(m.Name), value: v, sortKey: textKey(m.Name)}
	if f.r.origins {
		// The member is the origin of its entry, the name token of the key, the value of
		// the value (spec §10.2).
		e.origin = &origin{Path: f.member, Start: m.NameStart, End: m.Value.End, Kids: []*origin{
			{Path: f.member, Start: m.NameStart, End: m.NameEnd, Uniform: true}, o,
		}}
	}
	f.entries = append(f.entries, e)
	return nil
}

func (f *objectFrame) finish() (core.Value, *origin) {
	sortEntries(f.entries)
	return f.r.mapValue(f.entries, f.p, f.x)
}

// tagArity is each tag's arity, its name included (spec §4.4).
var tagArity = map[string]int{"bytes": 2, "int": 2, "decimal": 3, "map": 2, "set": 2, "compound": 3, "raw": 2}

// envelope interprets an object with a member named $ontos (spec §4.3, §4.4).
func (r *reader) envelope(x *node, d int, p *path) (core.Value, *origin, frame, *fault) {
	fail := func(f *fault) (core.Value, *origin, frame, *fault) { return nil, nil, nil, f }
	if len(x.Members) != 1 {
		return fail(refuse(CodeInvalidEnvelope, p, x, "an object with a member named $ontos has no other member"))
	}
	y := x.Members[0].Value
	yp := p.Name("$ontos")
	if y.Kind != jArray {
		return fail(refuse(CodeInvalidEnvelope, yp, y, "the $ontos member's value is not an array"))
	}
	if len(y.Items) == 0 {
		return fail(refuse(CodeInvalidEnvelope, yp, y, "the $ontos member's array is empty"))
	}
	t := y.Items[0]
	if t.Kind != jString {
		return fail(refuse(CodeInvalidEnvelope, yp.Index(0), t, "the $ontos member's array does not start with a tag name"))
	}
	arity, ok := tagArity[t.Text]
	if !ok {
		return fail(refuse(CodeUnknownTag, yp.Index(0), t,
			"%q is not a tag; the tags are bytes, int, decimal, map, set, compound and raw", t.Text))
	}
	if len(y.Items) != arity {
		return fail(refuse(CodeInvalidTag, yp, y, "the %s tag has arity %d, its name included; this one has %d",
			t.Text, arity, len(y.Items)))
	}
	el := func(i int) (*node, *path) { return y.Items[i], yp.Index(i) }
	str := func(i int) (string, *fault) {
		n, np := el(i)
		if n.Kind != jString {
			return "", refuse(CodeInvalidTag, np, n, "element %d of the %s tag is not a string", i, t.Text)
		}
		return n.Text, nil
	}
	intText := func(i int) (string, *fault) {
		s, f := str(i)
		if f != nil {
			return "", f
		}
		if !isIntText(s) {
			n, np := el(i)
			return "", refuse(CodeInvalidInteger, np, n, "%q is not canonical integer text", s)
		}
		return s, nil
	}

	switch t.Text {
	case "bytes":
		s, f := str(1)
		if f != nil {
			return fail(f)
		}
		b, ok := decodeBase64(s)
		if !ok {
			n, np := el(1)
			return fail(refuse(CodeInvalidBase64, np, n, "%q is not canonical padded standard base64", s))
		}
		if f := r.check(p, x, d, -1, -1, atoms(len(b))); f != nil {
			return fail(f)
		}
		return core.NewAtom(b), r.uniform(p, x), nil, nil

	case "int":
		s, f := intText(1)
		if f != nil {
			return fail(f)
		}
		v, f := r.integer(p, x, d, s)
		if f != nil {
			return fail(f)
		}
		return v, r.uniform(p, x), nil, nil

	case "decimal":
		m, f := intText(1)
		if f != nil {
			return fail(f)
		}
		e, f := intText(2)
		if f != nil {
			return fail(f)
		}
		if m == "0" && e != "0" {
			n, np := el(2)
			return fail(refuse(CodeNoncanonicalDecimal, np, n, "the decimal zero has the exponent 0"))
		}
		if m != "0" && m[len(m)-1] == '0' {
			n, np := el(1)
			return fail(refuse(CodeNoncanonicalDecimal, np, n,
				"the mantissa %s ends in 0; the canonical decimal moves its trailing zeros into the exponent", m))
		}
		var v core.Value
		f = r.check(p, x, d+2, 3, max(digitCount(m), digitCount(e)), func() []int {
			mv, mn := intValue(m)
			ev, en := intValue(e)
			v = core.NewTuple(labelDecimal, mv, ev)
			return []int{lenDecimal, lenInt, mn, lenInt, en}
		})
		if f != nil {
			return fail(f)
		}
		return v, r.uniform(p, x), nil, nil

	case "map":
		arr, ap := el(1)
		if arr.Kind != jArray {
			return fail(refuse(CodeInvalidTag, ap, arr, "the map tag's payload is not an array"))
		}
		for j, en := range arr.Items {
			if en.Kind != jArray || len(en.Items) != 2 {
				return fail(refuse(CodeInvalidTag, ap.Index(j), en, "a map entry is an array of a key and a value"))
			}
		}
		n := len(arr.Items)
		arity := 1
		if n > 0 {
			arity = max(n+1, 2)
		}
		if f := r.check(p, x, d+1, arity, -1, atoms(lenMap)); f != nil {
			return fail(f)
		}
		return nil, nil, &mapFrame{r: r, x: x, arr: arr, d: d, p: p, ap: ap, seen: map[string]struct{}{}}, nil

	case "set":
		arr, ap := el(1)
		if arr.Kind != jArray {
			return fail(refuse(CodeInvalidTag, ap, arr, "the set tag's payload is not an array"))
		}
		if f := r.check(p, x, d+1, len(arr.Items)+1, -1, atoms(lenSet)); f != nil {
			return fail(f)
		}
		return nil, nil, &setFrame{r: r, x: x, arr: arr, d: d, p: p, ap: ap, seen: map[string]struct{}{}}, nil

	case "compound":
		label, f := r.label(y, yp)
		if f != nil {
			return fail(f)
		}
		args, argp := el(2)
		if args.Kind != jArray {
			return fail(refuse(CodeInvalidTag, argp, args, "the compound tag's arguments are not an array"))
		}
		if f := r.check(p, x, d+1, len(args.Items)+1, -1, atoms(len(label))); f != nil {
			return fail(f)
		}
		fr := &compoundFrame{r: r, x: x, args: args, d: d, p: p, argp: argp, items: make([]core.Value, 1, len(args.Items)+1)}
		fr.items[0] = core.NewAtom(label)
		if r.origins {
			fr.kids = append(make([]*origin, 0, len(args.Items)+1), jsontext.UniformAt(p, x))
		}
		return nil, nil, fr, nil

	case "raw":
		n, np := el(1)
		v, o, f := jsontext.Total(n, d, np, r.l, r.origins)
		if f != nil {
			return fail(f)
		}
		return v, o, nil, nil
	}
	panic("readable: unreachable tag " + t.Text)
}

// label reads a compound's label y[1] (spec §4.4, "Labels"): a string, whose UTF-8 is the
// label, or exactly ["bytes", base64].
func (r *reader) label(y *node, yp *path) ([]byte, *fault) {
	l, lp := y.Items[1], yp.Index(1)
	switch l.Kind {
	case jString:
		return []byte(l.Text), nil
	case jArray:
		if len(l.Items) != 2 {
			return nil, refuse(CodeInvalidTag, lp, l, "a label array is exactly [\"bytes\", base64]")
		}
		if l0 := l.Items[0]; l0.Kind != jString || l0.Text != "bytes" {
			return nil, refuse(CodeInvalidTag, lp.Index(0), l0, "a label array starts with \"bytes\"")
		}
		l1 := l.Items[1]
		if l1.Kind != jString {
			return nil, refuse(CodeInvalidTag, lp.Index(1), l1, "a label array's base64 is a string")
		}
		b, ok := decodeBase64(l1.Text)
		if !ok {
			return nil, refuse(CodeInvalidBase64, lp.Index(1), l1, "%q is not canonical padded standard base64", l1.Text)
		}
		return b, nil
	}
	return nil, refuse(CodeInvalidTag, lp, l, "a compound's label is a string or [\"bytes\", base64]")
}

// mapFrame interprets a map tag's entries: for each entry in source order the key, then
// the duplicate check, then the value (spec §4.4).
type mapFrame struct {
	r       *reader
	x, arr  *node
	d       int
	p, ap   *path
	j       int
	pending *entry // the entry whose key is read and whose value is not
	entries []entry
	seen    map[string]struct{}
}

func (f *mapFrame) next() (*node, int, *path, bool) {
	if f.j >= len(f.arr.Items) {
		return nil, 0, nil, false
	}
	en, ep := f.arr.Items[f.j], f.ap.Index(f.j)
	if f.pending == nil {
		return en.Items[0], f.d + 2, ep.Index(0), true
	}
	return en.Items[1], f.d + 2, ep.Index(1), true
}

func (f *mapFrame) accept(v core.Value, o *origin) *fault {
	en := f.arr.Items[f.j]
	if f.pending == nil {
		enc := jsontext.Encode(v)
		if _, dup := f.seen[string(enc)]; dup {
			return refuse(CodeDuplicateMapKey, f.ap.Index(f.j).Index(0), en.Items[0],
				"the map key equals an earlier key as a ground value")
		}
		f.seen[string(enc)] = struct{}{}
		f.pending = &entry{key: v, sortKey: enc, origin: o}
		return nil
	}
	e := *f.pending
	f.pending = nil
	e.value = v
	if f.r.origins {
		e.origin = &origin{Path: f.ap.Index(f.j), Start: en.Start, End: en.End, Kids: []*origin{e.origin, o}}
	}
	f.entries = append(f.entries, e)
	f.j++
	return nil
}

func (f *mapFrame) finish() (core.Value, *origin) {
	sortEntries(f.entries)
	return f.r.mapValue(f.entries, f.p, f.x)
}

// setFrame interprets a set tag's elements: each element, then the duplicate check
// (spec §4.4).
type setFrame struct {
	r      *reader
	x, arr *node
	d      int
	p, ap  *path
	elems  []entry
	seen   map[string]struct{}
}

func (f *setFrame) next() (*node, int, *path, bool) {
	j := len(f.elems)
	if j >= len(f.arr.Items) {
		return nil, 0, nil, false
	}
	return f.arr.Items[j], f.d + 1, f.ap.Index(j), true
}

func (f *setFrame) accept(v core.Value, o *origin) *fault {
	j := len(f.elems)
	enc := jsontext.Encode(v)
	if _, dup := f.seen[string(enc)]; dup {
		return refuse(CodeDuplicateSetElement, f.ap.Index(j), f.arr.Items[j],
			"the set element equals an earlier element as a ground value")
	}
	f.seen[string(enc)] = struct{}{}
	f.elems = append(f.elems, entry{key: v, sortKey: enc, origin: o})
	return nil
}

func (f *setFrame) finish() (core.Value, *origin) {
	sortEntries(f.elems)
	items := make([]core.Value, 1, len(f.elems)+1)
	items[0] = labelSet
	for _, e := range f.elems {
		items = append(items, e.key)
	}
	if !f.r.origins {
		return core.NewTuple(items...), nil
	}
	kids := make([]*origin, 1, len(f.elems)+1)
	kids[0] = jsontext.UniformAt(f.p, f.x)
	for _, e := range f.elems {
		kids = append(kids, e.origin)
	}
	return core.NewTuple(items...), &origin{Path: f.p, Start: f.x.Start, End: f.x.End, Kids: kids}
}

// compoundFrame interprets a compound tag's arguments, in order (spec §4.4).
type compoundFrame struct {
	r       *reader
	x, args *node
	d       int
	p, argp *path
	items   []core.Value // the label, then the arguments
	kids    []*origin
}

func (f *compoundFrame) next() (*node, int, *path, bool) {
	i := len(f.items) - 1
	if i >= len(f.args.Items) {
		return nil, 0, nil, false
	}
	return f.args.Items[i], f.d + 1, f.argp.Index(i), true
}

func (f *compoundFrame) accept(v core.Value, o *origin) *fault {
	f.items = append(f.items, v)
	if f.r.origins {
		f.kids = append(f.kids, o)
	}
	return nil
}

func (f *compoundFrame) finish() (core.Value, *origin) {
	v := core.NewTuple(f.items...)
	if !f.r.origins {
		return v, nil
	}
	return v, &origin{Path: f.p, Start: f.x.Start, End: f.x.End, Kids: f.kids}
}
