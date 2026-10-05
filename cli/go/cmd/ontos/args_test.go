// Tests for the CLI's flag parsing — the surface the consumeCommonArg
// de-duplication (ontos-internal#72) must preserve byte-for-byte. The differential harness covers
// the happy paths and cross-core byte-identity; these lock the usage-error (exit 2)
// and flag-form/order edge cases per-core (the error text goes to stderr, which the
// harness does not compare, so it is pinned here rather than cross-core).
package main

import "testing"

// TestArgParsingUsageErrors pins every usage-error (exit 2) path of the shared parser
// (consumeCommonArg) and the per-command read/canon flags. Each must exit 2 — the
// parse fails before any value is resolved or decoded.
func TestArgParsingUsageErrors(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		// shared (consumeCommonArg), reached via decode:
		{"unknown_long_flag", []string{"decode", "--nope"}},
		{"unknown_short_flag", []string{"decode", "-x"}},
		{"missing_format_arg", []string{"decode", "--format"}},
		{"bad_format_value", []string{"decode", "--format", "yaml"}},
		{"bad_format_inline", []string{"decode", "--format=yaml"}},
		{"missing_from_json_arg", []string{"decode", "--from-json"}},
		{"from_json_twice", []string{"decode", "--from-json", `{"atom":""}`, "--from-json", `{"atom":""}`}},
		{"two_positionals", []string{"decode", "00", "01"}},
		// read-specific:
		{"read_neither_all_nor_kind", []string{"read", "00"}},
		{"read_both_all_and_kind", []string{"read", "--all", "--kind", "int", "00"}},
		{"read_missing_kind_arg", []string{"read", "--kind"}},
		{"read_bad_kind_value", []string{"read", "--kind", "nope", "00"}},
		{"read_unknown_flag", []string{"read", "--nope"}},
		// Order/disjointness regression guards for the consumeCommonArg de-dup (ontos-internal#72):
		// a value-taking flag still consumes a flag-shaped next token (--kind eats
		// --format -> "unknown kind"), and an inline value on a boolean flag is still
		// rejected as an unknown flag (--all=x is not the exact "--all").
		{"read_kind_consumes_flag_value", []string{"read", "--kind", "--format", "json"}},
		{"read_all_rejects_inline_value", []string{"read", "--all=x", "00"}},
		// canon-specific:
		{"canon_both_check_and_emit", []string{"canon", "--check", "--emit", "00"}},
		{"canon_unknown_flag", []string{"canon", "--nope"}},
		// top-level:
		{"no_command", []string{}},
		{"unknown_command", []string{"frobnicate"}},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			code, _, _ := runCLI(c.args, "")
			if code != 2 {
				t.Fatalf("exit=%d, want 2 (usage error)", code)
			}
		})
	}
}

// TestArgParsingFlagForms pins that the de-dup keeps every accepted flag FORM working
// — separate-token (`--format json`, `--kind int`), short (`-f`), inline
// (`--format=json`, `--kind=int`) — and that flags may appear in any order, including
// after the --from-json value. All resolve to the same `read --kind int` result.
func TestArgParsingFlagForms(t *testing.T) {
	const v = `{"tuple":[{"atom":"696e74"},{"atom":"00"}]}` // int 0, recognized as int
	const want = `{"ok":true,"command":"read","kind":"int","recognized":true}` + "\n"
	cases := [][]string{
		{"read", "--kind", "int", "--format", "json", "--from-json", v},
		{"read", "--kind=int", "--format=json", "--from-json", v},
		{"read", "-f", "json", "--kind", "int", "--from-json", v},
		{"read", "--from-json", v, "--kind", "int", "--format", "json"}, // flags after the value
	}
	for i, args := range cases {
		code, stdout, stderr := runCLI(args, "")
		if code != 0 {
			t.Fatalf("case %d: exit=%d, want 0 (stderr=%q)", i, code, stderr)
		}
		if stdout != want {
			t.Fatalf("case %d: stdout=%q, want %q", i, stdout, want)
		}
	}
}
