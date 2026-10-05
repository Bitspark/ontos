// Command ontos is the byte-first inspector for ontos values: bytes in, evidence
// out. It is one of three peer implementations (go · rs · ts) of the v1 CLI
// contract in docs/spec/ontos-cli.md; all three emit byte-identical machine
// output for identical input (the differential-harness protocol).
//
// It implements the four v1 commands — `decode`, `inspect`, `read`, and `canon` —
// over the full argument / --format / dispatch surface, plus `--from-json`
// authoring input (scaffolded in ontos-internal#18; commands in ontos-internal#19–ontos-internal#21; `--from-json` in ontos-internal#17).
//
//	ontos <command> [--format human|json] [--from-json <json|->] [<hex>]
//
// Input is canonical ontos-codec-v1 bytes as a positional hex string, or read
// from stdin when the argument is "-" or omitted (surrounding whitespace
// stripped). Alternatively --from-json supplies the value as the authoring
// notation ({"atom":"<hex>"} | {"tuple":[ … ]}) — the inverse of the json value
// rendering — built directly into a Value (canonical by construction); it is
// mutually exclusive with a positional <hex>. json output is compact, keys in
// contract order, hex lowercase, one object per line ending in "\n", carrying
// only the stable fields — no free-text message. Human-readable diagnostics go
// to stderr.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	codec "github.com/bitspark/ontos/codec/go"
	core "github.com/bitspark/ontos/core/go"
	data "github.com/bitspark/ontos/data/go"
)

// codecID is the codec version this tool reads; it is carried verbatim in the
// json `codec` field.
const codecID = "ontos-codec-v1"

const usage = `ontos — byte-first inspector for ontos values

usage:
  ontos <command> [--format human|json] [--from-json <json|->] [<hex>]

commands:
  decode    decode ontos-codec-v1 bytes to the L0 value tree
  inspect   decode + report codec id, canonical?, value, recognized embeddings
  read      recognize registered embeddings (--all | --kind <k>)
  canon     report (--check) or emit (--emit) the canonical bytes

options:
  -f, --format human|json   output format (default human)
      --from-json <json|->  supply the value as authoring notation
                            ({"atom":"<hex>"} | {"tuple":[ … ]}) instead of hex;
                            "-" reads the json from stdin (excludes <hex>)
  -h, --help                print this help and exit
  -V, --version             print the version and exit

read options:
      --all                 try every embedding and report the matches
      --kind int|utf8-text|bool|list|map|set|decimal
                            test recognition of one embedding

canon options:
      --check               report whether the input is canonical (default)
      --emit                print the canonical bytes as hex

input is hex; if <hex> is "-" or omitted it is read from stdin.
with --from-json the value is parsed from authoring json instead of hex.`

func main() { os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr)) }

// run is main's testable core: it returns the process exit code instead of
// calling os.Exit, and takes its streams as parameters.
func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	// --help / --version are recognized before anything else, in any position.
	for _, a := range args {
		switch a {
		case "-h", "--help":
			fmt.Fprintln(stdout, usage)
			return 0
		case "-V", "--version":
			fmt.Fprintln(stdout, "ontos 0.1.0")
			return 0
		}
	}

	if len(args) == 0 {
		fmt.Fprintln(stderr, "ontos: missing command")
		fmt.Fprintln(stderr, usage)
		return 2
	}

	command := args[0]

	// read and canon carry their own flags; route them to dedicated handlers
	// before the shared --format/positional parse.
	switch command {
	case "read":
		return read(args[1:], stdin, stdout, stderr)
	case "canon":
		return canon(args[1:], stdin, stdout, stderr)
	}

	format, src, err := parseArgs(args[1:])
	if err != nil {
		fmt.Fprintln(stderr, "ontos: "+err.Error())
		fmt.Fprintln(stderr, usage)
		return 2
	}

	switch command {
	case "decode":
		return decode(format, src, stdin, stdout, stderr)
	case "inspect":
		return inspect(format, src, stdin, stdout, stderr)
	default:
		fmt.Fprintf(stderr, "ontos: unknown command %q\n", command)
		fmt.Fprintln(stderr, usage)
		return 2
	}
}

// outputFormat is the rendering mode selected by --format.
type outputFormat int

const (
	formatHuman outputFormat = iota
	formatJSON
)

// valueSource names the single source the command's Value is obtained from: the
// positional hex argument (or stdin, when nil or "-") OR the --from-json
// authoring notation. They are mutually exclusive; both set is a usage_error.
// All four commands resolve their Value through resolveValue.
type valueSource struct {
	// positional is the at-most-one positional hex argument; nil means
	// "fall back to stdin". A "-" value also means stdin.
	positional *string
	// fromJSON is the --from-json argument when given: authoring JSON, or "-"
	// to read the JSON from stdin. nil means --from-json was not given.
	fromJSON *string
}

// consumeCommonArg handles the arguments shared by every command — --format/-f and
// --from-json (each with a separate-token or "name=value" value), the at-most-one
// positional hex (or the "-" stdin sentinel), and rejection of any other flag. It
// advances *i past a consumed value argument. Each command's parser delegates here
// after trying its OWN flags, so this shared surface lives in exactly one place.
// Mutual exclusion between --from-json and a positional is enforced later by
// resolveValue, so argument order does not matter.
func consumeCommonArg(args []string, i *int, format *outputFormat, src *valueSource) error {
	arg := args[*i]
	switch {
	case arg == "-f" || arg == "--format":
		*i++
		if *i >= len(args) {
			return errors.New("--format requires an argument (human|json)")
		}
		f, err := parseFormat(args[*i])
		if err != nil {
			return err
		}
		*format = f
	case strings.HasPrefix(arg, "--format="):
		f, err := parseFormat(strings.TrimPrefix(arg, "--format="))
		if err != nil {
			return err
		}
		*format = f
	case arg == "--from-json":
		*i++
		if *i >= len(args) {
			return errFromJSONArg
		}
		return setFromJSON(src, args[*i])
	case strings.HasPrefix(arg, "--from-json="):
		return setFromJSON(src, strings.TrimPrefix(arg, "--from-json="))
	case arg != "-" && strings.HasPrefix(arg, "--"):
		return fmt.Errorf("unknown flag %q", arg)
	case arg != "-" && len(arg) > 1 && strings.HasPrefix(arg, "-"):
		// A leading-dash token that is neither "-" (stdin) nor a known flag.
		return fmt.Errorf("unknown flag %q", arg)
	default:
		// "-" (stdin sentinel) or a bare hex string is the positional.
		return setPositional(src, arg)
	}
	return nil
}

// parseArgs walks the post-command arguments for the commands that have no flags of
// their own (decode, inspect): every argument is a shared one. An unset positional is
// reported as nil so the caller falls back to stdin.
func parseArgs(args []string) (outputFormat, valueSource, error) {
	format := formatHuman
	var src valueSource
	for i := 0; i < len(args); i++ {
		if err := consumeCommonArg(args, &i, &format, &src); err != nil {
			return format, src, err
		}
	}
	return format, src, nil
}

// errFromJSONArg is the missing-argument error for --from-json, shared by all
// three argument parsers.
var errFromJSONArg = errors.New("--from-json requires an argument (json|-)")

// setFromJSON records the --from-json argument, rejecting a second --from-json.
// Mutual exclusion with a positional <hex> is enforced later by resolveValue so
// argument order does not matter.
func setFromJSON(src *valueSource, v string) error {
	if src.fromJSON != nil {
		return errors.New("--from-json given more than once")
	}
	s := v
	src.fromJSON = &s
	return nil
}

// setPositional records the at-most-one positional hex argument, rejecting a
// second positional.
func setPositional(src *valueSource, v string) error {
	if src.positional != nil {
		return errors.New("more than one input argument")
	}
	s := v
	src.positional = &s
	return nil
}

// parseReadArgs parses the post-command arguments for `read`: --format/-f, the
// at-most-one positional hex (or --from-json), and exactly one of --all /
// --kind <kind>. Missing both, giving both, or an unknown --kind value is a
// usage error.
func parseReadArgs(args []string) (format outputFormat, src valueSource, all bool, kind string, err error) {
	format = formatHuman
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--all":
			all = true
		case arg == "--kind":
			i++
			if i >= len(args) {
				return format, src, false, "", errors.New("--kind requires an argument (int|utf8-text|bool|list|map|set|decimal|null)")
			}
			k, e := parseKind(args[i])
			if e != nil {
				return format, src, false, "", e
			}
			kind = k
		case strings.HasPrefix(arg, "--kind="):
			k, e := parseKind(strings.TrimPrefix(arg, "--kind="))
			if e != nil {
				return format, src, false, "", e
			}
			kind = k
		default:
			// --format/-f, --from-json, the positional, and unknown-flag rejection.
			if e := consumeCommonArg(args, &i, &format, &src); e != nil {
				return format, src, false, "", e
			}
		}
	}
	if all && kind != "" {
		return format, src, false, "", errors.New("read takes --all or --kind, not both")
	}
	if !all && kind == "" {
		return format, src, false, "", errors.New("read requires --all or --kind <kind>")
	}
	return format, src, all, kind, nil
}

// parseKind validates a --kind value against the registered embedding labels.
func parseKind(s string) (string, error) {
	for _, k := range recognizedKinds {
		if s == k {
			return s, nil
		}
	}
	return "", fmt.Errorf("unknown kind %q (want int|utf8-text|bool|list|map|set|decimal|null)", s)
}

// parseCanonArgs parses the post-command arguments for `canon`: --format/-f, the
// at-most-one positional hex (or --from-json), and at most one of --check /
// --emit (neither defaults to --check). Giving both is a usage error.
func parseCanonArgs(args []string) (format outputFormat, src valueSource, emitMode bool, err error) {
	format = formatHuman
	check := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--check":
			check = true
		case arg == "--emit":
			emitMode = true
		default:
			// --format/-f, --from-json, the positional, and unknown-flag rejection.
			if e := consumeCommonArg(args, &i, &format, &src); e != nil {
				return format, src, false, e
			}
		}
	}
	if check && emitMode {
		return format, src, false, errors.New("canon takes --check or --emit, not both")
	}
	return format, src, emitMode, nil
}

func parseFormat(s string) (outputFormat, error) {
	switch s {
	case "human":
		return formatHuman, nil
	case "json":
		return formatJSON, nil
	default:
		return formatHuman, fmt.Errorf("unknown format %q (want human|json)", s)
	}
}

// readInput reads the textual input (hex or, for --from-json, JSON): the given
// argument when present and not "-", otherwise the whole of stdin. Surrounding
// whitespace is stripped either way.
func readInput(arg *string, stdin io.Reader) (string, error) {
	if arg != nil && *arg != "-" {
		return strings.TrimSpace(*arg), nil
	}
	raw, err := io.ReadAll(stdin)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(raw)), nil
}

// decode implements `ontos decode`: obtain the value (hex or --from-json) and
// render it.
func decode(format outputFormat, src valueSource, stdin io.Reader, stdout, stderr io.Writer) int {
	value, _, exit := resolveValue(src, stdin, "decode", format, stdout, stderr)
	if value == nil {
		return exit
	}

	if format == formatJSON {
		emit(stdout, decodeResult{OK: true, Command: "decode", Codec: codecID, Value: authoring{value}})
	} else {
		fmt.Fprintln(stdout, value.String())
	}
	return 0
}

// decodeErrorCode extracts the codec's stable error code, falling back to a
// generic code only if the error is somehow not a *codec.DecodeError.
func decodeErrorCode(err error) string {
	var de *codec.DecodeError
	if errors.As(err, &de) {
		return de.Code
	}
	return "decode_error"
}

// recognizedKinds is the fixed-order list of embedding labels inspect and
// `read --all` report. A value matches AT MOST one label (by its label); the
// order is fixed regardless of which match.
var recognizedKinds = []string{
	labelInt, labelText, labelBool, labelList, labelMap, labelSet, labelDecimal, labelNull,
}

// Embedding labels (mirrors data's registered labels; kept here so the CLI does
// not depend on those being exported).
const (
	labelInt     = "int"
	labelText    = "utf8-text"
	labelBool    = "bool"
	labelList    = "list"
	labelMap     = "map"
	labelSet     = "set"
	labelDecimal = "decimal"
	labelNull    = "null"
)

// recognizes reports whether v is a well-formed canonical embedding of kind,
// running the matching data recognizer (success == nil error). `int` uses the
// structural data.RecognizeInt (NOT data.ReadInt): a canonical int beyond a binding's
// host integer width is still recognized — the materialization limit is not a
// recognition miss (ontos-data.md §5.1), so all cores agree here.
func recognizes(v core.Value, kind string) bool {
	var err error
	switch kind {
	case labelInt:
		err = data.RecognizeInt(v)
	case labelText:
		_, err = data.ReadText(v)
	case labelBool:
		_, err = data.ReadBool(v)
	case labelList:
		_, err = data.ReadList(v)
	case labelMap:
		_, err = data.ReadMap(v)
	case labelSet:
		_, err = data.ReadSet(v)
	case labelDecimal:
		// Structural recognizer (NOT data.ReadDecimal), like int — a > i128
		// mantissa/exponent is recognized though it cannot materialize (§5.9).
		err = data.RecognizeDecimal(v)
	case labelNull:
		err = data.RecognizeNull(v)
	default:
		return false
	}
	return err == nil
}

// recognizedLabels returns the embedding labels v is a well-formed instance of,
// in the fixed recognizedKinds order, filtered to the matches (possibly empty).
func recognizedLabels(v core.Value) []string {
	out := make([]string, 0, len(recognizedKinds))
	for _, kind := range recognizedKinds {
		if recognizes(v, kind) {
			out = append(out, kind)
		}
	}
	return out
}

// inspect implements `ontos inspect`: decode, then report codec id, canonical?,
// the value tree, and the embeddings recognized at the top level.
func inspect(format outputFormat, src valueSource, stdin io.Reader, stdout, stderr io.Writer) int {
	value, raw, exit := resolveValue(src, stdin, "inspect", format, stdout, stderr)
	if value == nil {
		return exit
	}

	canonical := bytes.Equal(codec.Encode(value), raw)
	labels := recognizedLabels(value)

	if format == formatJSON {
		emit(stdout, inspectResult{
			OK: true, Command: "inspect", Codec: codecID,
			Canonical: canonical, Value: authoring{value}, Recognized: labels,
		})
	} else {
		fmt.Fprintln(stdout, value.String())
		fmt.Fprintln(stdout, "canonical: "+yesNo(canonical))
		fmt.Fprintln(stdout, "recognized: "+humanLabels(labels))
	}
	return 0
}

// read implements `ontos read [--all | --kind <kind>]`: recognize registered
// embeddings. Exactly one of --all / --kind must be given.
func read(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	format, src, all, kind, err := parseReadArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, "ontos: "+err.Error())
		fmt.Fprintln(stderr, usage)
		return 2
	}

	value, _, exit := resolveValue(src, stdin, "read", format, stdout, stderr)
	if value == nil {
		return exit
	}

	if all {
		labels := recognizedLabels(value)
		if format == formatJSON {
			emit(stdout, readAllResult{OK: true, Command: "read", Recognized: labels})
		} else {
			fmt.Fprintln(stdout, "recognized: "+humanLabels(labels))
		}
		return 0
	}

	// --kind <kind>
	ok := recognizes(value, kind)
	if format == formatJSON {
		emit(stdout, readKindResult{OK: true, Command: "read", Kind: kind, Recognized: ok})
	} else {
		fmt.Fprintf(stdout, "%s: %s\n", kind, yesNo(ok))
	}
	if ok {
		return 0
	}
	return 1
}

// canon implements `ontos canon [--check | --emit]`: report or emit the
// canonical bytes. Neither flag defaults to --check.
func canon(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	format, src, emitMode, err := parseCanonArgs(args)
	if err != nil {
		fmt.Fprintln(stderr, "ontos: "+err.Error())
		fmt.Fprintln(stderr, usage)
		return 2
	}

	value, _, exit := resolveValue(src, stdin, "canon", format, stdout, stderr)
	if value == nil {
		return exit
	}

	encoded := codec.Encode(value)
	if emitMode {
		hexStr := hex.EncodeToString(encoded)
		if format == formatJSON {
			emit(stdout, canonEmitResult{OK: true, Command: "canon", Hex: hexStr})
		} else {
			fmt.Fprintln(stdout, hexStr)
		}
		return 0
	}

	// --check: canonical == encode(decoded) == input, which is always true when
	// decode succeeds (decode only accepts canonical bytes).
	if format == formatJSON {
		emit(stdout, canonCheckResult{OK: true, Command: "canon", Canonical: true})
	} else {
		fmt.Fprintln(stdout, "canonical: yes")
	}
	return 0
}

// resolveValue obtains the command's single Value from exactly one source — the
// positional <hex>/stdin (default) or --from-json — emitting the shared
// usage_error / invalid_hex / invalid_json (all exit 2) and DecodeError (exit 1)
// results for the given command. On success it returns the value, its canonical
// ontos-codec-v1 bytes, and 0; on failure value is nil and the returned int is
// the exit code.
//
// For the hex path the returned bytes are the raw input bytes (so inspect can
// compare them against the re-encoding). For the --from-json path the value is
// built directly and is canonical by construction, so the bytes are its
// encoding.
func resolveValue(src valueSource, stdin io.Reader, command string, format outputFormat, stdout, stderr io.Writer) (core.Value, []byte, int) {
	// Mutual exclusion: --from-json together with a positional <hex> is a
	// usage_error. A "-" positional is the stdin sentinel, not a hex value, but
	// it still names the bytes source, so combining it with --from-json (which
	// is its own source) is equally ambiguous and rejected.
	if src.fromJSON != nil && src.positional != nil {
		if format == formatJSON {
			emitError(stdout, command, "usage_error")
		} else {
			fmt.Fprintln(stderr, "ontos: --from-json cannot be combined with a positional <hex>")
		}
		return nil, nil, 2
	}

	if src.fromJSON != nil {
		text, err := readInput(src.fromJSON, stdin)
		if err != nil {
			fmt.Fprintln(stderr, "ontos: cannot read input: "+err.Error())
			return nil, nil, 2
		}
		value, err := parseAuthoringJSON(text)
		if err != nil {
			// Any malformed JSON or non-authoring shape is the stable invalid_json
			// usage error (exit 2). The specific reason goes to stderr (human only).
			if format == formatJSON {
				emitError(stdout, command, "invalid_json")
			} else {
				fmt.Fprintln(stderr, "ontos: invalid json input: "+err.Error())
			}
			return nil, nil, 2
		}
		// Canonical by construction: an L0 Value has exactly one ontos-codec-v1
		// encoding, so its encoding is the canonical bytes.
		return value, codec.Encode(value), 0
	}

	hexStr, err := readInput(src.positional, stdin)
	if err != nil {
		fmt.Fprintln(stderr, "ontos: cannot read input: "+err.Error())
		return nil, nil, 2
	}
	raw, err := hex.DecodeString(hexStr)
	if err != nil {
		if format == formatJSON {
			emitError(stdout, command, "invalid_hex")
		} else {
			fmt.Fprintln(stderr, "ontos: invalid hex input")
		}
		return nil, nil, 2
	}
	value, err := codec.Decode(raw)
	if err != nil {
		code := decodeErrorCode(err)
		if format == formatJSON {
			emitError(stdout, command, code)
		} else {
			fmt.Fprintln(stderr, "ontos: decode error: "+code)
		}
		return nil, nil, 1
	}
	return value, raw, 0
}

// parseAuthoringJSON parses the authoring notation — the exact inverse of the
// --format json value rendering — into a core.Value. The grammar (vectors/, and
// gen.mjs parseAuthoring, which this mirrors):
//
//	value ::= { "atom":  "<lowercase-hex>" }   // even-length; "" = empty atom
//	        | { "tuple": [ value, … ] }         // [] = empty tuple
//
// A value is a JSON object with EXACTLY ONE of "atom"/"tuple" and no other keys.
// Any malformed JSON or non-authoring shape (not an object, neither/both keys,
// extra keys, non-string atom, odd-length/uppercase/non-hex atom, non-array
// tuple) is an error — the caller maps every such error to the single stable
// invalid_json code, so the three cores agree on output even where their raw
// tokenizers might differ on exotic syntax.
//
// Per the dependency ethos (ontos-cli.md): Go decodes with the stdlib
// encoding/json (TS uses JSON.parse; Rust hand-rolls), then all three apply this
// same structural validation.
func parseAuthoringJSON(text string) (core.Value, error) {
	var node any
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	if err := dec.Decode(&node); err != nil {
		return nil, fmt.Errorf("malformed json: %w", err)
	}
	// Reject trailing content after the top-level value (e.g. `{} {}` or
	// `{"atom":"00"} x`); the input must be exactly one JSON value.
	if dec.More() {
		return nil, errors.New("trailing data after top-level json value")
	}
	return authoringFromNode(node, "$")
}

// authoringFromNode validates one decoded JSON node against the authoring
// grammar and builds the corresponding core.Value. `where` is a JSON-path-ish
// breadcrumb for the (human-only) diagnostic message.
func authoringFromNode(node any, where string) (core.Value, error) {
	obj, ok := node.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s: value must be an object with one of \"atom\"/\"tuple\"", where)
	}
	_, hasAtom := obj["atom"]
	_, hasTuple := obj["tuple"]
	if hasAtom == hasTuple {
		// Both present or neither present.
		return nil, fmt.Errorf("%s: value must have exactly one of \"atom\" or \"tuple\"", where)
	}
	// Exactly one of atom/tuple AND no other keys: with exactly one present, the
	// object must have exactly one key total.
	if len(obj) != 1 {
		return nil, fmt.Errorf("%s: value must have no keys besides \"atom\"/\"tuple\"", where)
	}

	if hasAtom {
		s, ok := obj["atom"].(string)
		if !ok {
			return nil, fmt.Errorf("%s: \"atom\" must be a string", where)
		}
		b, err := authoringHex(s, where)
		if err != nil {
			return nil, err
		}
		return core.NewAtom(b), nil
	}

	arr, ok := obj["tuple"].([]any)
	if !ok {
		return nil, fmt.Errorf("%s: \"tuple\" must be an array", where)
	}
	items := make([]core.Value, len(arr))
	for i, child := range arr {
		v, err := authoringFromNode(child, fmt.Sprintf("%s.tuple[%d]", where, i))
		if err != nil {
			return nil, err
		}
		items[i] = v
	}
	return core.NewTuple(items...), nil
}

// authoringHex validates an atom string as even-length LOWERCASE hex ("" is the
// empty atom) and returns its bytes. It rejects uppercase explicitly because
// encoding/hex would otherwise accept it, which would break round-trip with the
// lowercase json rendering and the cross-core agreement.
func authoringHex(s, where string) ([]byte, error) {
	if len(s)%2 != 0 {
		return nil, fmt.Errorf("%s: \"atom\" must be even-length hex", where)
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return nil, fmt.Errorf("%s: \"atom\" must be lowercase hex (got %q)", where, s)
		}
	}
	b, err := hex.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("%s: \"atom\" must be hex: %w", where, err)
	}
	return b, nil
}

// yesNo renders a bool as the human-format "yes"/"no".
func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// humanLabels renders the recognized labels for the human format, shared by
// inspect and `read --all`: the labels joined by ", " (comma-space), or "none"
// when empty. This is the tri-core human-output contract (docs/spec/ontos-cli.md
// "Human format", ontos-internal#46) — enforced byte-for-byte across go/rs/ts by the
// conformance harness --human-roundtrip mode, so it must match the rs/ts cores
// exactly.
func humanLabels(labels []string) string {
	if len(labels) == 0 {
		return "none"
	}
	return strings.Join(labels, ", ")
}

// decodeResult is the success line for `decode`. The struct field order fixes
// the json key order (ok, command, codec, value) the contract pins.
type decodeResult struct {
	OK      bool      `json:"ok"`
	Command string    `json:"command"`
	Codec   string    `json:"codec"`
	Value   authoring `json:"value"`
}

// errorResult is the negative/error line: {"ok":false,"command":...,"error":...}.
type errorResult struct {
	OK      bool   `json:"ok"`
	Command string `json:"command"`
	Error   string `json:"error"`
}

// inspectResult is the success line for `inspect`. The field order fixes the
// json key order (ok, command, codec, canonical, value, recognized).
type inspectResult struct {
	OK         bool      `json:"ok"`
	Command    string    `json:"command"`
	Codec      string    `json:"codec"`
	Canonical  bool      `json:"canonical"`
	Value      authoring `json:"value"`
	Recognized []string  `json:"recognized"`
}

// readKindResult is the `read --kind <k>` line (ok, command, kind, recognized).
type readKindResult struct {
	OK         bool   `json:"ok"`
	Command    string `json:"command"`
	Kind       string `json:"kind"`
	Recognized bool   `json:"recognized"`
}

// readAllResult is the `read --all` line (ok, command, recognized).
type readAllResult struct {
	OK         bool     `json:"ok"`
	Command    string   `json:"command"`
	Recognized []string `json:"recognized"`
}

// canonCheckResult is the `canon --check` line (ok, command, canonical).
type canonCheckResult struct {
	OK        bool   `json:"ok"`
	Command   string `json:"command"`
	Canonical bool   `json:"canonical"`
}

// canonEmitResult is the `canon --emit` line (ok, command, hex).
type canonEmitResult struct {
	OK      bool   `json:"ok"`
	Command string `json:"command"`
	Hex     string `json:"hex"`
}

// authoring wraps a core.Value so it marshals to the vectors authoring notation
// — {"atom":"<lowercase-hex>"} or {"tuple":[<child>,...]} — recursively.
type authoring struct{ value core.Value }

// MarshalJSON renders the authoring notation. It hand-builds the bytes so the
// hex is lowercase, keys are fixed, and the output is compact and deterministic
// regardless of Go map iteration.
func (a authoring) MarshalJSON() ([]byte, error) {
	var b strings.Builder
	if err := writeAuthoring(&b, a.value); err != nil {
		return nil, err
	}
	return []byte(b.String()), nil
}

func writeAuthoring(b *strings.Builder, v core.Value) error {
	switch val := v.(type) {
	case core.Atom:
		b.WriteString(`{"atom":"`)
		b.WriteString(hex.EncodeToString(val.Bytes()))
		b.WriteString(`"}`)
	case core.Tuple:
		b.WriteString(`{"tuple":[`)
		for i, item := range val.Items() {
			if i != 0 {
				b.WriteByte(',')
			}
			if err := writeAuthoring(b, item); err != nil {
				return err
			}
		}
		b.WriteString("]}")
	default:
		return fmt.Errorf("ontos: unknown core.Value implementation %T", v)
	}
	return nil
}

// emit marshals one result object compactly and writes it as a single line.
func emit(w io.Writer, v any) {
	out, err := json.Marshal(v)
	if err != nil {
		// Marshalling a fixed-shape result cannot realistically fail; if it does,
		// there is nothing better to do than report it on the same stream.
		fmt.Fprintln(w, `{"ok":false,"command":"decode","error":"internal_error"}`)
		return
	}
	w.Write(out)
	fmt.Fprintln(w)
}

// emitError writes a compact {"ok":false,"command":...,"error":...} line.
func emitError(w io.Writer, command, code string) {
	emit(w, errorResult{OK: false, Command: command, Error: code})
}
