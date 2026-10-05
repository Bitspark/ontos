package data

import (
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	core "github.com/bitspark/ontos/core/go"
)

// Pins the producer-admission laws (ontos-data.md §4.1) for this core's utf8-text
// producer.
//
// A Go string is an arbitrary immutable byte sequence, NOT guaranteed valid UTF-8:
// string([]byte{0x80}) is an ordinary Go string. EncodeText used to write those
// bytes through verbatim, minting a value that this package's own ReadText rejects
// — §4.1 law 1, producer soundness. Its doc comment asserted the opposite ("a Go
// string is already a UTF-8 byte sequence, so no validation is needed on the
// producer side"), which is why the defect survived review.

// invalidUTF8 returns Go strings that are outside utf8-text's admissible domain.
// Each is checked with utf8.ValidString so the corpus cannot silently become valid
// (e.g. if someone "helpfully" rewrites a literal).
func invalidUTF8(t *testing.T) map[string]string {
	t.Helper()
	cases := map[string]string{
		"lone continuation byte": string([]byte{0x80}),
		"truncated 2-byte seq":   string([]byte{0xc3}),
		"truncated 3-byte seq":   string([]byte{0xe6, 0x97}),
		"bare 0xff":              string([]byte{0xff}),
		"surrogate half CESU-8":  string([]byte{0xed, 0xa0, 0x80}), // U+D800 encoded
		"valid then invalid":     "ok" + string([]byte{0x80}),
		"invalid then valid":     string([]byte{0x80}) + "ok",
	}
	for name, s := range cases {
		if utf8.ValidString(s) {
			t.Fatalf("corpus bug: %q (%s) is valid UTF-8; it cannot test the rejection path", s, name)
		}
	}
	return cases
}

func TestEncodeTextRejectsInvalidUTF8(t *testing.T) {
	for name, s := range invalidUTF8(t) {
		t.Run(name, func(t *testing.T) {
			v, err := EncodeText(s)
			if err == nil {
				t.Fatalf("EncodeText(%q) succeeded; §4.1 law 1 requires rejection (it would mint a value ReadText refuses)", s)
			}
			if v != nil {
				t.Errorf("EncodeText returned a non-nil value alongside its error: %v", v)
			}
			var de *DataError
			if !errors.As(err, &de) {
				t.Fatalf("error is %T, want *DataError — §4.1 law 3 requires the profile's own error channel", err)
			}
			if de.Kind != labelText {
				t.Errorf("DataError.Kind = %q, want %q", de.Kind, labelText)
			}
		})
	}
}

// The soundness law itself, stated as the round-trip it exists to guarantee: any
// value EncodeText SUCCEEDS with must be readable by this package's own reader.
func TestEncodeTextSoundnessProducerOutputIsAlwaysReadable(t *testing.T) {
	admissible := []string{
		"",
		"hi",
		"ünïcødé",
		"日本語",
		"\U0001F600",           // astral
		"a\U0010FFFFz",         // max scalar value
		"\x00",                 // NUL is a scalar value and is admissible
		"é",                   // e + COMBINING ACUTE — never normalized (§5.2)
		strings.Repeat("é", 8), // multi-byte, repeated
	}
	for _, s := range admissible {
		v, err := EncodeText(s)
		if err != nil {
			t.Fatalf("EncodeText(%q) rejected an admissible string: %v", s, err)
		}
		got, err := ReadText(v)
		if err != nil {
			t.Fatalf("law 1 violated: ReadText refused EncodeText's own output for %q: %v", s, err)
		}
		if got != s {
			t.Errorf("round-trip changed the datum: got %q, want %q", got, s)
		}
	}
}

// REGRESSION GUARD, with a positive control. The old behavior emitted the invalid
// bytes verbatim; this asserts that exact value is never produced, and separately
// proves the value IS constructible and IS rejected by ReadText — so the test
// exercises the producer, not an inability to build the value.
func TestEncodeTextNeverMintsAnUnreadableValue(t *testing.T) {
	bad := string([]byte{0x80})

	if _, err := EncodeText(bad); err == nil {
		t.Fatal("EncodeText must reject invalid UTF-8")
	}

	// Positive control: the value the old code produced is constructible...
	verbatim := core.NewTuple(core.NewAtom([]byte(labelText)), core.NewAtom([]byte(bad)))
	// ...and this package's own reader refuses it. That refusal is the whole defect:
	// a producer that emits it is unsound by law 1.
	if _, err := ReadText(verbatim); err == nil {
		t.Fatal("control failed: ReadText accepted an invalid-UTF-8 payload, so this test could not detect the defect")
	}
}

// §5.2: the fix must REJECT, never repair. A producer that substituted U+FFFD (the
// TypeScript core's former behavior) would pass a naive "does it round-trip?" test
// while silently changing the datum, so pin the substitution explicitly.
func TestEncodeTextDoesNotSubstituteReplacementChar(t *testing.T) {
	bad := string([]byte{0x80})
	v, err := EncodeText(bad)
	if err == nil {
		t.Fatalf("expected rejection, got %v", v)
	}
	// The replacement-character value is a well-formed utf8-text — which is exactly
	// why substituting would be undetectable downstream.
	subst := core.NewTuple(core.NewAtom([]byte(labelText)), core.NewAtom([]byte("�")))
	if got, err := ReadText(subst); err != nil || got != "�" {
		t.Fatalf("control: the substituted value should be well-formed and read as U+FFFD; got %q, %v", got, err)
	}
}

func TestMustEncodeTextPanicsRatherThanMintingAnUnreadableValue(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("MustEncodeText must panic on invalid UTF-8, not return an unreadable value")
		}
	}()
	_ = MustEncodeText(string([]byte{0x80}))
}
