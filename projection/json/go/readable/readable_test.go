package readable_test

import (
	"bytes"
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/bitspark/ontos/codec/go"
	"github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/data/go"
	"github.com/bitspark/ontos/projection/json/go/internal/gen"
	"github.com/bitspark/ontos/projection/json/go/internal/vectors"
	"github.com/bitspark/ontos/projection/json/go/readable"
	"github.com/bitspark/ontos/projection/json/go/total"
)

func unbounded() readable.Limits {
	return readable.Limits{
		MaxTextBytes: readable.Unbounded, MaxJSONDepth: readable.DeriveJSONDepth, MaxValueDepth: readable.Unbounded,
		MaxAtomBytes: readable.Unbounded, MaxTupleArity: readable.Unbounded, MaxIntegerDigits: readable.Unbounded,
	}
}

func refusal(t *testing.T, err error) *readable.Error {
	t.Helper()
	var e *readable.Error
	if !errors.As(err, &e) {
		t.Fatalf("got %v, want a *readable.Error", err)
	}
	return e
}

func TestDefaultLimits(t *testing.T) {
	want := total.DefaultLimits()
	want.MaxIntegerDigits = 4300
	if got := readable.DefaultLimits(); got != want {
		t.Fatalf("DefaultLimits() = %+v, want %+v", got, want)
	}
	// MaxValueDepth 10 bounds the JSON depth at 34 here (spec §9, total §10).
	l := readable.DefaultLimits()
	l.MaxValueDepth = 10
	if _, err := readable.ParseUTF8([]byte(strings.Repeat("[", 34)+strings.Repeat("]", 34)), l); refusal(t, err).Kind != readable.KindDecodeDepth {
		t.Errorf("34 levels: want decode_depth after the JSON stage, got %v", err)
	}
	if _, err := readable.ParseUTF8([]byte(strings.Repeat("[", 35)+strings.Repeat("]", 35)), l); refusal(t, err).Kind != readable.KindJSONDepth {
		t.Errorf("35 levels: want json_depth, got %v", err)
	}
}

// Nothing recurses on the host stack: deep lists, sets and raw tuples read and write
// under unbounded limits.
func TestDeepUnbounded(t *testing.T) {
	for name, text := range map[string]string{
		"lists":   strings.Repeat("[", 100000) + strings.Repeat("]", 100000),
		"sets":    strings.Repeat(`{"$ontos":["set",[`, 30000) + "1" + strings.Repeat("]]}", 30000),
		"raw":     `{"$ontos":["raw",` + strings.Repeat(`{"tuple":[`, 100000) + `{"tuple":[]}` + strings.Repeat("]}", 100000) + "]}",
		"objects": strings.Repeat(`{"a":`, 100000) + "null" + strings.Repeat("}", 100000),
	} {
		v, err := readable.ParseUTF8([]byte(text), unbounded())
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		out, err := readable.RenderUTF8(v, unbounded())
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if string(out) != text {
			t.Fatalf("%s: the deep text does not write back as itself", name)
		}
	}
}

func TestOrigins(t *testing.T) {
	p, err := readable.ParseUTF8WithOrigins([]byte(`{"\u00e9":1,"a":[true]}`), readable.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		vp   []int
		path string
		span readable.Span
	}{
		{nil, `[]`, readable.Span{Start: 0, End: 23}},
		{[]int{1}, `["a"]`, readable.Span{Start: 12, End: 22}},       // the member "a", sorted first
		{[]int{1, 0, 1}, `["a"]`, readable.Span{Start: 12, End: 15}}, // its key's payload atom: the name token
		{[]int{1, 1, 1}, `["a",0]`, readable.Span{Start: 17, End: 21}},
		{[]int{1, 1, 1, 1}, `["a",0]`, readable.Span{Start: 17, End: 21}},
		{[]int{2, 0}, "[\"\u00e9\"]", readable.Span{Start: 1, End: 9}},
	} {
		o, ok := p.Origins.Lookup(c.vp...)
		if !ok || total.PathString(o.Path) != c.path || o.Span != c.span {
			t.Errorf("Lookup(%v) = %v %s %v, want %s %v", c.vp, ok, total.PathString(o.Path), o.Span, c.path, c.span)
		}
	}
	for _, vp := range [][]int{{3}, {0, 0}, {-1}, {1, 1, 1, 1, 0}} {
		if _, ok := p.Origins.Lookup(vp...); ok {
			t.Errorf("Lookup(%v) found a node the value does not have", vp)
		}
	}
	n := 0
	for vp, o := range p.Origins.All() {
		if got, ok := p.Origins.Lookup(vp...); !ok || total.PathString(got.Path) != total.PathString(o.Path) || got.Span != o.Span {
			t.Errorf("All and Lookup disagree at %v", vp)
		}
		n++
		if n == 3 {
			break // stopping early is allowed
		}
	}
	var zero readable.Origins
	if _, ok := zero.Lookup(); ok {
		t.Error("the zero Origins has a node")
	}
	for range zero.All() {
		t.Error("the zero Origins enumerates a node")
	}
}

func TestWriterRefusalPath(t *testing.T) {
	v := data.EncodeList([]core.Value{data.MustEncodeText("ok"), data.EncodeList([]core.Value{data.EncodeList(nil)})})
	l := readable.DefaultLimits()
	l.MaxValueDepth = 2
	_, err := readable.RenderUTF8(v, l)
	e := refusal(t, err)
	if e.Kind != readable.KindDecodeDepth || e.Span != nil || total.PathString(e.Path) != `[1,0]` {
		t.Fatalf("got %v", e)
	}
	// The writer refuses an integer of more digits than the bound before spelling it.
	big10 := new(big.Int).Exp(big.NewInt(10), big.NewInt(100000), nil)
	_, err = readable.RenderUTF8(data.EncodeInt(big10), readable.DefaultLimits())
	if e := refusal(t, err); e.Kind != readable.KindIntegerDigits {
		t.Fatalf("got %v", e)
	}
}

// A Go string may hold the generalized UTF-8 of a lone surrogate; stage 2 refuses it.
func TestStringWithLoneSurrogate(t *testing.T) {
	_, err := readable.ParseUTF8([]byte("[\"a\xed\xa0\x80\"]"), readable.DefaultLimits())
	e := refusal(t, err)
	if e.Profile != readable.Profile || e.Code != readable.CodeInvalidUTF8 || *e.Span != (readable.Span{Start: 3, End: 4}) {
		t.Fatalf("got %v", e)
	}
}

// The laws of spec §7 over random values: R(W(v)) = v, and W(R(j)) = j on the writer's
// image.
func TestLaws(t *testing.T) {
	g := gen.New(11)
	for i := 0; i < 5000; i++ {
		v := g.Value(5)
		out, err := readable.RenderUTF8(v, unbounded())
		if err != nil {
			t.Fatalf("W(%v): %v", v, err)
		}
		back, err := readable.ParseUTF8(out, unbounded())
		if err != nil {
			t.Fatalf("R(%s): %v (value %v)", out, err, v)
		}
		if !bytes.Equal(codec.Encode(back), codec.Encode(v)) {
			t.Fatalf("R(W(v)) != v for %s: %v", out, v)
		}
		again, err := readable.RenderUTF8(back, unbounded())
		if err != nil || !bytes.Equal(again, out) {
			t.Fatalf("W(R(j)) != j for %s: %s, %v", out, again, err)
		}
	}
}

// The writer is the reader's mirror (spec §9): under any limits, W writes v exactly when R
// reads W(v) under the same limits.
func TestWriterMirrorsReader(t *testing.T) {
	g := gen.New(12)
	for i := 0; i < 8000; i++ {
		v := g.Value(4)
		full, err := readable.RenderUTF8(v, unbounded())
		if err != nil {
			t.Fatal(err)
		}
		l := vectors.WithLimits(readable.DefaultLimits(), g.Limits(true))
		out, werr := readable.RenderUTF8(v, l)
		_, rerr := readable.ParseUTF8(full, l)
		switch {
		case werr == nil && rerr != nil:
			t.Fatalf("limits %+v: W wrote %s, R refused it: %v", l, out, rerr)
		case werr != nil && rerr == nil:
			t.Fatalf("limits %+v: W refused (%v), R reads %s", l, werr, full)
		case werr == nil && !bytes.Equal(out, full):
			t.Fatalf("limits %+v: W wrote %s, unbounded %s", l, out, full)
		}
	}
}

// Normalization (spec §7): for every accepted text j, N(j) = W(R(j)) reads as the same
// value and N(N(j)) = N(j). Every refusal is well formed.
func TestNormalization(t *testing.T) {
	g := gen.New(13)
	for i := 0; i < 8000; i++ {
		j := []byte(g.ReadableText(4))
		if i%2 == 1 {
			j = g.Mutate(j)
		}
		checkText(t, j, readable.DefaultLimits())
	}
}

func checkText(t *testing.T, j []byte, l readable.Limits) {
	t.Helper()
	v, err := readable.ParseUTF8(j, l)
	if err != nil {
		e := refusal(t, err)
		if e.Profile != readable.Profile || e.Span == nil || e.Span.Start < 0 || e.Span.Start > e.Span.End ||
			e.Span.End > len(j) || (e.Code == readable.CodeLimitExceeded) != (e.Kind != "") {
			t.Fatalf("ill-formed refusal for %q: %#v", j, e)
		}
		return
	}
	withOrigins, err := readable.ParseUTF8WithOrigins(j, l)
	if err != nil || !bytes.Equal(codec.Encode(withOrigins.Value), codec.Encode(v)) {
		t.Fatalf("the origins reader disagrees on %q: %v", j, err)
	}
	for _, o := range withOrigins.Origins.All() {
		if o.Span.Start < 0 || o.Span.Start > o.Span.End || o.Span.End > len(j) {
			t.Fatalf("origin span %v outside %q", o.Span, j)
		}
	}
	n, err := readable.RenderUTF8(v, unbounded())
	if err != nil {
		t.Fatalf("W(R(%q)): %v", j, err)
	}
	back, err := readable.ParseUTF8(n, unbounded())
	if err != nil || !bytes.Equal(codec.Encode(back), codec.Encode(v)) {
		t.Fatalf("R(N(j)) != R(j) for %q -> %q: %v", j, n, err)
	}
	if nn, err := readable.RenderUTF8(back, unbounded()); err != nil || !bytes.Equal(nn, n) {
		t.Fatalf("N(N(j)) != N(j) for %q", j)
	}
}

// FuzzRead checks, for any input, that the reader refuses well or reads a value whose
// preferred text is stable. Its seeds are every input of the vectors.
func FuzzRead(f *testing.F) {
	file, err := vectors.Load("../../vectors/readable.json")
	if err != nil {
		f.Fatal(err)
	}
	for _, c := range file.Cases {
		if c.Input != nil {
			f.Add(c.Input)
		}
	}
	f.Fuzz(func(t *testing.T, j []byte) { checkText(t, j, readable.DefaultLimits()) })
}
