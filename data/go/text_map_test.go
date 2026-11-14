package data

import (
	"encoding/hex"
	"errors"
	"reflect"
	"testing"

	"github.com/bitspark/ontos/codec/go"
	"github.com/bitspark/ontos/core/go"
)

func TestTextMapExistingBytesAndCodecOrder(t *testing.T) {
	first, second := core.NewAtom([]byte{0xff}), core.NewTuple()
	entries := []TextMapEntry{{Key: "aa", Value: second}, {Key: "b", Value: first}}
	value, err := EncodeTextMap(entries)
	if err != nil {
		t.Fatal(err)
	}
	// Independently spelled codec-v1: map, shorter key b, then aa.
	want := "010300036d6170010201020009757466382d746578740001620001ff010201020009757466382d74657874000261610100"
	if got := hex.EncodeToString(codec.Encode(value)); got != want {
		t.Fatalf("bytes = %s, want %s", got, want)
	}
	read, err := ReadTextMap(value)
	if err != nil {
		t.Fatal(err)
	}
	if len(read) != 2 || read[0].Key != "b" || read[1].Key != "aa" || !core.Equal(read[0].Value, first) || !core.Equal(read[1].Value, second) {
		t.Fatalf("read = %v", read)
	}
	entries[0], entries[1] = entries[1], entries[0]
	reordered, err := EncodeTextMap(entries)
	if err != nil || !core.Equal(value, reordered) {
		t.Fatalf("reordering changed value: %v", err)
	}
	empty, err := EncodeTextMap(nil)
	if err != nil {
		t.Fatal(err)
	}
	read, err = ReadTextMap(empty)
	if err != nil || len(read) != 0 {
		t.Fatalf("empty map = %v, %v", read, err)
	}
}

func TestTextMapUnicodeAndArbitraryChildren(t *testing.T) {
	opaque := core.NewTuple(core.NewAtom([]byte("int")), core.NewAtom([]byte{0xff}))
	keys := []string{"", "__proto__", "constructor", "\x00", "é", "e\u0301", "😀", "\U0010ffff"}
	entries := make([]TextMapEntry, len(keys))
	want := map[string]bool{}
	for i, key := range keys {
		entries[i] = TextMapEntry{Key: key, Value: opaque}
		want[key] = true
	}
	value, err := EncodeTextMap(entries)
	if err != nil {
		t.Fatal(err)
	}
	read, err := ReadTextMap(value)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, entry := range read {
		got[entry.Key] = true
		if !core.Equal(entry.Value, opaque) {
			t.Fatal("arbitrary child changed")
		}
	}
	if len(read) != len(keys) || !reflect.DeepEqual(got, want) {
		t.Fatalf("keys changed: %v", got)
	}
}

func TestTextMapRejectsDuplicateAndInvalidUnicode(t *testing.T) {
	child := core.NewTuple()
	for _, entries := range [][]TextMapEntry{
		{{Key: "x", Value: child}, {Key: "x", Value: child}},
		{{Key: string([]byte{0xff}), Value: child}},
		{{Key: string([]byte{0xed, 0xa0, 0x80}), Value: child}},
	} {
		value, err := EncodeTextMap(entries)
		var de *DataError
		if value != nil || !errors.As(err, &de) {
			t.Fatalf("want DataError without value; got %v, %v", value, err)
		}
	}
}

func TestTextMapReaderRejectsWithoutRepair(t *testing.T) {
	label, child := core.NewAtom([]byte("map")), core.NewTuple()
	a, _ := EncodeText("a")
	b, _ := EncodeText("b")
	for _, value := range []core.Value{
		core.NewAtom(nil), core.NewTuple(), core.NewTuple(label, core.NewTuple(a)),
		core.NewTuple(label, core.NewTuple(b, child), core.NewTuple(a, child)),
		core.NewTuple(label, core.NewTuple(a, child), core.NewTuple(a, child)),
		core.NewTuple(label, core.NewTuple(core.NewAtom(nil), child)),
		core.NewTuple(label, core.NewTuple(core.NewTuple(core.NewAtom([]byte("utf8-text")), core.NewAtom([]byte{0xff})), child)),
	} {
		read, err := ReadTextMap(value)
		var de *DataError
		if read != nil || !errors.As(err, &de) {
			t.Fatalf("want DataError without entries; got %v, %v", read, err)
		}
	}
}
