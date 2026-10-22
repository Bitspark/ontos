use ontos_codec::{
    decode_with_limits, encode, encode_uvarint, DecodeError, DecodeEvent, DecodeLimits,
    EventDecodeError, EventDecoder,
};

fn write_event(event: DecodeEvent<'_>, bytes: &mut Vec<u8>) {
    match event {
        DecodeEvent::TupleStart { arity } => {
            bytes.push(1);
            encode_uvarint(arity as u64, bytes);
        }
        DecodeEvent::AtomStart { length } => {
            bytes.push(0);
            encode_uvarint(length as u64, bytes);
        }
        DecodeEvent::AtomChunk(chunk) => bytes.extend_from_slice(chunk),
        DecodeEvent::TupleEnd | DecodeEvent::AtomEnd => {}
    }
}

fn partition(
    bytes: &[u8],
    limits: DecodeLimits,
    cuts: &[usize],
) -> Result<Vec<u8>, EventDecodeError> {
    let mut output = Vec::new();
    let mut sink = |event| write_event(event, &mut output);
    let mut decoder = EventDecoder::new(bytes.len(), limits);
    let mut start = 0;
    for &end in cuts {
        decoder = decoder.push(&bytes[start..end], &mut sink)?;
        start = end;
    }
    decoder = decoder.push(&bytes[start..], &mut sink)?;
    decoder.finish()?;
    Ok(output)
}

fn assert_partitions(bytes: &[u8], limits: DecodeLimits, expected: Result<(), DecodeError>) {
    assert_eq!(decode_with_limits(bytes, limits).map(|_| ()), expected);
    let expected = expected.map(|_| bytes.to_vec()).map_err(EventDecodeError::Codec);
    // Every two-cut partition includes empty chunks, splits inside headers and
    // payloads, and splits immediately before a parent's closing transition.
    for first in 0..=bytes.len() {
        for second in first..=bytes.len() {
            assert_eq!(partition(bytes, limits, &[first, second]), expected,
                "bytes={bytes:?}, cuts={first},{second}");
        }
    }
    let every_byte: Vec<_> = (0..=bytes.len()).collect();
    assert_eq!(partition(bytes, limits, &every_byte), expected);
}

#[test]
fn progressive_nested_empty_values_preserve_order_at_every_split() {
    // Tuple(Atom(), Tuple(), Tuple(Atom(0xff), Atom(0x0061)), Atom()).
    let bytes = [1, 4, 0, 0, 1, 0, 1, 2, 0, 1, 0xff, 0, 2, 0, 0x61, 0, 0];
    assert_partitions(&bytes, DecodeLimits::default(), Ok(()));
    let value = decode_with_limits(&bytes, DecodeLimits::default()).unwrap();
    assert_eq!(encode(&value), bytes);
}

#[test]
fn progressive_events_close_empty_and_nested_values_without_more_input() {
    let bytes = [1, 2, 0, 0, 1, 1, 1, 0];
    let mut events = Vec::new();
    let decoder = EventDecoder::new(bytes.len(), DecodeLimits::default())
        .push(&bytes, &mut |event| {
            assert!(!matches!(event, DecodeEvent::AtomChunk(_)));
            // These events have no borrowed payload.
            events.push(match event {
                DecodeEvent::TupleStart { arity } => ("tuple", arity),
                DecodeEvent::TupleEnd => ("end tuple", 0),
                DecodeEvent::AtomStart { length } => ("atom", length),
                DecodeEvent::AtomEnd => ("end atom", 0),
                DecodeEvent::AtomChunk(_) => unreachable!(),
            });
        }).unwrap();
    assert_eq!(events, [
        ("tuple", 2), ("atom", 0), ("end atom", 0), ("tuple", 1),
        ("tuple", 0), ("end tuple", 0), ("end tuple", 0), ("end tuple", 0),
    ]);
    decoder.finish().unwrap();
}

#[test]
fn progressive_logical_extent_preserves_eof_before_child_errors() {
    let defaults = DecodeLimits::default();
    assert_partitions(&[1, 2, 0xff, 0], defaults, Err(DecodeError::UnexpectedEof));
    assert_partitions(&[1, 2, 0xff, 0, 0, 0], defaults,
        Err(DecodeError::UnknownTag { tag: 0xff, offset: 2 }));
    assert_partitions(&[0, 3, 0xff], defaults, Err(DecodeError::UnexpectedEof));
    assert_partitions(&[1, 1], DecodeLimits { max_depth: 0, ..defaults },
        Err(DecodeError::UnexpectedEof));
    assert_partitions(&[1, 1, 0xff, 0], DecodeLimits { max_depth: 0, ..defaults },
        Err(DecodeError::LimitExceeded { limit: "decode depth", value: 1, max: 0 }));
}

#[test]
fn progressive_field_limits_precede_extent_checks_and_keep_exact_fields() {
    let limits = DecodeLimits { max_atom_bytes: 1, max_tuple_arity: 1, ..DecodeLimits::default() };
    assert_partitions(&[0, 2], limits,
        Err(DecodeError::LimitExceeded { limit: "atom byte length", value: 2, max: 1 }));
    assert_partitions(&[1, 2], limits,
        Err(DecodeError::LimitExceeded { limit: "tuple arity", value: 2, max: 1 }));
    assert_partitions(&[0, 0x80, 0], limits,
        Err(DecodeError::NonCanonicalUvarint { offset: 1 }));
}

#[test]
fn progressive_varint_tenth_continuation_and_eleventh_byte_are_distinct() {
    let defaults = DecodeLimits::default();
    let mut bytes = vec![0];
    bytes.extend_from_slice(&[0x80; 10]);
    assert_partitions(&bytes, defaults, Err(DecodeError::UnexpectedEof));
    bytes.push(0);
    assert_partitions(&bytes, defaults, Err(DecodeError::UvarintOverflow { offset: 1 }));
    bytes.truncate(10);
    bytes.push(2);
    assert_partitions(&bytes, defaults, Err(DecodeError::UvarintOverflow { offset: 1 }));
    bytes[10] = 0;
    assert_partitions(&bytes, defaults, Err(DecodeError::NonCanonicalUvarint { offset: 1 }));
}

#[test]
fn progressive_empty_input_truncation_and_trailing_offsets_match_buffers() {
    let defaults = DecodeLimits::default();
    for bytes in [&[][..], &[0][..], &[1][..], &[0, 0x80][..], &[1, 0x80][..]] {
        assert_partitions(bytes, defaults, Err(DecodeError::UnexpectedEof));
    }
    assert_partitions(&[0, 0, 0xff], defaults, Err(DecodeError::TrailingBytes { offset: 2 }));
    assert_partitions(&[1, 1, 0, 0, 0xff], defaults,
        Err(DecodeError::TrailingBytes { offset: 4 }));
}

#[test]
fn progressive_native_narrowing_precedes_configured_field_limits() {
    for tag in [0, 1] {
        let mut bytes = vec![tag];
        encode_uvarint(1 << 60, &mut bytes);
        let label = if tag == 0 { "atom byte length" } else { "tuple arity" };
        let limits = DecodeLimits { max_atom_bytes: 1, max_tuple_arity: 1, ..DecodeLimits::default() };
        let max = if cfg!(target_pointer_width = "32") { usize::MAX as u64 } else { 1 };
        assert_partitions(&bytes, limits,
            Err(DecodeError::LimitExceeded { limit: label, value: 1 << 60, max }));
    }
}

#[test]
fn progressive_underfill_is_a_transfer_error_not_codec_eof() {
    let mut chunks = 0;
    let decoder = EventDecoder::new(4, DecodeLimits::default())
        .push(&[0, 2, 0x61], &mut |event| {
            if matches!(event, DecodeEvent::AtomChunk(_)) { chunks += 1; }
        }).unwrap();
    assert_eq!(chunks, 1);
    assert_eq!(decoder.finish(), Err(EventDecodeError::InputUnderfill { expected: 4, received: 3 }));
    // The same supplied bytes declared as the complete input are codec EOF.
    assert_partitions(&[0, 2, 0x61], DecodeLimits::default(), Err(DecodeError::UnexpectedEof));
    assert_eq!(EventDecoder::new(1, DecodeLimits::default()).finish(),
        Err(EventDecodeError::InputUnderfill { expected: 1, received: 0 }));
    assert_eq!(EventDecoder::new(0, DecodeLimits::default()).finish(),
        Err(EventDecodeError::Codec(DecodeError::UnexpectedEof)));
}

#[test]
fn progressive_overrun_rejects_the_entire_chunk_before_events() {
    let mut events = 0;
    let mut sink = |_| { events += 1; };
    let decoder = EventDecoder::new(4, DecodeLimits::default()).push(&[0], &mut sink).unwrap();
    let error = decoder.push(&[2, 0x61, 0x62, 0xff], &mut sink).unwrap_err();
    assert_eq!(error, EventDecodeError::InputOverrun { remaining: 3, supplied: 4 });
    assert_eq!(events, 0);
    // Reject by subtraction, including totals at the native counter ceiling.
    let decoder = EventDecoder::new(usize::MAX, DecodeLimits::default());
    assert_eq!(decoder.finish(), Err(EventDecodeError::InputUnderfill {
        expected: usize::MAX, received: 0,
    }));
}

#[test]
fn progressive_provisional_sink_state_does_not_mask_late_codec_errors() {
    let bytes = [1, 2, 0, 1, 0x61, 0xff, 0];
    let mut declined = false;
    let mut retained_bytes = Vec::new();
    let mut sink = |event| {
        if declined { return; }
        if let DecodeEvent::AtomChunk(chunk) = event {
            retained_bytes.extend_from_slice(chunk);
            declined = true;
        }
    };
    let decoder = EventDecoder::new(bytes.len(), DecodeLimits::default())
        .push(&bytes[..5], &mut sink).unwrap();
    let error = decoder.push(&bytes[5..], &mut sink).unwrap_err();
    assert_eq!(error, EventDecodeError::Codec(DecodeError::UnknownTag { tag: 0xff, offset: 5 }));
    assert!(declined);
    assert_eq!(retained_bytes, [0x61]);
}

#[test]
#[cfg(panic = "unwind")]
fn progressive_sink_unwind_preserves_the_original_failure() {
    let marker = "sink's original failure";
    let result = std::panic::catch_unwind(|| {
        let decoder = EventDecoder::new(3, DecodeLimits::default());
        let _ = decoder.push(&[0, 1, 42], &mut |event| {
            if matches!(event, DecodeEvent::AtomChunk(_)) {
                std::panic::panic_any(marker);
            }
        });
    });
    assert_eq!(result.unwrap_err().downcast_ref::<&str>(), Some(&marker));
    // No global sink or partially reusable parser state survives the unwind.
    assert_partitions(&[0, 0], DecodeLimits::default(), Ok(()));
}

#[test]
fn progressive_large_atom_uses_borrowed_chunks_and_a_counting_sink() {
    const CHUNK: usize = 64 * 1024;
    const LENGTH: usize = 70 * 1024 * 1024;
    let mut header = vec![0];
    encode_uvarint(LENGTH as u64, &mut header);
    let payload = vec![0xa5; CHUNK];
    let mut starts = 0;
    let mut ends = 0;
    let mut count = 0;
    let mut sink = |event| match event {
        DecodeEvent::AtomStart { length } => { assert_eq!(length, LENGTH); starts += 1; }
        DecodeEvent::AtomChunk(bytes) => {
            assert_eq!(bytes.as_ptr(), payload.as_ptr());
            assert_eq!(bytes.len(), CHUNK);
            count += bytes.len();
        }
        DecodeEvent::AtomEnd => ends += 1,
        _ => panic!("atom fixture emitted a tuple event"),
    };
    let mut decoder = EventDecoder::new(header.len() + LENGTH, DecodeLimits::default())
        .push(&header, &mut sink).unwrap();
    for _ in 0..LENGTH / CHUNK {
        decoder = decoder.push(&payload, &mut sink).unwrap();
    }
    decoder.finish().unwrap();
    assert_eq!((starts, ends, count), (1, 1, LENGTH));
}

#[test]
fn progressive_large_tuple_counts_children_without_a_child_array() {
    const ARITY: usize = 1 << 20;
    let mut header = vec![1];
    encode_uvarint(ARITY as u64, &mut header);
    let children = [0u8; 4096]; // 2048 empty atoms, reused for every chunk.
    let mut atoms = 0;
    let mut tuple_ends = 0;
    let mut sink = |event| match event {
        DecodeEvent::TupleStart { arity } => assert_eq!(arity, ARITY),
        DecodeEvent::TupleEnd => tuple_ends += 1,
        DecodeEvent::AtomEnd => atoms += 1,
        DecodeEvent::AtomStart { length } => assert_eq!(length, 0),
        DecodeEvent::AtomChunk(_) => panic!("empty atoms have no chunks"),
    };
    let mut decoder = EventDecoder::new(header.len() + ARITY * 2, DecodeLimits::default())
        .push(&header, &mut sink).unwrap();
    for _ in 0..ARITY * 2 / children.len() {
        decoder = decoder.push(&children, &mut sink).unwrap();
    }
    decoder.finish().unwrap();
    assert_eq!((atoms, tuple_ends), (ARITY, 1));
}

#[test]
fn progressive_depth_default_is_exact_without_recursive_scanning() {
    for depth in [1024, 1025] {
        let mut bytes = Vec::new();
        for _ in 0..depth { bytes.extend_from_slice(&[1, 1]); }
        bytes.extend_from_slice(&[0, 0]);
        let cuts: Vec<_> = (0..=bytes.len()).collect();
        let result = partition(&bytes, DecodeLimits::default(), &cuts);
        if depth == 1024 {
            assert_eq!(result.unwrap(), bytes);
        } else {
            assert_eq!(result, Err(EventDecodeError::Codec(DecodeError::LimitExceeded {
                limit: "decode depth", value: 1025, max: 1024,
            })));
        }
    }
}
