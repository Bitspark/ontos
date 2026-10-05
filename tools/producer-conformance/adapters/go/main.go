// producer-conformance adapter — Go. See ../../PROTOCOL.md.
//
//	adapter <kind> <arg>   ->  one JSON line on stdout
//
// Builds the host value NATIVELY from the recipe, runs the blessed producer, and
// reports canonical bytes or a classified rejection. Go is the one language that can
// hold arbitrary bytes in a string, so it is the only adapter supporting the `bytes`
// recipe — that asymmetry is the point, not a gap.
package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
	"strconv"
	"strings"

	codec "github.com/bitspark/ontos/codec/go"
	core "github.com/bitspark/ontos/core/go"
	data "github.com/bitspark/ontos/data/go"
)

// errUnsupported reports that the host value is unconstructible here — not a failure.
type errUnsupported struct{ reason string }

func (e *errUnsupported) Error() string { return e.reason }

func codepoints(arg string) ([]rune, error) {
	out := []rune{}
	for _, f := range strings.Split(arg, ",") {
		if f == "" {
			continue
		}
		n, err := strconv.Atoi(f)
		if err != nil {
			return nil, &errUnsupported{fmt.Sprintf("bad code point %q", f)}
		}
		out = append(out, rune(n))
	}
	return out, nil
}

func buildAndEncode(kind, arg string) (core.Value, error) {
	switch kind {
	case "int":
		n, ok := new(big.Int).SetString(arg, 10)
		if !ok {
			return nil, &errUnsupported{fmt.Sprintf("cannot parse decimal %q", arg)}
		}
		return data.EncodeInt(n), nil

	case "bool":
		switch arg {
		case "true":
			return data.EncodeBool(true), nil
		case "false":
			return data.EncodeBool(false), nil
		}
		return nil, &errUnsupported{fmt.Sprintf("bad bool %q", arg)}

	case "text":
		rs, err := codepoints(arg)
		if err != nil {
			return nil, err
		}
		return data.EncodeText(string(rs))

	case "utf16":
		// Go has no UTF-16 string type; a lone surrogate cannot round-trip through a
		// rune. That recipe belongs to ts/py — Go expresses the same domain error via
		// the `bytes` recipe instead.
		return nil, &errUnsupported{"Go has no UTF-16 string; use the bytes recipe"}

	case "bytes":
		raw, err := hex.DecodeString(arg)
		if err != nil {
			return nil, &errUnsupported{fmt.Sprintf("bad hex %q", arg)}
		}
		return data.EncodeText(string(raw))
	}
	return nil, &errUnsupported{fmt.Sprintf("unknown kind %q", kind)}
}

func emit(v map[string]string) {
	out, _ := json.Marshal(v)
	fmt.Println(string(out))
}

func main() {
	if len(os.Args) != 3 {
		emit(map[string]string{"status": "error", "code": "adapter_usage"})
		os.Exit(2)
	}

	value, err := buildAndEncode(os.Args[1], os.Args[2])
	if err != nil {
		var unsup *errUnsupported
		if errors.As(err, &unsup) {
			emit(map[string]string{"status": "unsupported", "reason": unsup.reason})
			return
		}
		var de *data.DataError
		if errors.As(err, &de) {
			emit(map[string]string{"status": "error", "code": de.Code()})
			return
		}
		// A producer returning a non-DataError is a §4.1 law-3 violation. Report it
		// verbatim so the harness SEES the leak instead of normalizing it away.
		emit(map[string]string{"status": "error", "code": "UNCLASSIFIED:" + fmt.Sprintf("%T", err)})
		return
	}
	emit(map[string]string{"status": "ok", "hex": hex.EncodeToString(codec.Encode(value))})
}
