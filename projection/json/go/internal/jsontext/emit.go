package jsontext

import (
	"encoding/hex"

	"github.com/bitspark/ontos/core/go"
)

// Emitter writes JSON text under the limits, as the reader's mirror (total §9.3): a node's
// contribution is checked before its first byte (by the caller, with Check), then an
// opening bracket's depth (Open), then each byte's count (Open, Close, Write).
type Emitter struct {
	L     *Limits
	Out   []byte
	depth int
}

// Check reports a node's contribution check that failed, as a writer refusal at path.
func (e *Emitter) Check(kind string, path *Path) *Fault {
	if kind == "" {
		return nil
	}
	return WriteLimit(kind, path, Message(kind, e.L))
}

// Reserve refuses when n more bytes would pass max_text_bytes.
func (e *Emitter) Reserve(n int, path *Path) *Fault {
	if n > e.L.TextBytes-len(e.Out) {
		return WriteLimit(KindTextBytes, path, Message(KindTextBytes, e.L))
	}
	return nil
}

// Write emits s.
func (e *Emitter) Write(s string, path *Path) *Fault {
	if f := e.Reserve(len(s), path); f != nil {
		return f
	}
	e.Out = append(e.Out, s...)
	return nil
}

// Open emits an opening bracket, after checking the JSON depth it reaches.
func (e *Emitter) Open(c byte, path *Path) *Fault {
	if e.depth+1 > e.L.JSONDepth {
		return WriteLimit(KindJSONDepth, path, Message(KindJSONDepth, e.L))
	}
	if f := e.Reserve(1, path); f != nil {
		return f
	}
	e.depth++
	e.Out = append(e.Out, c)
	return nil
}

// Close emits a closing bracket.
func (e *Emitter) Close(c byte, path *Path) *Fault {
	if f := e.Reserve(1, path); f != nil {
		return f
	}
	e.depth--
	e.Out = append(e.Out, c)
	return nil
}

// writeFrame is a tuple whose children are being written.
type writeFrame struct {
	t    core.Tuple
	next int
	d    int
	path *Path // the tuple-object's path in the output
}

// WriteTotal writes v at value depth d as its total-form spelling (total §2, §5), with an
// explicit stack. path is the path of v's object in the output, which a refusal reports.
func WriteTotal(e *Emitter, v core.Value, d int, path *Path) *Fault {
	var stack []writeFrame
	for {
		switch x := v.(type) {
		case core.Atom:
			if f := e.Check(e.L.Shape(d, -1), path); f != nil {
				return f
			}
			if f := e.Check(e.L.Atoms(x.Len()), path); f != nil {
				return f
			}
			if f := e.Open('{', path); f != nil {
				return f
			}
			b := x.Bytes()
			if f := e.Reserve(len(`"atom":""`)+2*len(b), path.Name("atom")); f != nil {
				return f
			}
			e.Out = append(e.Out, `"atom":"`...)
			e.Out = hex.AppendEncode(e.Out, b)
			e.Out = append(e.Out, '"')
			if f := e.Close('}', path); f != nil {
				return f
			}
		case core.Tuple:
			if f := e.Check(e.L.Shape(d, x.Len()), path); f != nil {
				return f
			}
			if f := e.Open('{', path); f != nil {
				return f
			}
			if f := e.Write(`"tuple":`, path); f != nil {
				return f
			}
			if f := e.Open('[', path.Name("tuple")); f != nil {
				return f
			}
			stack = append(stack, writeFrame{t: x, d: d, path: path})
		}
		v = nil
		for len(stack) > 0 {
			top := &stack[len(stack)-1]
			if top.next < top.t.Len() {
				if top.next > 0 {
					if f := e.Write(",", top.path.Name("tuple")); f != nil {
						return f
					}
				}
				v, d, path = top.t.At(top.next), top.d+1, top.path.Name("tuple").Index(top.next)
				top.next++
				break
			}
			if f := e.Close(']', top.path.Name("tuple")); f != nil {
				return f
			}
			if f := e.Close('}', top.path); f != nil {
				return f
			}
			stack = stack[:len(stack)-1]
		}
		if v == nil {
			return nil
		}
	}
}
