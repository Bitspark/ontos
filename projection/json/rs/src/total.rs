//! `ontos-total-json/1` (`docs/spec/ontos-total-json.md`): every ground value, node for
//! node, as `{"atom":"<lowercase hex>"}` or `{"tuple":[…]}`.
//!
//! ```
//! use ontos_core::Value;
//! use ontos_json::total;
//!
//! let value = total::parse_utf8(br#"{"tuple":[{"atom":"6f6b"}]}"#, &total::DEFAULT_LIMITS)?;
//! assert_eq!(value, Value::tuple([Value::atom(*b"ok")]));
//! let text = total::render_utf8(&value, &total::DEFAULT_LIMITS)?;
//! assert_eq!(text, br#"{"tuple":[{"atom":"6f6b"}]}"#);
//! # Ok::<(), ontos_json::Error>(())
//! ```

use ontos_core::Value;

pub use crate::error::{Code, Error, LimitKind, Profile, Segment, Span};
pub use crate::limits::{Limits, UNBOUNDED};

use crate::interp::{interpret, Mode};
use crate::{text, write};

/// The profile id.
pub const PROFILE: &str = "ontos-total-json/1";

/// This profile's shipped defaults (total §9.2): value depth 1024, JSON depth derived
/// from it (2050), everything else unbounded. `max_integer_digits` is never checked here.
pub const DEFAULT_LIMITS: Limits = Limits {
    max_text_bytes: UNBOUNDED,
    max_json_depth: None,
    max_value_depth: 1024,
    max_atom_bytes: UNBOUNDED,
    max_tuple_arity: UNBOUNDED,
    max_integer_digits: UNBOUNDED,
};

/// Reads `input`, the exact bytes of a text, as a value (total §4): size, UTF-8, the
/// strict JSON reading, then the total form, each stage completing before the next.
pub fn parse_utf8(input: &[u8], limits: &Limits) -> Result<Value, Error> {
    let tree = text::read(
        input,
        limits.max_text_bytes,
        limits.json_depth(Profile::Total),
    )
    .map_err(|fault| fault.into_error(Profile::Total))?;
    interpret(&tree, Mode::Total, limits, false)
        .map(|interpreted| interpreted.value)
        .map_err(|fault| fault.into_error(Profile::Total))
}

/// Reads a `&str`. It is well-formed UTF-8 by construction, so this reads its bytes with
/// [`parse_utf8`].
pub fn parse_str(input: &str, limits: &Limits) -> Result<Value, Error> {
    parse_utf8(input.as_bytes(), limits)
}

/// Writes the preferred spelling of `value` (total §5): ASCII, no whitespace, no trailing
/// newline. The limits are checked as the reader would check them (total §9.3).
pub fn render_utf8(value: &Value, limits: &Limits) -> Result<Vec<u8>, Error> {
    write::render(value, limits, limits.json_depth(Profile::Total), true)
        .map_err(|fault| fault.into_error(Profile::Total))
}
