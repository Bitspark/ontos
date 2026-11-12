package readable

import (
	"bytes"
	"encoding/base64"
	"math/big"
	"unicode/utf8"

	"github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/data/go"
	"github.com/bitspark/ontos/projection/json/go/internal/jsontext"
)

// writer emits a value's preferred spelling (spec §2, §5) with an explicit stack of what
// remains to be written. A value is recognized when it is reached: its contribution is
// checked (spec §9, the mirror of §4.9), its first bytes are written, and the rest of its
// spelling (its children, separators and closing brackets) is pushed in reverse.
type writer struct {
	e     jsontext.Emitter
	stack []work
}

type op uint8

const (
	opValue op = iota // write v at value depth d
	opText            // write text
	opOpen            // write the opening bracket c, checking the depth it reaches
	opClose           // write the closing bracket c
)

type work struct {
	op   op
	v    core.Value
	d    int
	p    *path // the output path of the node the work belongs to
	text string
	c    byte
}

func (w *writer) run(v core.Value) *fault {
	w.stack = append(w.stack, work{op: opValue, v: v})
	for len(w.stack) > 0 {
		it := w.stack[len(w.stack)-1]
		w.stack = w.stack[:len(w.stack)-1]
		var f *fault
		switch it.op {
		case opValue:
			f = w.value(it.v, it.d, it.p)
		case opText:
			f = w.e.Write(it.text, it.p)
		case opOpen:
			f = w.e.Open(it.c, it.p)
		case opClose:
			f = w.e.Close(it.c, it.p)
		}
		if f != nil {
			return f
		}
	}
	return nil
}

func (w *writer) push(items ...work) { w.stack = append(w.stack, items...) }

func text(s string, p *path) work  { return work{op: opText, text: s, p: p} }
func open(c byte, p *path) work    { return work{op: opOpen, c: c, p: p} }
func closing(c byte, p *path) work { return work{op: opClose, c: c, p: p} }
func value(v core.Value, d int, p *path) work {
	return work{op: opValue, v: v, d: d, p: p}
}

// check is the writer's limit check of a node's contribution, in the reader's order
// (spec §4.9): decode_depth, tuple_arity, integer_digits, atom_bytes.
func (w *writer) check(p *path, depth, arity int, digitsOver bool, atoms ...int) *fault {
	kind := w.e.L.Shape(depth, arity)
	if kind == "" && digitsOver {
		kind = jsontext.KindIntegerDigits
	}
	if kind == "" {
		kind = w.e.L.Atoms(atoms...)
	}
	return w.e.Check(kind, p)
}

// sequence pushes, in reverse, the children of a container whose opening is written:
// child i at path at(i), separated by commas, then the closing work.
func (w *writer) sequence(children []core.Value, d int, at func(int) *path, separator *path, end ...work) {
	w.push(end...)
	for i := len(children) - 1; i >= 0; i-- {
		w.push(value(children[i], d, at(i)))
		if i > 0 {
			w.push(text(",", separator))
		}
	}
}

// openEnvelope writes {"$ontos":["tag", for the envelope at p.
func (w *writer) openEnvelope(tag string, p *path) *fault {
	if f := w.e.Open('{', p); f != nil {
		return f
	}
	if f := w.e.Write(`"$ontos":`, p); f != nil {
		return f
	}
	if f := w.e.Open('[', p.Name("$ontos")); f != nil {
		return f
	}
	return w.e.Write(`"`+tag+`",`, p.Name("$ontos"))
}

// closeEnvelope is the work that writes ]} for the envelope at p.
func closeEnvelope(p *path) []work {
	return []work{closing('}', p), closing(']', p.Name("$ontos"))}
}

// value recognizes v (spec §2.3) and starts its spelling.
func (w *writer) value(v core.Value, d int, p *path) *fault {
	t, ok := v.(core.Tuple)
	if !ok {
		a := v.(core.Atom)
		if f := w.check(p, d, -1, false, a.Len()); f != nil {
			return f
		}
		if f := w.openEnvelope("bytes", p); f != nil {
			return f
		}
		if f := w.e.Write(`"`+base64.StdEncoding.EncodeToString(a.Bytes())+`"`, p.Name("$ontos").Index(1)); f != nil {
			return f
		}
		w.push(closeEnvelope(p)...)
		return nil
	}
	label, labeled := labelOf(t)
	if labeled {
		if done, f := w.embedding(t, string(label), d, p); done || f != nil {
			return f
		}
		return w.compound(t, label, d, p)
	}
	// Tuple(), or a tuple whose first child is a tuple: the raw tag, around the total form.
	if f := w.openEnvelope("raw", p); f != nil {
		return f
	}
	if f := jsontext.WriteTotal(&w.e, t, d, p.Name("$ontos").Index(1)); f != nil {
		return f
	}
	w.push(closeEnvelope(p)...)
	return nil
}

func labelOf(t core.Tuple) ([]byte, bool) {
	if t.Len() == 0 {
		return nil, false
	}
	a, ok := t.At(0).(core.Atom)
	if !ok {
		return nil, false
	}
	return a.Bytes(), true
}

// embedding writes t when it is one of the eight ontos/data kinds in its canonical form
// (spec §2.3, step 1), and reports whether it was.
func (w *writer) embedding(t core.Tuple, label string, d int, p *path) (bool, *fault) {
	switch label {
	case "null":
		if t.Len() != 1 {
			return false, nil
		}
		if f := w.check(p, d+1, 1, false, lenNull); f != nil {
			return true, f
		}
		return true, w.e.Write("null", p)

	case "bool":
		b, err := data.ReadBool(t)
		if err != nil {
			return false, nil
		}
		if f := w.check(p, d+1, 2, false, lenBool, 1); f != nil {
			return true, f
		}
		if b {
			return true, w.e.Write("true", p)
		}
		return true, w.e.Write("false", p)

	case "utf8-text":
		s, err := data.ReadText(t)
		if err != nil {
			return false, nil
		}
		if f := w.check(p, d+1, 2, false, lenText, len(s)); f != nil {
			return true, f
		}
		return true, w.e.Write(quote(s), p)

	case "int":
		n, err := data.ReadInt(t)
		if err != nil {
			return false, nil
		}
		if f := w.check(p, d+1, 2, digitsOver(n, w.e.L.IntegerDigits), lenInt, t.At(1).(core.Atom).Len()); f != nil {
			return true, f
		}
		if new(big.Int).Abs(n).Cmp(bigMaxSafe) <= 0 {
			return true, w.e.Write(n.String(), p)
		}
		if f := w.openEnvelope("int", p); f != nil {
			return true, f
		}
		if f := w.e.Write(`"`+n.String()+`"`, p.Name("$ontos").Index(1)); f != nil {
			return true, f
		}
		w.push(closeEnvelope(p)...)
		return true, nil

	case "list":
		items := t.Items()[1:]
		if f := w.check(p, d+1, t.Len(), false, lenList); f != nil {
			return true, f
		}
		if f := w.e.Open('[', p); f != nil {
			return true, f
		}
		w.sequence(items, d+1, p.Index, p, closing(']', p))
		return true, nil

	case "map":
		entries, ok := mapEntries(t)
		if !ok {
			return false, nil
		}
		return true, w.mapValue(entries, d, p)

	case "set":
		elems, ok := setElements(t)
		if !ok {
			return false, nil
		}
		if f := w.check(p, d+1, t.Len(), false, lenSet); f != nil {
			return true, f
		}
		if f := w.openEnvelope("set", p); f != nil {
			return true, f
		}
		ap := p.Name("$ontos").Index(1)
		if f := w.e.Open('[', ap); f != nil {
			return true, f
		}
		w.sequence(elems, d+1, ap.Index, ap, append(closeEnvelope(p), closing(']', ap))...)
		return true, nil

	case "decimal":
		m, e, err := data.ReadDecimal(t)
		if err != nil {
			return false, nil
		}
		over := digitsOver(m, w.e.L.IntegerDigits) || digitsOver(e, w.e.L.IntegerDigits)
		mLen := t.At(1).(core.Tuple).At(1).(core.Atom).Len()
		eLen := t.At(2).(core.Tuple).At(1).(core.Atom).Len()
		if f := w.check(p, d+2, 3, over, lenDecimal, lenInt, mLen, lenInt, eLen); f != nil {
			return true, f
		}
		if f := w.openEnvelope("decimal", p); f != nil {
			return true, f
		}
		if f := w.e.Write(`"`+m.String()+`","`+e.String()+`"`, p.Name("$ontos").Index(1)); f != nil {
			return true, f
		}
		w.push(closeEnvelope(p)...)
		return true, nil
	}
	return false, nil
}

// mapValue writes a canonical map: as an object when every key is text other than
// $ontos, else through the map tag (spec §2.1).
func (w *writer) mapValue(entries [][2]core.Value, d int, p *path) *fault {
	n := len(entries)
	arity := 1
	if n > 0 {
		arity = max(n+1, 2)
	}
	keys := make([]string, n)
	plain := true
	for i, e := range entries {
		s, err := data.ReadText(e[0])
		if err != nil || s == "$ontos" {
			plain = false
			break
		}
		keys[i] = s
	}
	if !plain {
		if f := w.check(p, d+1, arity, false, lenMap); f != nil {
			return f
		}
		if f := w.openEnvelope("map", p); f != nil {
			return f
		}
		ap := p.Name("$ontos").Index(1)
		if f := w.e.Open('[', ap); f != nil {
			return f
		}
		w.push(closeEnvelope(p)...)
		w.push(closing(']', ap))
		for j := n - 1; j >= 0; j-- {
			ep := ap.Index(j)
			w.push(closing(']', ep), value(entries[j][1], d+2, ep.Index(1)), text(",", ep), value(entries[j][0], d+2, ep.Index(0)), open('[', ep))
			if j > 0 {
				w.push(text(",", ap))
			}
		}
		return nil
	}
	depth := d + 1
	lens := make([]int, 0, n+2)
	lens = append(lens, lenMap)
	if n > 0 {
		depth = d + 3
		lens = append(lens, lenText)
		for _, k := range keys {
			lens = append(lens, len(k))
		}
	}
	if f := w.check(p, depth, arity, false, lens...); f != nil {
		return f
	}
	if f := w.e.Open('{', p); f != nil {
		return f
	}
	w.push(closing('}', p))
	for j := n - 1; j >= 0; j-- {
		mp := p.Name(keys[j])
		w.push(value(entries[j][1], d+2, mp))
		if j > 0 {
			w.push(text(","+quote(keys[j])+":", mp))
		} else {
			w.push(text(quote(keys[j])+":", mp))
		}
	}
	return nil
}

// compound writes a tuple whose first child is an atom (spec §2.3, step 3).
func (w *writer) compound(t core.Tuple, label []byte, d int, p *path) *fault {
	if f := w.check(p, d+1, t.Len(), false, len(label)); f != nil {
		return f
	}
	if f := w.openEnvelope("compound", p); f != nil {
		return f
	}
	yp := p.Name("$ontos")
	lp := yp.Index(1)
	if utf8.Valid(label) {
		if f := w.e.Write(quote(string(label)), lp); f != nil {
			return f
		}
	} else {
		if f := w.e.Open('[', lp); f != nil {
			return f
		}
		if f := w.e.Write(`"bytes","`+base64.StdEncoding.EncodeToString(label)+`"`, lp); f != nil {
			return f
		}
		if f := w.e.Close(']', lp); f != nil {
			return f
		}
	}
	if f := w.e.Write(",", yp); f != nil {
		return f
	}
	argp := yp.Index(2)
	if f := w.e.Open('[', argp); f != nil {
		return f
	}
	end := append(closeEnvelope(p), closing(']', argp))
	w.sequence(t.Items()[1:], d+1, argp.Index, argp, end...)
	return nil
}

// mapEntries recognizes a canonical map (ontos-data §5.7): the label, then entries of
// exactly two children whose keys ascend strictly in codec order.
func mapEntries(t core.Tuple) ([][2]core.Value, bool) {
	entries := make([][2]core.Value, 0, t.Len()-1)
	for i := 1; i < t.Len(); i++ {
		e, ok := t.At(i).(core.Tuple)
		if !ok || e.Len() != 2 {
			return nil, false
		}
		entries = append(entries, [2]core.Value{e.At(0), e.At(1)})
	}
	return entries, ascending(len(entries), func(i int) core.Value { return entries[i][0] })
}

// setElements recognizes a canonical set (ontos-data §5.8): the label, then elements that
// ascend strictly in codec order.
func setElements(t core.Tuple) ([]core.Value, bool) {
	elems := t.Items()[1:]
	return elems, ascending(len(elems), func(i int) core.Value { return elems[i] })
}

// ascending reports whether the n values at(0), … ascend strictly in codec order. One
// value is not encoded, so a chain of one-element sets or maps is not encoded level by
// level.
func ascending(n int, at func(int) core.Value) bool {
	if n < 2 {
		return true
	}
	prev := jsontext.Encode(at(0))
	for i := 1; i < n; i++ {
		enc := jsontext.Encode(at(i))
		if bytes.Compare(prev, enc) >= 0 {
			return false
		}
		prev = enc
	}
	return true
}

// quote writes s as a JSON string with exactly the escapes of spec §5: \" \\ \b \t \n \f
// \r, \u00xx in lowercase for the other controls, and every other character as itself.
func quote(s string) string {
	const hexDigits = "0123456789abcdef"
	b := make([]byte, 0, len(s)+2)
	b = append(b, '"')
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '"':
			b = append(b, '\\', '"')
		case '\\':
			b = append(b, '\\', '\\')
		case '\b':
			b = append(b, '\\', 'b')
		case '\t':
			b = append(b, '\\', 't')
		case '\n':
			b = append(b, '\\', 'n')
		case '\f':
			b = append(b, '\\', 'f')
		case '\r':
			b = append(b, '\\', 'r')
		default:
			if c < 0x20 {
				b = append(b, '\\', 'u', '0', '0', hexDigits[c>>4], hexDigits[c&0xf])
			} else {
				b = append(b, c)
			}
		}
	}
	return string(append(b, '"'))
}
