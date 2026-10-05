// Tests for the --from-json input source: the authoring notation
// ({"atom":"<hex>"} | {"tuple":[ … ]}) parsed directly into a Value, the inverse
// of the --format json value rendering. The marquee assertion drives THIS CLI's
// run() over every encode vector in vectors/codec.json + vectors/data.json and
// asserts `canon --emit --from-json <value>` prints exactly the pinned <hex> —
// i.e. authoring JSON → canonical bytes round-trips with the conformance
// vectors. Plus the reject (invalid_json) and mutual-exclusion (usage_error)
// cases the contract pins.
package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	data "github.com/bitspark/ontos/data/go"
)

// vectorFile is the subset of a vectors/*.json file we read: the `encode` array,
// each case carrying an authoring-JSON `value` and its canonical `hex`.
type vectorFile struct {
	Encode []vectorCase `json:"encode"`
}

type vectorCase struct {
	Name  string          `json:"name"`
	Value json.RawMessage `json:"value"`
	Hex   string          `json:"hex"`
}

// vectorsDir locates the repo's vectors/ directory relative to this test file
// (cli/go/cmd/ontos → repo root is four levels up).
func vectorsDir(t *testing.T) string {
	t.Helper()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	return filepath.Join(wd, "..", "..", "..", "..", "vectors")
}

func loadVectors(t *testing.T, name string) []vectorCase {
	t.Helper()
	path := filepath.Join(vectorsDir(t), name)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var vf vectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if len(vf.Encode) == 0 {
		t.Fatalf("%s: no encode cases", path)
	}
	return vf.Encode
}

// runCLI invokes the CLI's run() with the given args and stdin, returning the
// exit code and the captured stdout/stderr.
func runCLI(args []string, stdin string) (code int, stdout, stderr string) {
	var out, errBuf bytes.Buffer
	code = run(args, strings.NewReader(stdin), &out, &errBuf)
	return code, out.String(), errBuf.String()
}

// compactJSON re-serializes the vector's authoring `value` to a compact string
// suitable for passing as the --from-json argument. The vectors store it with
// incidental whitespace; encoding/json re-emits it compact and key-stable.
func compactJSON(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		t.Fatalf("compact value: %v", err)
	}
	return buf.String()
}

// TestFromJSONEncodeVectors is the marquee assertion: for every encode vector in
// codec.json and data.json, `canon --emit --from-json <value>` must print
// exactly the pinned <hex>. This proves the authoring notation parses to the
// same canonical bytes the conformance suite pins (the inverse of --format json).
func TestFromJSONEncodeVectors(t *testing.T) {
	for _, file := range []string{"codec.json", "data.json"} {
		cases := loadVectors(t, file)
		for _, c := range cases {
			c := c
			t.Run(file+"/"+c.Name, func(t *testing.T) {
				valueJSON := compactJSON(t, c.Value)

				// human format: bare hex line.
				code, stdout, stderr := runCLI(
					[]string{"canon", "--emit", "--from-json", valueJSON}, "")
				if code != 0 {
					t.Fatalf("exit=%d, want 0 (stderr=%q)", code, stderr)
				}
				if got := strings.TrimRight(stdout, "\n"); got != c.Hex {
					t.Fatalf("human hex = %q, want %q", got, c.Hex)
				}

				// json format: the canon --emit line carries the same hex.
				code, stdout, _ = runCLI(
					[]string{"canon", "--emit", "--format", "json", "--from-json", valueJSON}, "")
				if code != 0 {
					t.Fatalf("json exit=%d, want 0", code)
				}
				want := `{"ok":true,"command":"canon","hex":"` + c.Hex + `"}` + "\n"
				if stdout != want {
					t.Fatalf("json line = %q, want %q", stdout, want)
				}

				// And via stdin (--from-json -), to exercise the stdin path.
				code, stdout, _ = runCLI(
					[]string{"canon", "--emit", "--from-json", "-"}, valueJSON)
				if code != 0 {
					t.Fatalf("stdin exit=%d, want 0", code)
				}
				if got := strings.TrimRight(stdout, "\n"); got != c.Hex {
					t.Fatalf("stdin hex = %q, want %q", got, c.Hex)
				}
			})
		}
	}
}

// TestFromJSONRejects asserts the contract's reject cases all yield the stable
// invalid_json error on stdout (json format) with exit 2.
func TestFromJSONRejects(t *testing.T) {
	rejects := []struct {
		name string
		json string
	}{
		{"odd_length_atom", `{"atom":"0"}`},
		{"uppercase_atom", `{"atom":"AB"}`},
		{"non_hex_atom", `{"atom":"zz"}`},
		{"unknown_key", `{"foo":1}`},
		{"both_atom_and_tuple", `{"atom":"00","tuple":[]}`},
		{"neither_key", `{}`},
		{"extra_key_with_atom", `{"atom":"00","extra":1}`},
		{"non_string_atom", `{"atom":1}`},
		{"non_array_tuple", `{"tuple":"00"}`},
		{"not_an_object", `123`},
		{"bare_string", `"00"`},
		{"malformed_open_brace", `{`},
		{"trailing_data", `{"atom":"00"} x`},
		{"nested_bad_child", `{"tuple":[{"atom":"0"}]}`},
	}
	for _, r := range rejects {
		r := r
		t.Run(r.name, func(t *testing.T) {
			code, stdout, _ := runCLI(
				[]string{"canon", "--emit", "--format", "json", "--from-json", r.json}, "")
			if code != 2 {
				t.Fatalf("exit=%d, want 2", code)
			}
			want := `{"ok":false,"command":"canon","error":"invalid_json"}` + "\n"
			if stdout != want {
				t.Fatalf("stdout = %q, want %q", stdout, want)
			}
		})
	}
}

// TestFromJSONWithPositionalIsUsageError asserts --from-json together with a
// positional <hex> is a usage_error (exit 2), in any argument order. The `-` stdin
// sentinel counts as a positional too (ontos-internal#45): `-` still names a bytes source, so
// combining it with --from-json is equally ambiguous and rejected — the stricter rule
// the three cores now share (the JSON-only conformance harness is blind to `-`, so it
// is pinned here per-core).
func TestFromJSONWithPositionalIsUsageError(t *testing.T) {
	argsets := [][]string{
		{"canon", "--emit", "--format", "json", "--from-json", `{"atom":"00"}`, "0000"},
		{"canon", "--emit", "--format", "json", "0000", "--from-json", `{"atom":"00"}`},
		// `-` (the stdin sentinel) is a positional and equally conflicts, both orders.
		{"canon", "--emit", "--format", "json", "--from-json", `{"atom":"00"}`, "-"},
		{"canon", "--emit", "--format", "json", "-", "--from-json", `{"atom":"00"}`},
	}
	for i, args := range argsets {
		code, stdout, _ := runCLI(args, "")
		if code != 2 {
			t.Fatalf("argset %d: exit=%d, want 2", i, code)
		}
		want := `{"ok":false,"command":"canon","error":"usage_error"}` + "\n"
		if stdout != want {
			t.Fatalf("argset %d: stdout = %q, want %q", i, stdout, want)
		}
	}
}

// TestCLIKindsMatchDataLabels pins the CLI's own recognizedKinds list against the
// data module's exported, ordered data.Labels. The CLI keeps its own copy by design
// (it must not depend on data exporting the labels — see the note at recognizedKinds),
// but the order is part of the `recognized` JSON contract the tri-core harness pins,
// so silent drift would be a real parity bug. This makes the deliberate duplication
// safe. (Belt-and-suspenders for ontos-internal#49, which exported the labels; this is the
// CLI-side half. Do NOT reopen ontos-internal#49.)
func TestCLIKindsMatchDataLabels(t *testing.T) {
	if len(recognizedKinds) != len(data.Labels) {
		t.Fatalf("recognizedKinds has %d entries, data.Labels has %d: %v vs %v",
			len(recognizedKinds), len(data.Labels), recognizedKinds, data.Labels)
	}
	for i := range recognizedKinds {
		if recognizedKinds[i] != data.Labels[i] {
			t.Fatalf("recognizedKinds[%d] = %q, data.Labels[%d] = %q (full: %v vs %v)",
				i, recognizedKinds[i], i, data.Labels[i], recognizedKinds, data.Labels)
		}
	}
}

// TestFromJSONWorksForEveryCommand confirms --from-json is a general input
// source, not canon-only: decode/inspect/read all accept it.
func TestFromJSONWorksForEveryCommand(t *testing.T) {
	// int 0: Tuple(Atom("int"), Atom(0x00)).
	const value = `{"tuple":[{"atom":"696e74"},{"atom":"00"}]}`

	t.Run("decode", func(t *testing.T) {
		code, stdout, stderr := runCLI(
			[]string{"decode", "--format", "json", "--from-json", value}, "")
		if code != 0 {
			t.Fatalf("exit=%d, want 0 (stderr=%q)", code, stderr)
		}
		want := `{"ok":true,"command":"decode","codec":"ontos-codec-v1","value":` + value + "}\n"
		if stdout != want {
			t.Fatalf("stdout = %q, want %q", stdout, want)
		}
	})

	t.Run("inspect", func(t *testing.T) {
		code, stdout, _ := runCLI(
			[]string{"inspect", "--format", "json", "--from-json", value}, "")
		if code != 0 {
			t.Fatalf("exit=%d, want 0", code)
		}
		// Built directly → canonical by construction; int 0 recognizes as "int".
		want := `{"ok":true,"command":"inspect","codec":"ontos-codec-v1","canonical":true,"value":` +
			value + `,"recognized":["int"]}` + "\n"
		if stdout != want {
			t.Fatalf("stdout = %q, want %q", stdout, want)
		}
	})

	t.Run("read_kind_int", func(t *testing.T) {
		code, stdout, _ := runCLI(
			[]string{"read", "--kind", "int", "--format", "json", "--from-json", value}, "")
		if code != 0 {
			t.Fatalf("exit=%d, want 0", code)
		}
		want := `{"ok":true,"command":"read","kind":"int","recognized":true}` + "\n"
		if stdout != want {
			t.Fatalf("stdout = %q, want %q", stdout, want)
		}
	})

	t.Run("canon_check", func(t *testing.T) {
		// --from-json is always canonical (built, not decoded).
		code, stdout, _ := runCLI(
			[]string{"canon", "--check", "--format", "json", "--from-json", value}, "")
		if code != 0 {
			t.Fatalf("exit=%d, want 0", code)
		}
		want := `{"ok":true,"command":"canon","canonical":true}` + "\n"
		if stdout != want {
			t.Fatalf("stdout = %q, want %q", stdout, want)
		}
	})
}
