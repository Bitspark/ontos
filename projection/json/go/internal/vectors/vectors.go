// Package vectors loads the JSON projection conformance vectors
// (projection/json/vectors/{total,readable}.json, format in that directory's README) for
// the Go faces' tests. It resolves runs and hex, and leaves every judgement to the tests.
package vectors

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Path is the path of the vector file name (total.json or readable.json) for a test in
// projection/json/go/{total,readable}: the committed file, or the one in the directory that
// ONTOS_JSON_PROJECTION_VECTORS names, which is how scripts/check.sh fuzz replays a fresh
// generated corpus (tools/json-projection/README.md).
func Path(name string) string {
	if dir := os.Getenv("ONTOS_JSON_PROJECTION_VECTORS"); dir != "" {
		return filepath.Join(dir, name)
	}
	return filepath.Join("..", "..", "vectors", name)
}

// File is one vector file.
type File struct {
	Profile string
	Codec   string
	Cases   []Case
}

// Case is one case, with its runs expanded and its hex decoded. A field the case does not
// have is nil.
type Case struct {
	Name  string
	Group string
	// Input is the exact input bytes (input_hex), or nil for a write-only case.
	Input []byte
	// Limits are the case's overrides, by their spec names.
	Limits map[string]int
	// Value is the codec bytes of the value (value_hex).
	Value []byte
	// Output is the preferred output text.
	Output []byte
	// Refusal is the reader's refusal.
	Refusal *Refusal
	// RenderRefusal is the writer's refusal.
	RenderRefusal *RenderRefusal
	// Origins are the pinned origins, in pre-order of the value.
	Origins []Origin
}

// Refusal is a pinned reader refusal. Path holds strings (member names) and ints (indexes).
type Refusal struct {
	Code string
	Path []any
	Span [2]int
	Kind string
}

// RenderRefusal is a pinned writer refusal.
type RenderRefusal struct {
	Code string
	Kind string
}

// Origin is one pinned origin: a value path, and the JSON path and span of its source.
type Origin struct {
	ValuePath []int
	JSONPath  []any
	Span      [2]int
}

type rawCase struct {
	Name          string            `json:"name"`
	Group         string            `json:"group"`
	InputHex      json.RawMessage   `json:"input_hex"`
	Limits        map[string]int    `json:"limits"`
	ValueHex      json.RawMessage   `json:"value_hex"`
	Output        json.RawMessage   `json:"output"`
	Refusal       *rawRefusal       `json:"refusal"`
	RenderRefusal *RenderRefusal    `json:"render_refusal"`
	Origins       []json.RawMessage `json:"origins"`
}

type rawRefusal struct {
	Code string          `json:"code"`
	Path json.RawMessage `json:"path"`
	Span [2]int          `json:"span"`
	Kind string          `json:"kind"`
}

// Load reads and resolves a vector file.
func Load(path string) (*File, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var raw struct {
		Profile string    `json:"profile"`
		Codec   string    `json:"codec"`
		Cases   []rawCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	f := &File{Profile: raw.Profile, Codec: raw.Codec}
	for _, rc := range raw.Cases {
		c, err := resolve(rc)
		if err != nil {
			return nil, fmt.Errorf("case %s: %w", rc.Name, err)
		}
		f.Cases = append(f.Cases, c)
	}
	return f, nil
}

func resolve(rc rawCase) (Case, error) {
	c := Case{Name: rc.Name, Group: rc.Group, Limits: rc.Limits, RenderRefusal: rc.RenderRefusal}
	var err error
	if rc.InputHex != nil {
		if c.Input, err = hexField(rc.InputHex); err != nil {
			return c, fmt.Errorf("input_hex: %w", err)
		}
	}
	if rc.ValueHex != nil {
		if c.Value, err = hexField(rc.ValueHex); err != nil {
			return c, fmt.Errorf("value_hex: %w", err)
		}
	}
	if rc.Output != nil {
		s, err := textField(rc.Output)
		if err != nil {
			return c, fmt.Errorf("output: %w", err)
		}
		c.Output = []byte(s)
	}
	if r := rc.Refusal; r != nil {
		path, err := pathField(r.Path)
		if err != nil {
			return c, fmt.Errorf("refusal path: %w", err)
		}
		c.Refusal = &Refusal{Code: r.Code, Path: path, Span: r.Span, Kind: r.Kind}
	}
	for _, o := range rc.Origins {
		var parts []json.RawMessage
		if err := json.Unmarshal(o, &parts); err != nil || len(parts) != 3 {
			return c, fmt.Errorf("origin %s: not [value path, JSON path, span]", o)
		}
		var vp []int
		var span [2]int
		if err := json.Unmarshal(parts[0], &vp); err != nil {
			return c, err
		}
		jp, err := segments(parts[1])
		if err != nil {
			return c, err
		}
		if err := json.Unmarshal(parts[2], &span); err != nil {
			return c, err
		}
		if vp == nil {
			vp = []int{}
		}
		c.Origins = append(c.Origins, Origin{ValuePath: vp, JSONPath: jp, Span: span})
	}
	return c, nil
}

// runs is the README's {"runs": [[piece, count], …]} form.
type runs struct {
	Runs [][2]json.RawMessage `json:"runs"`
}

func isRuns(raw json.RawMessage) bool {
	return bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{"))
}

// textField resolves a text field: a string, or runs of strings.
func textField(raw json.RawMessage) (string, error) {
	if !isRuns(raw) {
		var s string
		err := json.Unmarshal(raw, &s)
		return s, err
	}
	var r runs
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", err
	}
	var b strings.Builder
	for _, run := range r.Runs {
		var piece string
		var count int
		if err := json.Unmarshal(run[0], &piece); err != nil {
			return "", err
		}
		if err := json.Unmarshal(run[1], &count); err != nil {
			return "", err
		}
		b.WriteString(strings.Repeat(piece, count))
	}
	return b.String(), nil
}

func hexField(raw json.RawMessage) ([]byte, error) {
	s, err := textField(raw)
	if err != nil {
		return nil, err
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil, err
	}
	if b == nil {
		b = []byte{}
	}
	return b, nil
}

// pathField resolves a path: an array of segments, or runs of arrays of segments.
func pathField(raw json.RawMessage) ([]any, error) {
	if !isRuns(raw) {
		return segments(raw)
	}
	var r runs
	if err := json.Unmarshal(raw, &r); err != nil {
		return nil, err
	}
	out := []any{}
	for _, run := range r.Runs {
		piece, err := segments(run[0])
		if err != nil {
			return nil, err
		}
		var count int
		if err := json.Unmarshal(run[1], &count); err != nil {
			return nil, err
		}
		for i := 0; i < count; i++ {
			out = append(out, piece...)
		}
	}
	return out, nil
}

// segments reads a JSON array of strings and integers: strings stay strings, numbers
// become ints.
func segments(raw json.RawMessage) ([]any, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var items []any
	if err := d.Decode(&items); err != nil {
		return nil, err
	}
	out := make([]any, len(items))
	for i, it := range items {
		switch x := it.(type) {
		case string:
			out[i] = x
		case json.Number:
			n, err := x.Int64()
			if err != nil {
				return nil, err
			}
			out[i] = int(n)
		default:
			return nil, fmt.Errorf("segment %v is neither a string nor an integer", it)
		}
	}
	return out, nil
}

// LimitNames are the bounds a case may override, by their spec names (spec §9).
var LimitNames = []string{
	"max_text_bytes", "max_json_depth", "max_value_depth", "max_atom_bytes", "max_tuple_arity", "max_integer_digits",
}
