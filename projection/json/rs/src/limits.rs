//! The limits record shared by both profiles (total §9, readable §9, total §10 "Limits").

use crate::error::Profile;

/// The operational bounds of a reading or a writing. One record serves both profiles;
/// each profile has its own defaults, [`crate::total::DEFAULT_LIMITS`] and
/// [`crate::readable::DEFAULT_LIMITS`].
///
/// [`UNBOUNDED`] (`u64::MAX`) means no bound, as in the codec. `max_json_depth: None` is
/// **derived** from the effective `max_value_depth`: `2v + 2` under the total profile and
/// `3v + 4` under the readable one, unbounded when `max_value_depth` is. Override fields
/// on a profile's defaults with struct update syntax:
///
/// ```
/// use ontos_json::{total, Limits};
///
/// let limits = Limits { max_value_depth: 10, ..total::DEFAULT_LIMITS };
/// // JSON depth is still derived, now from 10: 2 · 10 + 2 = 22 levels.
/// assert!(total::parse_utf8(br#"{"tuple":[]}"#, &limits).is_ok());
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Limits {
    /// Bytes of the input text (reader) or of the output text (writer); kind `text_bytes`.
    pub max_text_bytes: u64,
    /// Arrays and objects open at once; kind `json_depth`. `None` derives it (above).
    pub max_json_depth: Option<u64>,
    /// How deep the value is nested, the root at depth 0; kind `decode_depth`.
    pub max_value_depth: u64,
    /// The byte length of any atom in the value; kind `atom_bytes`.
    pub max_atom_bytes: u64,
    /// The arity of any tuple in the value; kind `tuple_arity`.
    pub max_tuple_arity: u64,
    /// The decimal digits of an integer's magnitude; kind `integer_digits`. Only the
    /// readable profile checks it.
    pub max_integer_digits: u64,
}

/// The value of a bound that does not bound: the largest `u64`.
pub const UNBOUNDED: u64 = u64::MAX;

impl Limits {
    /// The JSON depth bound in force under `profile`: the explicit one, or the one derived
    /// from `max_value_depth` (total §9.2, readable §9). A derived bound too large for a
    /// `u64` saturates to unbounded, which no text in memory can reach anyway.
    pub(crate) fn json_depth(&self, profile: Profile) -> u64 {
        if let Some(depth) = self.max_json_depth {
            return depth;
        }
        let v = self.max_value_depth;
        if v == UNBOUNDED {
            return UNBOUNDED;
        }
        match profile {
            Profile::Total => v.saturating_mul(2).saturating_add(2),
            Profile::Readable => v.saturating_mul(3).saturating_add(4),
        }
    }
}
