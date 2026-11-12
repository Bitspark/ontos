package total_test

import (
	"bytes"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/bitspark/ontos/codec/go"
	"github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/projection/json/go/internal/gen"
	"github.com/bitspark/ontos/projection/json/go/internal/vectors"
	"github.com/bitspark/ontos/projection/json/go/total"
)

func unbounded() total.Limits {
	return total.Limits{
		MaxTextBytes: total.Unbounded, MaxJSONDepth: total.DeriveJSONDepth, MaxValueDepth: total.Unbounded,
		MaxAtomBytes: total.Unbounded, MaxTupleArity: total.Unbounded, MaxIntegerDigits: total.Unbounded,
	}
}

func refusal(t *testing.T, err error) *total.Error {
	t.Helper()
	var e *total.Error
	if !errors.As(err, &e) {
		t.Fatalf("got %v, want a *total.Error", err)
	}
	return e
}

func TestDefaultLimits(t *testing.T) {
	want := total.Limits{
		MaxTextBytes: math.MaxInt, MaxJSONDepth: total.DeriveJSONDepth, MaxValueDepth: 1024,
		MaxAtomBytes: math.MaxInt, MaxTupleArity: math.MaxInt, MaxIntegerDigits: math.MaxInt,
	}
	if got := total.DefaultLimits(); got != want {
		t.Fatalf("DefaultLimits() = %+v, want %+v", got, want)
	}
	if total.DeriveJSONDepth >= 0 {
		t.Fatalf("DeriveJSONDepth is %d; spec §10 makes it a negative constant", total.DeriveJSONDepth)
	}
}

// The derived JSON depth is 2·MaxValueDepth + 2 (spec §9.2): exactly at it a text is read,
// one past it is refused with json_depth before the value is built.
func TestDerivedJSONDepth(t *testing.T) {
	for _, v := range []int{0, 1, 5} {
		l := total.DefaultLimits()
		l.MaxValueDepth = v
		deepest := strings.Repeat(`{"tuple":[`, v) + `{"tuple":[]}` + strings.Repeat(`]}`, v)
		if _, err := total.ParseUTF8([]byte(deepest), l); err != nil {
			t.Errorf("v=%d: the deepest spelling within the bound is refused: %v", v, err)
		}
		deeper := strings.Repeat(`{"tuple":[`, v+1) + `{"atom":""}` + strings.Repeat(`]}`, v+1)
		_, err := total.ParseUTF8([]byte(deeper), l)
		if e := refusal(t, err); e.Kind != total.KindJSONDepth {
			t.Errorf("v=%d: one level deeper: got %v, want json_depth", v, e)
		}
		// An explicit, larger JSON depth moves the refusal to stage 4 (spec §9.2).
		l.MaxJSONDepth = 1000
		_, err = total.ParseUTF8([]byte(deeper), l)
		if e := refusal(t, err); e.Kind != total.KindDecodeDepth {
			t.Errorf("v=%d: with a larger explicit JSON depth: got %v, want decode_depth", v, e)
		}
	}
}

// A derived bound that int cannot hold saturates, which refuses exactly what the exact
// bound would: no text opens more brackets than it has bytes.
func TestDerivedJSONDepthSaturates(t *testing.T) {
	for _, v := range []int{math.MaxInt, math.MaxInt / 2, math.MaxInt/2 - 1} {
		l := total.DefaultLimits()
		l.MaxValueDepth = v
		text := strings.Repeat(`{"tuple":[`, 3000) + `{"tuple":[]}` + strings.Repeat(`]}`, 3000)
		if _, err := total.ParseUTF8([]byte(text), l); err != nil {
			t.Errorf("MaxValueDepth=%d: %v", v, err)
		}
	}
}

func TestInvalidLimits(t *testing.T) {
	for _, mutate := range []func(*total.Limits){
		func(l *total.Limits) { l.MaxTextBytes = -1 },
		func(l *total.Limits) { l.MaxJSONDepth = -2 },
		func(l *total.Limits) { l.MaxValueDepth = -1 },
		func(l *total.Limits) { l.MaxAtomBytes = -1 },
		func(l *total.Limits) { l.MaxTupleArity = -5 },
		func(l *total.Limits) { l.MaxIntegerDigits = -1 },
	} {
		l := total.DefaultLimits()
		mutate(&l)
		_, err := total.ParseUTF8([]byte(`{"atom":""}`), l)
		if !errors.Is(err, total.ErrInvalidLimits) {
			t.Errorf("ParseUTF8 with %+v: got %v, want ErrInvalidLimits", l, err)
		}
		var e *total.Error
		if errors.As(err, &e) {
			t.Errorf("a caller error is not a refusal: %v", err)
		}
		if _, err := total.RenderUTF8(core.NewTuple(), l); !errors.Is(err, total.ErrInvalidLimits) {
			t.Errorf("RenderUTF8 with %+v: got %v, want ErrInvalidLimits", l, err)
		}
	}
	// The zero record is a bound of zero everywhere, not the defaults: even {"atom":""}
	// opens an object.
	_, err := total.ParseUTF8([]byte(`{"atom":""}`), total.Limits{})
	if e := refusal(t, err); e.Code != total.CodeLimitExceeded {
		t.Errorf("Limits{}: got %v", e)
	}
}

// Nothing recurses on the host stack (spec §9.2): a value 200000 levels deep reads and
// writes under unbounded limits.
func TestDeepUnbounded(t *testing.T) {
	const depth = 200000
	text := []byte(strings.Repeat(`{"tuple":[`, depth) + `{"atom":"00"}` + strings.Repeat(`]}`, depth))
	v, err := total.ParseUTF8(text, unbounded())
	if err != nil {
		t.Fatal(err)
	}
	out, err := total.RenderUTF8(v, unbounded())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, text) {
		t.Fatal("the deep text does not write back as itself")
	}
}

func TestErrorFields(t *testing.T) {
	_, err := total.ParseUTF8([]byte(`{"tuple":[{"atom":"0A"}]}`), total.DefaultLimits())
	e := refusal(t, err)
	want := []total.Segment{total.Name("tuple"), total.Index(0), total.Name("atom")}
	if e.Profile != total.Profile || e.Code != total.CodeInvalidHex || e.Kind != "" ||
		e.Span == nil || *e.Span != (total.Span{Start: 18, End: 22}) || !equalPath(e.Path, want) {
		t.Fatalf("got %#v", e)
	}
	if got := e.Error(); !strings.HasPrefix(got, `ontos-total-json/1: invalid_hex at ["tuple",0,"atom"], bytes [18, 22)`) {
		t.Errorf("Error() = %q", got)
	}
	// A member named "0" and the index 0 stay distinct.
	if total.Name("0") == total.Index(0) || total.PathString([]total.Segment{total.Name("0"), total.Index(0)}) != `["0",0]` {
		t.Error("a member name and an index are not told apart")
	}
}

// A writer refusal has no span, and its path, informative, names the node being written.
func TestWriterRefusal(t *testing.T) {
	v := core.NewTuple(core.NewTuple(core.NewTuple()))
	l := total.DefaultLimits()
	l.MaxValueDepth = 1
	_, err := total.RenderUTF8(v, l)
	e := refusal(t, err)
	if e.Code != total.CodeLimitExceeded || e.Kind != total.KindDecodeDepth || e.Span != nil {
		t.Fatalf("got %#v", e)
	}
	if got := total.PathString(e.Path); got != `["tuple",0,"tuple",0]` {
		t.Errorf("path %s, want the innermost tuple's", got)
	}
	if _, err := total.RenderUTF8(nil, total.DefaultLimits()); err == nil {
		t.Error("RenderUTF8(nil) is not an error")
	}
}

// A Go string may hold any bytes; ParseUTF8([]byte(s)) refuses ill-formed ones in stage 2
// (spec §10), the generalized UTF-8 of a lone surrogate included.
func TestStringWithLoneSurrogate(t *testing.T) {
	s := "{\"atom\":\"\xed\xa0\x80\"}"
	_, err := total.ParseUTF8([]byte(s), total.DefaultLimits())
	e := refusal(t, err)
	if e.Code != total.CodeInvalidUTF8 || len(e.Path) != 0 || *e.Span != (total.Span{Start: 9, End: 10}) {
		t.Fatalf("got %v", e)
	}
}

// The laws of spec §7 over random values: R(W(v)) = v, and W(R(j)) = j on the writer's
// image.
func TestLaws(t *testing.T) {
	g := gen.New(1)
	for i := 0; i < 3000; i++ {
		v := g.Value(5)
		out, err := total.RenderUTF8(v, unbounded())
		if err != nil {
			t.Fatalf("W(%v): %v", v, err)
		}
		back, err := total.ParseUTF8(out, unbounded())
		if err != nil {
			t.Fatalf("R(%s): %v", out, err)
		}
		if !bytes.Equal(codec.Encode(back), codec.Encode(v)) {
			t.Fatalf("R(W(v)) != v for %s", out)
		}
		again, err := total.RenderUTF8(back, unbounded())
		if err != nil || !bytes.Equal(again, out) {
			t.Fatalf("W(R(j)) != j for %s: %s, %v", out, again, err)
		}
	}
}

// The writer is the reader's mirror (spec §9.3): under any limits, W writes v exactly when
// R reads W(v) under the same limits, so what is written is read back.
func TestWriterMirrorsReader(t *testing.T) {
	g := gen.New(2)
	for i := 0; i < 5000; i++ {
		v := g.Value(4)
		full, err := total.RenderUTF8(v, unbounded())
		if err != nil {
			t.Fatal(err)
		}
		l := vectors.WithLimits(total.DefaultLimits(), g.Limits(false))
		out, werr := total.RenderUTF8(v, l)
		_, rerr := total.ParseUTF8(full, l)
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

// Normalization (spec §7, law 3): for every accepted text j, N(j) = W(R(j)) is read as the
// same value, and N(N(j)) = N(j). Every refusal is well formed.
func TestNormalization(t *testing.T) {
	g := gen.New(3)
	for i := 0; i < 5000; i++ {
		j := []byte(g.TotalText(4))
		if i%2 == 1 {
			j = g.Mutate(j)
		}
		checkText(t, j, total.DefaultLimits())
	}
}

func checkText(t *testing.T, j []byte, l total.Limits) {
	t.Helper()
	v, err := total.ParseUTF8(j, l)
	if err != nil {
		e := refusal(t, err)
		if e.Profile != total.Profile || e.Span == nil || e.Span.Start < 0 || e.Span.Start > e.Span.End ||
			e.Span.End > len(j) || (e.Code == total.CodeLimitExceeded) != (e.Kind != "") {
			t.Fatalf("ill-formed refusal for %q: %#v", j, e)
		}
		return
	}
	n, err := total.RenderUTF8(v, unbounded())
	if err != nil {
		t.Fatalf("W(R(%q)): %v", j, err)
	}
	back, err := total.ParseUTF8(n, unbounded())
	if err != nil || !bytes.Equal(codec.Encode(back), codec.Encode(v)) {
		t.Fatalf("R(N(j)) != R(j) for %q: %v", j, err)
	}
	if nn, err := total.RenderUTF8(back, unbounded()); err != nil || !bytes.Equal(nn, n) {
		t.Fatalf("N(N(j)) != N(j) for %q", j)
	}
}

// FuzzRead checks, for any input, that the reader refuses well or reads a value whose
// preferred text is stable. Its seeds are every input of the vectors.
func FuzzRead(f *testing.F) {
	file, err := vectors.Load("../../vectors/total.json")
	if err != nil {
		f.Fatal(err)
	}
	for _, c := range file.Cases {
		if c.Input != nil {
			f.Add(c.Input)
		}
	}
	f.Fuzz(func(t *testing.T, j []byte) { checkText(t, j, total.DefaultLimits()) })
}

func equalPath(a, b []total.Segment) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
