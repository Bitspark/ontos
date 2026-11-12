package readable

import (
	"encoding/base64"
	"math/big"

	"github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/data/go"
	"github.com/bitspark/ontos/projection/json/go/internal/jsontext"
)

// The label atoms of ontos/data (ontos-data §5). An atom is immutable, so one value serves
// every tuple that carries it.
var (
	labelNull    = core.NewAtom([]byte("null"))
	labelBool    = core.NewAtom([]byte("bool"))
	labelText    = core.NewAtom([]byte("utf8-text"))
	labelInt     = core.NewAtom([]byte("int"))
	labelList    = core.NewAtom([]byte("list"))
	labelMap     = core.NewAtom([]byte("map"))
	labelSet     = core.NewAtom([]byte("set"))
	labelDecimal = core.NewAtom([]byte("decimal"))
)

// The byte lengths of the label atoms, which the limit checks count (spec §4.9).
const (
	lenNull    = len("null")
	lenBool    = len("bool")
	lenText    = len("utf8-text")
	lenInt     = len("int")
	lenList    = len("list")
	lenMap     = len("map")
	lenSet     = len("set")
	lenDecimal = len("decimal")
)

func textValue(s string) core.Value {
	return core.NewTuple(labelText, core.NewAtom([]byte(s)))
}

// textKey is the part of a text's codec encoding after the prefix every text shares:
// uvarint(len) ‖ bytes. Comparing it orders texts as their whole encodings do (spec §4.8).
func textKey(s string) []byte {
	out := jsontext.AppendUvarint(make([]byte, 0, len(s)+2), uint64(len(s)))
	return append(out, s...)
}

// isIntText reports whether s is canonical integer text (spec §3, int-text): 0, or an
// optional - and a non-zero ASCII digit followed by ASCII digits. It reads the text
// itself, never a host conversion.
func isIntText(s string) bool {
	if s == "0" {
		return true
	}
	if len(s) > 0 && s[0] == '-' {
		s = s[1:]
	}
	if len(s) == 0 || s[0] < '1' || s[0] > '9' {
		return false
	}
	for i := 1; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}

// digitCount is the number of digits in the magnitude of integer text.
func digitCount(s string) int {
	if len(s) > 0 && s[0] == '-' {
		return len(s) - 1
	}
	return len(s)
}

// maxSafe is 2⁵³ − 1, the bound of the bare integer window (spec §4.5).
const maxSafe = "9007199254740991"

// isSafe reports whether integer text lies within ±(2⁵³ − 1). It compares the digits,
// which have no leading zero.
func isSafe(s string) bool {
	if len(s) > 0 && s[0] == '-' {
		s = s[1:]
	}
	return len(s) < len(maxSafe) || len(s) == len(maxSafe) && s <= maxSafe
}

var bigMaxSafe = big.NewInt(1<<53 - 1)

// intValue converts integer text, already checked, to the int embedding (ontos-data §5.1),
// with the byte length of its payload atom. big.Int has no bound but memory.
func intValue(s string) (core.Value, int) {
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		panic("readable: intValue of unchecked text " + s)
	}
	return data.EncodeInt(n), 1 + (n.BitLen()+7)/8
}

// decodeBase64 decodes canonical base64 (spec §4.7): a string is canonical exactly when
// decoding it and encoding the result reproduces it. The comparison also refuses the line
// breaks that Go's decoder skips.
func decodeBase64(s string) ([]byte, bool) {
	b, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil || base64.StdEncoding.EncodeToString(b) != s {
		return nil, false
	}
	if b == nil {
		b = []byte{}
	}
	return b, true
}

// digitsOver reports whether |n| has more decimal digits than max, without converting n
// to decimal (spec §4.5: the check comes before the integer is converted). The bit length
// bounds the digit count from both sides; only between the bounds does it compare n with
// 10^max, which is then about n's own size.
func digitsOver(n *big.Int, max int) bool {
	if max == Unbounded {
		return false
	}
	bits := n.BitLen()
	if bits == 0 {
		return 1 > max // the integer 0 is the one digit "0"
	}
	// digits = ⌊log₁₀|n|⌋ + 1, and (bits − 1)·log₁₀2 ≤ log₁₀|n| < bits·log₁₀2.
	low := int(float64(bits-1)*0.30102999) + 1
	high := int(float64(bits)*0.30103) + 1
	switch {
	case low > max:
		return true
	case high <= max:
		return false
	}
	pow := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(max)), nil)
	return new(big.Int).Abs(n).Cmp(pow) >= 0
}
