//! Moving a tuple's children and reconstructing it preserves the frozen codec bytes.

use ontos_codec::{decode, encode};
use ontos_core::Value;

fn assert_reconstructed_bytes(bytes: &[u8]) {
    let Value::Tuple(tuple) = decode(bytes).unwrap() else {
        panic!("the fixture must be a tuple");
    };
    let reconstructed = Value::tuple(tuple.into_items());
    assert_eq!(encode(&reconstructed).as_slice(), bytes);
}

#[test]
fn ownership_transfer_preserves_canonical_empty_nested_and_repeated_values() {
    assert_reconstructed_bytes(&[0x01, 0x00]);
    // Tuple(Atom(), Tuple(), Atom(0x61), Atom(0x61)).
    assert_reconstructed_bytes(&[
        0x01, 0x04, 0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x61, 0x00, 0x01, 0x61,
    ]);
    // Tuple(Tuple(Atom(0x00ff)), Atom(0x80)).
    assert_reconstructed_bytes(&[
        0x01, 0x02, 0x01, 0x01, 0x00, 0x02, 0x00, 0xff, 0x00, 0x01, 0x80,
    ]);
}

#[test]
fn ownership_transfer_preserves_tuple_arity_uvarint_boundaries() {
    for (arity, header) in [
        (127, vec![0x01, 0x7f]),
        (128, vec![0x01, 0x80, 0x01]),
        (16_384, vec![0x01, 0x80, 0x80, 0x01]),
    ] {
        let mut bytes = header;
        for _ in 0..arity {
            bytes.extend_from_slice(&[0x00, 0x00]);
        }
        assert_reconstructed_bytes(&bytes);
    }
}
