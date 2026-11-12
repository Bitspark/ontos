//! `ontos-readable-json/1` (`docs/spec/ontos-readable-json.md`): the common ground values
//! as ordinary JSON, everything else through the one reserved envelope
//! `{"$ontos":[tag,…]}`.
//!
//! ```
//! use ontos_codec::encode;
//! use ontos_data::{encode_int, encode_list, encode_text};
//! use ontos_json::readable;
//!
//! let value = readable::parse_utf8(br#"[257,"hi"]"#, &readable::DEFAULT_LIMITS)?;
//! assert_eq!(encode(&value), encode(&encode_list(&[encode_int(257), encode_text("hi")])));
//! let big = readable::render_utf8(&encode_int(1 << 60), &readable::DEFAULT_LIMITS)?;
//! assert_eq!(big, br#"{"$ontos":["int","1152921504606846976"]}"#);
//! # Ok::<(), ontos_json::Error>(())
//! ```

use ontos_core::Value;

pub use crate::error::{Code, Error, LimitKind, Profile, Segment, Span};
pub use crate::limits::{Limits, UNBOUNDED};
pub use crate::origins::{Iter, Origin, Origins, Parsed};

use crate::interp::{interpret, Mode};
use crate::{origins, text, write};

/// The profile id.
pub const PROFILE: &str = "ontos-readable-json/1";

/// This profile's shipped defaults (readable §9): value depth 1024, JSON depth derived
/// from it (3076), 4300 integer digits, everything else unbounded.
pub const DEFAULT_LIMITS: Limits = Limits {
    max_text_bytes: UNBOUNDED,
    max_json_depth: None,
    max_value_depth: 1024,
    max_atom_bytes: UNBOUNDED,
    max_tuple_arity: UNBOUNDED,
    max_integer_digits: 4300,
};

/// Reads `input`, the exact bytes of a text, as a value (readable §4).
pub fn parse_utf8(input: &[u8], limits: &Limits) -> Result<Value, Error> {
    read(input, limits, false).map(|(value, _)| value)
}

/// Reads a `&str`. It is well-formed UTF-8 by construction, so this reads its bytes with
/// [`parse_utf8`]. Readable input is read from its source bytes (readable §10.1): pass a
/// string here only if it never went through a lossy decoding.
pub fn parse_str(input: &str, limits: &Limits) -> Result<Value, Error> {
    parse_utf8(input.as_bytes(), limits)
}

/// Reads `input` as [`parse_utf8`] does, and returns the origins of every value node too
/// (readable §10.2).
pub fn parse_utf8_with_origins(input: &[u8], limits: &Limits) -> Result<Parsed, Error> {
    read(input, limits, true).map(|(value, origins)| Parsed {
        value,
        origins: origins.expect("origins were recorded"),
    })
}

fn read(input: &[u8], limits: &Limits, record: bool) -> Result<(Value, Option<Origins>), Error> {
    let tree = text::read(
        input,
        limits.max_text_bytes,
        limits.json_depth(Profile::Readable),
    )
    .map_err(|fault| fault.into_error(Profile::Readable))?;
    let interpreted = interpret(&tree, Mode::Readable, limits, record)
        .map_err(|fault| fault.into_error(Profile::Readable))?;
    let origins = record.then(|| origins::build(&tree, &interpreted));
    Ok((interpreted.value, origins))
}

/// Writes the preferred spelling of `value` (readable §2, §5). The limits are checked as
/// the reader would check them (readable §9, total §9.3).
pub fn render_utf8(value: &Value, limits: &Limits) -> Result<Vec<u8>, Error> {
    write::render(value, limits, limits.json_depth(Profile::Readable), false)
        .map_err(|fault| fault.into_error(Profile::Readable))
}
