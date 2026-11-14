use ontos_codec::encode;
use ontos_core::Value;
use ontos_data::{encode_text, encode_text_map, read_text_map};
use std::collections::BTreeSet;

#[test]
fn existing_bytes_and_codec_order() {
    let first = Value::atom(vec![0xff]);
    let second = Value::tuple(vec![]);
    let mut entries = vec![("aa".into(), second.clone()), ("b".into(), first.clone())];
    let value = encode_text_map(&entries).unwrap();
    // Independently spelled codec-v1: map, shorter key b, then aa.
    let hex: String = encode(&value).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "010300036d6170010201020009757466382d746578740001620001ff010201020009757466382d74657874000261610100");
    assert_eq!(
        read_text_map(&value).unwrap(),
        vec![("b".into(), first), ("aa".into(), second)]
    );
    entries.reverse();
    assert_eq!(value, encode_text_map(&entries).unwrap());
    assert!(read_text_map(&encode_text_map(&[]).unwrap())
        .unwrap()
        .is_empty());
}

#[test]
fn unicode_and_arbitrary_children() {
    let opaque = Value::tuple(vec![Value::atom(b"int".to_vec()), Value::atom(vec![0xff])]);
    let keys = [
        "",
        "__proto__",
        "constructor",
        "\0",
        "é",
        "e\u{301}",
        "😀",
        "\u{10ffff}",
    ];
    let entries: Vec<_> = keys
        .iter()
        .map(|key| ((*key).into(), opaque.clone()))
        .collect();
    let read = read_text_map(&encode_text_map(&entries).unwrap()).unwrap();
    assert_eq!(read.len(), keys.len());
    assert_eq!(
        read.iter()
            .map(|(key, _)| key.as_str())
            .collect::<BTreeSet<_>>(),
        keys.into_iter().collect()
    );
    assert!(read.iter().all(|(_, child)| child == &opaque));
}

#[test]
fn duplicate_intent_is_rejected() {
    let child = Value::tuple(vec![]);
    assert!(encode_text_map(&[("x".into(), child.clone()), ("x".into(), child)]).is_err());
    // Rust String excludes invalid Unicode; no unchecked byte-to-string conversion is used.
}

#[test]
fn reader_rejects_without_repair() {
    let label = Value::atom(b"map".to_vec());
    let child = Value::tuple(vec![]);
    let a = encode_text("a");
    let b = encode_text("b");
    let pair = |key: Value| Value::tuple(vec![key, child.clone()]);
    let malformed = vec![
        Value::atom(vec![]),
        Value::tuple(vec![]),
        Value::tuple(vec![label.clone(), Value::tuple(vec![a.clone()])]),
        Value::tuple(vec![label.clone(), pair(b), pair(a.clone())]),
        Value::tuple(vec![label.clone(), pair(a.clone()), pair(a)]),
        Value::tuple(vec![label.clone(), pair(Value::atom(vec![]))]),
        Value::tuple(vec![
            label,
            pair(Value::tuple(vec![
                Value::atom(b"utf8-text".to_vec()),
                Value::atom(vec![0xff]),
            ])),
        ]),
    ];
    for value in malformed {
        assert!(read_text_map(&value).is_err());
    }
}
