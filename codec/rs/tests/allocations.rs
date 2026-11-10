//! Encoding a shallow value costs no work stack (Bitspark/ontos#31).
//!
//! `encode` walks with an explicit heap stack, so a value of any depth is safe
//! (ontos-internal#340). An atom, or a tuple whose items are all atoms, needs no such stack:
//! encoding one allocates its output buffer and nothing else. A counting global allocator pins
//! this. Its counters are per thread, so tests running in parallel do not see each other's
//! allocations.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::hint::black_box;

use ontos_codec::{decode, encode};
use ontos_core::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Counts {
    allocs: usize,
    reallocs: usize,
    deallocs: usize,
}

thread_local! {
    static COUNTS: Cell<Counts> = const {
        Cell::new(Counts { allocs: 0, reallocs: 0, deallocs: 0 })
    };
}

fn record(change: impl FnOnce(&mut Counts)) {
    // `try_with`: an allocator must not panic, even while the thread is being torn down.
    let _ = COUNTS.try_with(|cell| {
        let mut counts = cell.get();
        change(&mut counts);
        cell.set(counts);
    });
}

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(|c| c.allocs += 1);
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(|c| c.allocs += 1);
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        record(|c| c.reallocs += 1);
        unsafe { System.realloc(ptr, layout, new_size) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        record(|c| c.deallocs += 1);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Runs `f` and returns what it allocated on this thread.
fn measure<R>(f: impl FnOnce() -> R) -> (R, Counts) {
    COUNTS.with(|cell| cell.set(Counts::default()));
    let result = f();
    (result, COUNTS.with(Cell::get))
}

fn atoms() -> Vec<Value> {
    vec![
        Value::atom([]),
        Value::atom([0x61]),
        Value::atom([0x62; 32]),
        Value::atom([0x63; 300]),
    ]
}

/// Atoms, and tuples whose items are all atoms: the empty tuple, a single item, the canonical-key
/// pair a consumer builds per fact, and a wider tuple that includes the empty atom.
fn shallow_values() -> Vec<Value> {
    let mut values = atoms();
    values.push(Value::tuple([]));
    values.push(Value::tuple([Value::atom([0x61])]));
    values.push(Value::tuple([
        Value::atom([0x6b; 16]),
        Value::atom([0x76; 16]),
    ]));
    values.push(Value::tuple(atoms().into_iter().chain(atoms())));
    values
}

/// One buffer is allocated and none is freed, so the only buffer encode creates is the one it
/// returns; a realloc can only be that buffer growing. A work stack would be a second allocation,
/// freed before encode returns.
#[test]
fn encoding_a_shallow_value_allocates_only_its_output() {
    for value in shallow_values() {
        let (bytes, counts) = measure(|| encode(black_box(&value)));
        assert_eq!(counts.allocs, 1, "allocations encoding {value}: {counts:?}");
        assert_eq!(counts.deallocs, 0, "frees encoding {value}: {counts:?}");
        assert!(decode(&bytes).unwrap() == value);
    }
}

/// The per-fact path a consumer reported (Bitspark/ontos#31): clone two atom arguments, put them
/// in a tuple and encode it. What survives is exactly the two atoms' buffers, the tuple's item
/// buffer and the output; nothing is created and freed along the way.
#[test]
fn a_canonical_key_allocates_only_what_it_keeps() {
    let subject = Value::atom([0x73; 16]);
    let object = Value::atom([0x6f; 24]);
    let (bytes, counts) = measure(|| {
        let key = Value::tuple([black_box(&subject).clone(), black_box(&object).clone()]);
        let bytes = encode(&key);
        (key, bytes)
    });
    assert_eq!(counts.allocs, 4, "{counts:?}");
    assert_eq!(counts.deallocs, 0, "{counts:?}");
    let (key, bytes) = bytes;
    assert_eq!(bytes.len(), 2 + (2 + 16) + (2 + 24));
    assert!(decode(&bytes).unwrap() == key);
}
