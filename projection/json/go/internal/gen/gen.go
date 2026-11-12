// Package gen builds random values and random JSON texts for the Go JSON projections'
// property tests. The values lean on the shapes the readable profile tells apart: every
// ontos/data kind in its canonical form and in malformed forms, compounds with UTF-8 and
// other labels, and raw tuples. The texts lean on what the strict reader refuses.
package gen

import (
	"math/big"
	"math/rand/v2"
	"strings"

	"github.com/bitspark/ontos/core/go"
	"github.com/bitspark/ontos/data/go"
)

// Gen draws from one deterministic source.
type Gen struct {
	R *rand.Rand
}

// New is a generator seeded with seed.
func New(seed uint64) *Gen { return &Gen{R: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))} }

func (g *Gen) n(k int) int { return g.R.IntN(k) }

func (g *Gen) chance(p float64) bool { return g.R.Float64() < p }

// texts are strings that exercise escaping, Unicode and the reserved name.
var texts = []string{
	"", "a", "b", "aa", "Z", "$ontos", "$bytes", "__proto__", "atom", "tuple", "\u00e9", "e\u0301",
	"\"", "\\", "/", "\b\f\n\r\t", "\x00\x1f\x7f", "\u2028\u2029", "\ufeffx", "\U0001f600", "int", "list",
	"null", "map", "set", "decimal", "bool", "utf8-text", "0", "1", strings.Repeat("k", 129),
}

// Text draws a well-formed string.
func (g *Gen) Text() string {
	if g.chance(0.7) {
		return texts[g.n(len(texts))]
	}
	var b strings.Builder
	for i, n := 0, g.n(6); i < n; i++ {
		switch g.n(5) {
		case 0:
			b.WriteByte(byte(g.n(0x20)))
		case 1:
			b.WriteRune(rune(0x80 + g.n(0x700)))
		case 2:
			b.WriteRune(rune(0x10000 + g.n(0x1000)))
		default:
			b.WriteByte(byte(0x20 + g.n(0x5f)))
		}
	}
	return b.String()
}

// Bytes draws a short byte string, sometimes not UTF-8.
func (g *Gen) Bytes() []byte {
	if g.chance(0.3) {
		return []byte(g.Text())
	}
	b := make([]byte, g.n(6))
	for i := range b {
		b[i] = byte(g.R.UintN(256))
	}
	return b
}

// Int draws an integer, often near the edges that matter: 0, ±(2⁵³ − 1), 2⁵³, beyond 2¹²⁷.
func (g *Gen) Int() *big.Int {
	switch g.n(6) {
	case 0:
		return big.NewInt(int64(g.n(21) - 10))
	case 1:
		n := new(big.Int).Lsh(big.NewInt(1), 53)
		return n.Add(n, big.NewInt(int64(g.n(5)-3)))
	case 2:
		n := new(big.Int).Lsh(big.NewInt(1), uint(g.n(200)))
		return n.Sub(n, big.NewInt(int64(g.n(3))))
	case 3:
		return new(big.Int).Neg(new(big.Int).Lsh(big.NewInt(1), uint(g.n(70))))
	default:
		return big.NewInt(g.R.Int64N(1<<40) - 1<<39)
	}
}

func (g *Gen) atom(s string) core.Atom { return core.NewAtom([]byte(s)) }

// Value draws a value of value depth at most depth.
func (g *Gen) Value(depth int) core.Value {
	leaf := depth <= 0 || g.chance(0.35)
	if leaf {
		switch g.n(8) {
		case 0:
			return core.NewAtom(g.Bytes())
		case 1:
			return data.EncodeNull()
		case 2:
			return data.EncodeBool(g.chance(0.5))
		case 3, 4:
			return data.MustEncodeText(g.Text())
		case 5:
			return data.EncodeInt(g.Int())
		case 6:
			m := g.Int()
			if g.chance(0.2) {
				m = big.NewInt(0)
			}
			return data.EncodeDecimal(m, g.Int())
		default:
			return core.NewTuple()
		}
	}
	kids := func(k int) []core.Value {
		out := make([]core.Value, k)
		for i := range out {
			out[i] = g.Value(depth - 1)
		}
		return out
	}
	switch g.n(10) {
	case 0, 1:
		return data.EncodeList(kids(g.n(4)))
	case 2, 3:
		n := g.n(4)
		var entries [][2]core.Value
		seen := map[string]bool{}
		for i := 0; i < n; i++ {
			var k core.Value
			if g.chance(0.7) {
				k = data.MustEncodeText(g.Text())
			} else {
				k = g.Value(depth - 2)
			}
			key := k.String()
			if seen[key] {
				continue
			}
			seen[key] = true
			entries = append(entries, [2]core.Value{k, g.Value(depth - 2)})
		}
		m, err := data.EncodeMap(entries)
		if err != nil {
			panic(err)
		}
		return m
	case 4:
		var elems []core.Value
		seen := map[string]bool{}
		for i, n := 0, g.n(4); i < n; i++ {
			e := g.Value(depth - 1)
			if !seen[e.String()] {
				seen[e.String()] = true
				elems = append(elems, e)
			}
		}
		s, err := data.EncodeSet(elems)
		if err != nil {
			panic(err)
		}
		return s
	case 5:
		// A compound: a registered label with malformed children, or any other label.
		labels := []string{"null", "bool", "int", "utf8-text", "list", "map", "set", "decimal", "ok", "", "acme.example/x"}
		var label core.Atom
		if g.chance(0.8) {
			label = g.atom(labels[g.n(len(labels))])
		} else {
			label = core.NewAtom(g.Bytes())
		}
		return core.NewTuple(append([]core.Value{label}, kids(g.n(3))...)...)
	case 6:
		// An unsorted or duplicated set or map, which stays a compound.
		k := g.Value(depth - 1)
		if g.chance(0.5) {
			return core.NewTuple(g.atom("set"), k, k)
		}
		return core.NewTuple(g.atom("map"), core.NewTuple(k, k), core.NewTuple(k, k))
	default:
		// A raw tuple: empty, or whose first child is a tuple.
		return core.NewTuple(append([]core.Value{core.NewTuple(kids(g.n(2))...)}, kids(g.n(3))...)...)
	}
}
