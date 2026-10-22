//! Rust ownership convenience: the finite values and their identity stay unchanged.

use ontos_core::{Tuple, Value};

#[test]
fn consuming_a_tuple_preserves_empty_children_order_and_multiplicity() {
    assert!(Tuple::new([]).into_items().is_empty());

    let tuple = Tuple::new([
        Value::atom([]),
        Value::tuple([]),
        Value::atom([0x61]),
        Value::atom([0x61]),
        Value::tuple([Value::atom([0x62]), Value::atom([0x63])]),
    ]);
    assert_eq!(
        tuple.into_items(),
        vec![
            Value::atom([]),
            Value::tuple([]),
            Value::atom([0x61]),
            Value::atom([0x61]),
            Value::tuple([Value::atom([0x62]), Value::atom([0x63])]),
        ]
    );
}

#[test]
fn consuming_a_tuple_transfers_its_existing_vector_and_descendant_storage() {
    let tuple = Tuple::new([
        Value::atom(vec![0x61; 257]),
        Value::tuple([Value::atom(vec![0x62; 129]), Value::tuple([])]),
    ]);
    let children = tuple.items().as_ptr();
    let first_payload = tuple.at(0).unwrap().as_atom().unwrap().bytes().as_ptr();
    let nested = tuple.at(1).unwrap().as_tuple().unwrap();
    let nested_children = nested.items().as_ptr();
    let nested_payload = nested.at(0).unwrap().as_atom().unwrap().bytes().as_ptr();

    let owned = tuple.into_items();
    assert_eq!(owned.as_ptr(), children);
    assert_eq!(owned[0].as_atom().unwrap().bytes().as_ptr(), first_payload);
    let nested = owned[1].as_tuple().unwrap();
    assert_eq!(nested.items().as_ptr(), nested_children);
    assert_eq!(
        nested.at(0).unwrap().as_atom().unwrap().bytes().as_ptr(),
        nested_payload
    );
}

fn nested(depth: usize, byte: u8) -> Value {
    let mut value = Value::atom([byte]);
    for _ in 0..depth {
        value = Value::tuple([value]);
    }
    value
}

#[test]
fn returned_children_and_a_partly_consumed_iterator_drop_on_a_small_stack() {
    std::thread::Builder::new()
        .stack_size(64 * 1024)
        .spawn(|| {
            let tuple = Tuple::new([nested(20_000, 0x61), nested(20_000, 0x62)]);
            let owned = tuple.into_items();
            assert_eq!(owned.len(), 2);
            drop(owned);

            let tuple = Tuple::new([
                nested(20_000, 0x63),
                Value::atom([0x64]),
                nested(20_000, 0x65),
            ]);
            let mut remaining = tuple.into_items().into_iter();
            drop(remaining.next().unwrap());
            assert_eq!(remaining.len(), 2);
            drop(remaining);
        })
        .unwrap()
        .join()
        .unwrap();
}
