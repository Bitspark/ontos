//! The two JSON projections of ontos ground values (design record 0010):
//!
//! - [`total`]: `ontos-total-json/1` (`docs/spec/ontos-total-json.md`), the total form
//!   `{"atom":"<hex>"} | {"tuple":[…]}`, node for node.
//! - [`readable`]: `ontos-readable-json/1` (`docs/spec/ontos-readable-json.md`), ordinary
//!   JSON for `null`, booleans, text, safe integers, lists and text-keyed maps, and the
//!   envelope `{"$ontos":[tag,…]}` for everything else, with origins.
//!
//! Both are total over L0: every value has exactly one preferred spelling, and every
//! accepted text denotes exactly one value. A JSON profile is a presentation: the value is
//! recovered from it before any identity operation, and identity, hashing and signing use
//! the codec bytes of the recovered value, never the JSON text.
//!
//! A reader takes the input as bytes and runs four stages in order (total §4.1): size,
//! well-formed UTF-8, the strict JSON reading (shared by both profiles, in a crate-internal
//! lexer), then the profile's interpretation. The first refusal ends the reading, and it
//! is an [`Error`] with the profile, a stable [`Code`], a typed [`Segment`] path, a UTF-8
//! byte [`Span`] and, for `limit_exceeded`, a [`LimitKind`]. A writer emits the preferred
//! spelling and checks the same [`Limits`] in the same order, as the reader's mirror.
//!
//! No step relies on native recursion: the lexer, both interpreters and both writers keep
//! explicit stacks, so the depth of a value is bounded only by the limits (total §9.2).
//! No integer passes through `i128`: decimal text converts to and from the sign-magnitude
//! bytes of `ontos-data` §5.1 at any magnitude, bounded by `max_integer_digits`.

#![forbid(unsafe_code)]

mod digits;
mod error;
mod interp;
mod lex;
mod limits;
mod origins;
mod text;
mod write;

pub mod readable;
pub mod total;

pub use error::{Code, Error, LimitKind, Profile, Segment, Span};
pub use limits::{Limits, UNBOUNDED};
