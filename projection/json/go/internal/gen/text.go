package gen

import (
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"strings"
)

// alphabet holds the bytes and fragments the strict reader and the interpreters care about.
var alphabet = []string{
	"{", "}", "[", "]", ",", ":", "\"", "\\", "\\u", "u", "0", "1", "9", "a", "f", "A", "F", ".", "e",
	"E", "+", "-", " ", "\t", "\n", "\r", "\f", "\x00", "\x7f", "t", "n", "$", "\xc3", "\xa9", "\xed",
	"\xa0", "\x80", "\xef\xbb\xbf", "\xe2\x80\xa8", "\\ud800", "\\udc00", "\\u0061", "=", "/", "null",
	"true", "\"$ontos\"", "\"atom\"", "\"tuple\"", "\"bytes\"", "\"int\"", "\"raw\"", "\"compound\"",
}

// Mutate changes b in one to three random places.
func (g *Gen) Mutate(b []byte) []byte {
	out := append([]byte(nil), b...)
	for i, k := 0, 1+g.n(3); i < k; i++ {
		at := 0
		if len(out) > 0 {
			at = g.n(len(out) + 1)
		}
		switch g.n(4) {
		case 0: // delete a run
			if at < len(out) {
				end := min(len(out), at+1+g.n(3))
				out = append(out[:at:at], out[end:]...)
			}
		case 1: // replace a byte
			if at < len(out) {
				out[at] = alphabet[g.n(len(alphabet))][0]
			}
		case 2: // duplicate a run
			if at < len(out) {
				end := min(len(out), at+1+g.n(8))
				run := append([]byte(nil), out[at:end]...)
				out = append(out[:end:end], append(run, out[end:]...)...)
			}
		default: // insert a fragment
			frag := alphabet[g.n(len(alphabet))]
			out = append(out[:at:at], append([]byte(frag), out[at:]...)...)
		}
	}
	return out
}

func (g *Gen) ws() string {
	if g.chance(0.85) {
		return ""
	}
	return []string{" ", "\t", "\n", "\r\n", "  "}[g.n(5)]
}

func (g *Gen) str(s string) string {
	if g.chance(0.15) && len(s) > 0 {
		return `"\u` + hex.EncodeToString([]byte{0, s[0]}) + strconv.Quote(s[1:])[1:]
	}
	return strconv.Quote(s)
}

func (g *Gen) number() string {
	nums := []string{"0", "-0", "1", "-1", "257", "9007199254740991", "-9007199254740991", "9007199254740992",
		"-9007199254740992", "340282366920938463463374607431768211456", "1.0", "1e0", "1E+2", "-0.0", "12345", "100"}
	return nums[g.n(len(nums))]
}

func (g *Gen) intText() string {
	ints := []string{"0", "1", "-1", "5", "100", "10", "-5", "314", "-2", "9007199254740993", "+1", "01", "-0", "",
		" 1", "1.5", "x", "1_000", "170141183460469231731687303715884105728", "7", "-99999999999999999999999"}
	return g.str(ints[g.n(len(ints))])
}

func (g *Gen) b64() string {
	if g.chance(0.2) {
		bad := []string{"AB==", "AA", "AA==\n", "-_8=", "A===", " AA==", "AA==AA==", "b2s"}
		return strconv.Quote(bad[g.n(len(bad))])
	}
	return strconv.Quote(base64.StdEncoding.EncodeToString(g.Bytes()))
}

// TotalText draws a total-form text, sometimes malformed.
func (g *Gen) TotalText(depth int) string {
	if depth <= 0 || g.chance(0.4) {
		h := hex.EncodeToString(g.Bytes())
		if g.chance(0.1) {
			h = []string{"0", "0A", "zz", " 00", "x"}[g.n(5)]
		}
		return "{" + g.ws() + g.str("atom") + g.ws() + ":" + g.ws() + strconv.Quote(h) + g.ws() + "}"
	}
	var items []string
	for i, n := 0, g.n(4); i < n; i++ {
		items = append(items, g.ws()+g.TotalText(depth-1)+g.ws())
	}
	if g.chance(0.05) {
		items = append(items, g.number())
	}
	return "{" + g.str("tuple") + ":[" + strings.Join(items, ",") + "]}"
}

// spellings are groups of texts that denote one value, so that sets and maps built from
// them repeat values under other spellings.
var spellings = [][]string{
	{`1`, `{"$ontos":["int","1"]}`, `{"$ontos":["compound","int",[{"$ontos":["bytes","AAE="]}]]}`},
	{`"a"`, `"\u0061"`, `{"$ontos":["raw",{"tuple":[{"atom":"757466382d74657874"},{"atom":"61"}]}]}`},
	{`null`, `{"$ontos":["compound","null",[]]}`},
	{`[]`, `{"$ontos":["compound","list",[]]}`, `{"$ontos":["raw",{"tuple":[{"atom":"6c697374"}]}]}`},
	{`{}`, `{"$ontos":["map",[]]}`},
	{`-0`, `0`, `{"$ontos":["int","0"]}`},
}

func (g *Gen) spelling() string {
	group := spellings[g.n(len(spellings))]
	return group[g.n(len(group))]
}

// ReadableText draws a readable-profile text, often valid and sometimes not.
func (g *Gen) ReadableText(depth int) string {
	w := g.ws
	if g.chance(0.1) {
		return g.spelling()
	}
	if depth <= 0 || g.chance(0.3) {
		switch g.n(5) {
		case 0:
			return []string{"null", "true", "false"}[g.n(3)]
		case 1:
			return g.number()
		default:
			return g.str(g.Text())
		}
	}
	var items []string
	k := g.n(4)
	for i := 0; i < k; i++ {
		items = append(items, w()+g.ReadableText(depth-1)+w())
	}
	list := "[" + strings.Join(items, ",") + "]"
	switch g.n(12) {
	case 0, 1:
		return list
	case 2, 3:
		var members []string
		for i := 0; i < k; i++ {
			name := g.Text()
			if g.chance(0.05) {
				name = "$ontos"
			}
			members = append(members, w()+g.str(name)+w()+":"+w()+g.ReadableText(depth-1)+w())
		}
		return "{" + strings.Join(members, ",") + "}"
	}
	tags := []string{"bytes", "int", "decimal", "map", "set", "compound", "raw", "Bytes", "tuple"}
	tag := tags[g.n(len(tags))]
	var payload []string
	switch tag {
	case "bytes":
		payload = []string{g.b64()}
	case "int":
		payload = []string{g.intText()}
	case "decimal":
		payload = []string{g.intText(), g.intText()}
	case "map":
		var entries []string
		for i := 0; i < k; i++ {
			if g.chance(0.05) {
				entries = append(entries, "["+g.ReadableText(depth-2)+"]")
				continue
			}
			key := g.ReadableText(depth - 2)
			if g.chance(0.5) {
				key = g.spelling()
			}
			entries = append(entries, "["+key+","+w()+g.ReadableText(depth-2)+"]")
		}
		payload = []string{"[" + strings.Join(entries, ",") + "]"}
	case "set":
		if g.chance(0.5) {
			var elems []string
			for i, n := 0, 1+g.n(4); i < n; i++ {
				elems = append(elems, g.spelling())
			}
			list = "[" + strings.Join(elems, ",") + "]"
		}
		payload = []string{list}
	case "compound":
		label := g.str(g.Text())
		if g.chance(0.2) {
			label = `["bytes",` + g.b64() + `]`
		}
		payload = []string{label, list}
	case "raw":
		payload = []string{g.TotalText(depth - 1)}
	}
	if g.chance(0.05) && len(payload) > 0 {
		payload = payload[:len(payload)-1]
	}
	if g.chance(0.05) {
		payload = append(payload, "1")
	}
	env := "[" + strings.Join(append([]string{g.str(tag)}, payload...), ","+w()) + "]"
	extra := ""
	if g.chance(0.03) {
		extra = `,"x":1`
	}
	return "{" + w() + g.str("$ontos") + w() + ":" + w() + env + extra + w() + "}"
}

// Limits draws limit overrides by their spec names: none, often, or a few small bounds.
// integerDigits says whether max_integer_digits may be drawn.
func (g *Gen) Limits(integerDigits bool) map[string]int {
	out := map[string]int{}
	if g.chance(0.5) {
		return out
	}
	for i, k := 0, 1+g.n(3); i < k; i++ {
		switch g.n(6) {
		case 0:
			out["max_text_bytes"] = g.n(120)
		case 1:
			out["max_json_depth"] = g.n(10)
		case 2:
			out["max_value_depth"] = g.n(6)
		case 3:
			out["max_atom_bytes"] = g.n(12)
		case 4:
			out["max_tuple_arity"] = g.n(5)
		case 5:
			if integerDigits {
				out["max_integer_digits"] = g.n(20)
			}
		}
	}
	return out
}
