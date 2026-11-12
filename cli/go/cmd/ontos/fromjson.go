package main

// JSON values through the projection library (docs/spec/ontos-cli.md "Value input" and
// "JSON profiles"). --json-profile selects the profile, the same way in all four CLIs:
//
//   - total (the default) is ontos-total-json/1, through projection/json/go/total. The
//     --from-json text comes from an argument or from stdin. Bytes that are not UTF-8
//     are read as U+FFFD before the library sees them (readTotalText): that step is the
//     CLI's total transport, because Node decodes argv that way before ts sees it. The
//     library's reader is strict and never repairs text.
//   - readable is ontos-readable-json/1, through projection/json/go/readable. Its input
//     is read from stdin only, as the exact bytes, with no lossy step, because a
//     replaced byte inside a string would read as a different value (readable §10.1).
//
// A library refusal maps onto the CLI's codes: a limit is limit_exceeded (exit 1), and
// any other refusal is invalid_json (exit 2). The same profile renders the value of
// --format json output.

import (
	"errors"
	"fmt"
	"io"
	"strings"

	core "github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/projection/json/go/readable"
	"github.com/bitspark/ontos/projection/json/go/total"
)

// jsonProfile is the JSON profile selected by --json-profile.
type jsonProfile int

const (
	profileTotal jsonProfile = iota
	profileReadable
)

func parseJSONProfile(s string) (jsonProfile, error) {
	switch s {
	case "total":
		return profileTotal, nil
	case "readable":
		return profileReadable, nil
	default:
		return profileTotal, fmt.Errorf("unknown json profile %q (want total|readable)", s)
	}
}

// errReadableArgument is the usage_error for a readable --from-json text given as an
// argument: readable input is read from stdin only.
var errReadableArgument = errors.New("--json-profile readable reads --from-json from stdin only (--from-json -)")

// readJSONSource reads the --from-json text as given: the argument, or the whole of
// stdin for "-". Nothing is trimmed: the reader allows only RFC 8259 whitespace.
func readJSONSource(arg string, stdin io.Reader) ([]byte, error) {
	if arg != "-" {
		return []byte(arg), nil
	}
	return io.ReadAll(stdin)
}

// readTotalText is the total transport: invalid UTF-8 becomes U+FFFD. U+FFFD is never
// hex and never part of "atom" or "tuple", so such a text is always refused, and the
// outcome never depends on how many U+FFFD replace a bad sequence.
func readTotalText(raw []byte) []byte {
	return []byte(strings.ToValidUTF8(string(raw), "�"))
}

// parseJSONValue reads a --from-json text under profile. A refusal is a *total.Error
// (the readable profile shares that type).
func parseJSONValue(raw []byte, profile jsonProfile) (core.Value, error) {
	if profile == profileReadable {
		return readable.ParseUTF8(raw, readable.DefaultLimits())
	}
	return total.ParseUTF8(readTotalText(raw), total.DefaultLimits())
}

// renderJSONValue writes v under profile, for the value of --format json output. Under
// the defaults the total writer accepts every value the CLI can hold (none is deeper
// than 1024), and the readable writer refuses only an integer of more than 4300 digits.
func renderJSONValue(v core.Value, profile jsonProfile) ([]byte, error) {
	if profile == profileReadable {
		return readable.RenderUTF8(v, readable.DefaultLimits())
	}
	return total.RenderUTF8(v, total.DefaultLimits())
}

// jsonFailure maps a library refusal onto the CLI's codes: a limit is limit_exceeded,
// exit 1, as a decode limit; anything else is invalid_json, exit 2.
func jsonFailure(err error) (code string, exit int) {
	var refusal *total.Error
	if errors.As(err, &refusal) && refusal.Code == total.CodeLimitExceeded {
		return "limit_exceeded", 1
	}
	return "invalid_json", 2
}
