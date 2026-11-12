package vectors

import (
	"bytes"
	"fmt"
	"reflect"
	"testing"
)

// Face is what a profile's tests hand to Replay: its reader, its writer and, for the
// readable profile, its origins reader, each under a case's limit overrides.
type Face struct {
	// Profile is the profile id the file and every refusal must name.
	Profile string
	// Parse reads input: the codec bytes of the value, or the refusal.
	Parse func(input []byte, limits map[string]int) ([]byte, *Got)
	// Render writes the value whose codec bytes are value: the text, or the refusal.
	Render func(value []byte, limits map[string]int) ([]byte, *Got)
	// Origins reads input with origins, in pre-order of the value. Nil when the profile
	// has none.
	Origins func(input []byte, limits map[string]int) ([]Origin, *Got)
}

// Got is a refusal a face returned, in the vectors' terms. Span is nil for a writer.
type Got struct {
	Profile string
	Code    string
	Path    []any
	Span    *[2]int
	Kind    string
	Message string
}

func (g *Got) String() string {
	if g == nil {
		return "no refusal"
	}
	span := "no span"
	if g.Span != nil {
		span = fmt.Sprintf("[%d, %d)", g.Span[0], g.Span[1])
	}
	return fmt.Sprintf("%s %s kind=%q path=%v span=%s (%s)", g.Profile, g.Code, g.Kind, g.Path, span, g.Message)
}

// Counts are what Replay checked, by README step.
type Counts struct {
	Cases          int // cases in the file, every one of which passed
	Refusals       int // step 1: reads refused with the pinned code, path, span and kind
	Reads          int // step 2: reads to the pinned codec bytes
	Origins        int // step 2: origins as pinned
	Writes         int // step 3: writes to the pinned output
	RenderRefusals int // step 3: writes refused with the pinned code and kind
	Laws           int // step 4: output reads back to the value and writes again to itself
}

func (c Counts) String() string {
	return fmt.Sprintf("%d cases: %d refusals, %d reads, %d origins, %d writes, %d write refusals, %d law checks",
		c.Cases, c.Refusals, c.Reads, c.Origins, c.Writes, c.RenderRefusals, c.Laws)
}

// Replay checks every case of the vector file at path against face, as the README's "How a
// face replays a case" states, one subtest per case. It returns what it checked.
func Replay(t *testing.T, path string, face Face) Counts {
	t.Helper()
	file, err := Load(path)
	if err != nil {
		t.Fatalf("load %s: %v", path, err)
	}
	if file.Profile != face.Profile {
		t.Fatalf("%s pins profile %q, the face is %q", path, file.Profile, face.Profile)
	}
	if file.Codec != "ontos-codec-v1" {
		t.Fatalf("%s pins codec %q", path, file.Codec)
	}
	if len(file.Cases) == 0 {
		t.Fatalf("%s has no cases", path)
	}
	var counts Counts
	names := map[string]bool{}
	for _, c := range file.Cases {
		if names[c.Name] {
			t.Fatalf("case name %q is repeated", c.Name)
		}
		names[c.Name] = true
		var local Counts
		ok := t.Run(c.Name, func(t *testing.T) { local = replayCase(t, face, c) })
		if ok {
			counts.Cases++
			counts.Refusals += local.Refusals
			counts.Reads += local.Reads
			counts.Origins += local.Origins
			counts.Writes += local.Writes
			counts.RenderRefusals += local.RenderRefusals
			counts.Laws += local.Laws
		}
	}
	if counts.Cases != len(file.Cases) {
		t.Errorf("%d of %d cases passed", counts.Cases, len(file.Cases))
	}
	return counts
}

func replayCase(t *testing.T, face Face, c Case) Counts {
	var n Counts
	checked := false
	// 1. A refused input.
	if c.Refusal != nil {
		checked = true
		if c.Input == nil {
			t.Fatalf("a refusal without input_hex")
		}
		v, got := face.Parse(c.Input, c.Limits)
		switch {
		case got == nil:
			t.Errorf("read accepted %x, want refusal %s", v, c.Refusal.Code)
		default:
			want := &Got{Profile: face.Profile, Code: c.Refusal.Code, Path: c.Refusal.Path, Span: &c.Refusal.Span, Kind: c.Refusal.Kind}
			if !sameRefusal(got, want) {
				t.Errorf("read refused\n  got  %s\n  want %s", got, want)
			} else {
				n.Refusals++
			}
		}
	}
	// 2. An accepted input.
	if c.Input != nil && c.Value != nil {
		checked = true
		v, got := face.Parse(c.Input, c.Limits)
		if got != nil {
			t.Errorf("read refused: %s; want value %x", got, c.Value)
		} else if !bytes.Equal(v, c.Value) {
			t.Errorf("read value\n  got  %x\n  want %x", v, c.Value)
		} else {
			n.Reads++
		}
		if c.Origins != nil {
			if face.Origins == nil {
				t.Fatalf("origins pinned for a profile without them")
			}
			o, got := face.Origins(c.Input, c.Limits)
			if got != nil {
				t.Errorf("origins read refused: %s", got)
			} else if !reflect.DeepEqual(o, c.Origins) {
				t.Errorf("origins\n  got  %v\n  want %v", o, c.Origins)
			} else {
				n.Origins++
			}
		}
	}
	// 3. Writing.
	if c.Output != nil || c.RenderRefusal != nil {
		checked = true
		if c.Value == nil {
			t.Fatalf("a write without value_hex")
		}
		out, got := face.Render(c.Value, c.Limits)
		switch {
		case c.Output != nil && got != nil:
			t.Errorf("write refused: %s; want %q", got, c.Output)
		case c.Output != nil && !bytes.Equal(out, c.Output):
			t.Errorf("write\n  got  %q\n  want %q", out, c.Output)
		case c.Output != nil:
			n.Writes++
		case got == nil:
			t.Errorf("write gave %q, want refusal %s/%s", out, c.RenderRefusal.Code, c.RenderRefusal.Kind)
		case got.Profile != face.Profile || got.Code != c.RenderRefusal.Code || got.Kind != c.RenderRefusal.Kind || got.Span != nil:
			t.Errorf("write refused\n  got  %s\n  want %s/%s with no span", got, c.RenderRefusal.Code, c.RenderRefusal.Kind)
		default:
			n.RenderRefusals++
		}
	}
	// 4. The laws, for every case with output.
	if c.Output != nil {
		v, got := face.Parse(c.Output, c.Limits)
		if got != nil {
			t.Errorf("reading the output refused: %s", got)
		} else if !bytes.Equal(v, c.Value) {
			t.Errorf("reading the output\n  got  %x\n  want %x", v, c.Value)
		} else if again, got := face.Render(v, c.Limits); got != nil || !bytes.Equal(again, c.Output) {
			t.Errorf("writing the output's value again: %q, %s", again, got)
		} else {
			n.Laws++
		}
	}
	if !checked {
		t.Fatalf("the case pins nothing to check")
	}
	return n
}

func sameRefusal(got, want *Got) bool {
	return got.Profile == want.Profile && got.Code == want.Code && got.Kind == want.Kind &&
		got.Span != nil && *got.Span == *want.Span && reflect.DeepEqual(normalize(got.Path), normalize(want.Path))
}

func normalize(path []any) []any {
	if path == nil {
		return []any{}
	}
	return path
}
