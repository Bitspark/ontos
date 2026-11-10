//! Shallow values cost no work stack (Bitspark/ontos#31).
//!
//! `Clone`, `PartialEq`, `Hash` and dropping walk a value with an explicit heap stack, so a value of
//! any depth is safe (ontos-internal#340). An atom, or a tuple whose items are all atoms, needs no
//! such stack: cloning one allocates exactly the buffers the clone owns, and comparing, hashing or
//! dropping one allocates nothing. A counting global allocator pins this. Its counters are
//! per thread, so tests running in parallel do not see each other's allocations.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::hint::black_box;

use ontos_core::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Counts {
    allocs: usize,
    alloc_bytes: usize,
    reallocs: usize,
    deallocs: usize,
}

thread_local! {
    static COUNTS: Cell<Counts> = const {
        Cell::new(Counts { allocs: 0, alloc_bytes: 0, reallocs: 0, deallocs: 0 })
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
        record(|c| {
            c.allocs += 1;
            c.alloc_bytes += layout.size();
        });
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(|c| {
            c.allocs += 1;
            c.alloc_bytes += layout.size();
        });
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

/// The heap buffers a shallow value owns, as (count, bytes): one per non-empty atom, holding its
/// bytes, and one per non-empty tuple, holding its items. Empty ones own no buffer.
fn owned_buffers(value: &Value) -> (usize, usize) {
    match value {
        Value::Atom(atom) if atom.is_empty() => (0, 0),
        Value::Atom(atom) => (1, atom.len()),
        Value::Tuple(tuple) => {
            let own = if tuple.is_empty() {
                (0, 0)
            } else {
                (1, tuple.len() * size_of::<Value>())
            };
            tuple
                .items()
                .iter()
                .map(owned_buffers)
                .fold(own, |a, b| (a.0 + b.0, a.1 + b.1))
        }
    }
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

/// Also the positive control: these counts are not zero, so the counter is live on this thread.
#[test]
fn cloning_a_shallow_value_allocates_only_the_clone() {
    for value in shallow_values() {
        let (clone, counts) = measure(|| black_box(&value).clone());
        let (buffers, bytes) = owned_buffers(&value);
        assert_eq!(
            counts,
            Counts {
                allocs: buffers,
                alloc_bytes: bytes,
                reallocs: 0,
                deallocs: 0,
            },
            "clone of {value}"
        );
        assert!(clone == value);
    }
}

#[test]
fn comparing_shallow_values_allocates_nothing() {
    let values = shallow_values();
    for a in &values {
        for b in &values {
            let (equal, counts) = measure(|| black_box(a) == black_box(b));
            assert_eq!(counts, Counts::default(), "{a} == {b}");
            assert_eq!(equal, std::ptr::eq(a, b), "{a} == {b}");
        }
        // A deep value on the other side: a shallow left side settles it without a walk.
        let deep = Value::tuple([Value::tuple([a.clone()])]);
        let (equal, counts) = measure(|| black_box(a) == black_box(&deep));
        assert_eq!(counts, Counts::default(), "{a} == {deep}");
        assert!(!equal);
    }
}

#[test]
fn hashing_a_shallow_value_allocates_nothing() {
    for value in shallow_values() {
        let mut hasher = DefaultHasher::new();
        let ((), counts) = measure(|| black_box(&value).hash(&mut hasher));
        assert_eq!(counts, Counts::default(), "hash of {value}");
        black_box(hasher.finish());
    }
}

#[test]
fn dropping_a_shallow_value_only_frees_its_own_buffers() {
    for value in shallow_values() {
        let (buffers, _) = owned_buffers(&value);
        let shown = value.to_string();
        let ((), counts) = measure(|| drop(black_box(value)));
        assert_eq!(
            counts,
            Counts {
                deallocs: buffers,
                ..Counts::default()
            },
            "drop of {shown}"
        );
    }
}
