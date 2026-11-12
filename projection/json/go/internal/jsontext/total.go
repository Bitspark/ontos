package jsontext

import (
	"fmt"

	"github.com/bitspark/ontos/core/go"
)

// Origin is the origin of one node of a value (readable §10.2): the JSON path and span of
// the source node that produced it. An origin tree mirrors the value. A Uniform origin is
// the origin of its whole subtree, and has no Kids.
type Origin struct {
	Path       *Path
	Start, End int
	Uniform    bool
	Kids       []*Origin
}

// UniformAt is the origin of a whole subtree: the node x at path p.
func UniformAt(p *Path, x *Node) *Origin {
	return &Origin{Path: p, Start: x.Start, End: x.End, Uniform: true}
}

// DecodeHex decodes even-length lowercase hexadecimal (total §3, hex-content).
func DecodeHex(s string) ([]byte, bool) {
	if len(s)%2 != 0 {
		return nil, false
	}
	out := make([]byte, len(s)/2)
	for i := 0; i < len(s); i += 2 {
		hi, lo := lowerHex(s[i]), lowerHex(s[i+1])
		if hi < 0 || lo < 0 {
			return nil, false
		}
		out[i/2] = byte(hi<<4 | lo)
	}
	return out, true
}

func lowerHex(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	}
	return -1
}

// totalFrame is a tuple-object whose elements are being interpreted.
type totalFrame struct {
	x, y   *Node
	d      int
	path   *Path // x's path
	ypath  *Path // y's path: path + ["tuple"]
	items  []core.Value
	origin []*Origin
}

// Total interprets the JSON node x as a total-form value at value depth d and path path
// (total §4.4), with an explicit stack. With origins set, it also returns the origin tree:
// each total-form object is the origin of the atom or tuple it spells.
func Total(x *Node, d int, path *Path, l *Limits, origins bool) (core.Value, *Origin, *Fault) {
	var stack []*totalFrame
	for {
		// Interpret x: an atom completes at once; a tuple opens a frame.
		var v core.Value
		var o *Origin
		if x.Kind != Object || len(x.Members) != 1 {
			return nil, nil, Refuse(CodeInvalidTotalForm, path, x.Start, x.End,
				"a total-form value is an object with exactly one member, atom or tuple")
		}
		m := x.Members[0]
		y := m.Value
		switch m.Name {
		case "atom":
			ypath := path.Name("atom")
			if y.Kind != String {
				return nil, nil, Refuse(CodeInvalidTotalForm, ypath, y.Start, y.End, "the atom member's value is not a string")
			}
			b, ok := DecodeHex(y.Text)
			if !ok {
				return nil, nil, Refuse(CodeInvalidHex, ypath, y.Start, y.End,
					fmt.Sprintf("%q is not even-length lowercase hexadecimal", y.Text))
			}
			kind := l.Shape(d, -1)
			if kind == "" {
				kind = l.Atoms(len(b))
			}
			if kind != "" {
				return nil, nil, Limit(kind, path, x.Start, x.End, Message(kind, l))
			}
			v = core.NewAtom(b)
			if origins {
				o = &Origin{Path: path, Start: x.Start, End: x.End}
			}
		case "tuple":
			ypath := path.Name("tuple")
			if y.Kind != Array {
				return nil, nil, Refuse(CodeInvalidTotalForm, ypath, y.Start, y.End, "the tuple member's value is not an array")
			}
			if kind := l.Shape(d, len(y.Items)); kind != "" {
				return nil, nil, Limit(kind, path, x.Start, x.End, Message(kind, l))
			}
			f := &totalFrame{x: x, y: y, d: d, path: path, ypath: ypath, items: make([]core.Value, 0, len(y.Items))}
			if origins {
				f.origin = make([]*Origin, 0, len(y.Items))
			}
			stack = append(stack, f)
		default:
			return nil, nil, Refuse(CodeInvalidTotalForm, path, x.Start, x.End,
				fmt.Sprintf("the member %q is neither atom nor tuple", m.Name))
		}

		// Hand completed values up until a frame has another element to interpret.
		for {
			if v != nil {
				if len(stack) == 0 {
					return v, o, nil
				}
				top := stack[len(stack)-1]
				top.items = append(top.items, v)
				if origins {
					top.origin = append(top.origin, o)
				}
				v, o = nil, nil
			}
			top := stack[len(stack)-1]
			if i := len(top.items); i < len(top.y.Items) {
				x, d, path = top.y.Items[i], top.d+1, top.ypath.Index(i)
				break
			}
			stack = stack[:len(stack)-1]
			v = core.NewTuple(top.items...)
			if origins {
				o = &Origin{Path: top.path, Start: top.x.Start, End: top.x.End, Kids: top.origin}
			}
		}
	}
}
