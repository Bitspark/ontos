package readable

import (
	"math/big"
	"testing"
)

// digitsOver decides the digit count from the bit length where it can and compares with a
// power of ten only between the bounds; it must agree with the decimal text everywhere.
func TestDigitsOver(t *testing.T) {
	ten := big.NewInt(10)
	var ns []*big.Int
	for k := 0; k <= 400; k++ {
		p := new(big.Int).Exp(ten, big.NewInt(int64(k)), nil)
		ns = append(ns, p, new(big.Int).Sub(p, big.NewInt(1)), new(big.Int).Add(p, big.NewInt(1)))
		b := new(big.Int).Lsh(big.NewInt(1), uint(k))
		ns = append(ns, b, new(big.Int).Sub(b, big.NewInt(1)))
	}
	for _, n := range ns {
		for _, sign := range []int64{1, -1} {
			m := new(big.Int).Mul(n, big.NewInt(sign))
			digits := len(new(big.Int).Abs(m).String())
			for _, max := range []int{0, 1, digits - 2, digits - 1, digits, digits + 1, 4300, Unbounded} {
				if max < 0 {
					continue
				}
				if got, want := digitsOver(m, max), digits > max; got != want {
					t.Fatalf("digitsOver(%s, %d) = %v, want %v", m, max, got, want)
				}
			}
		}
	}
}
