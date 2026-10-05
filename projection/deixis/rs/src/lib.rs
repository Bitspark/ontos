//! `ontos-over-deixis-v1` — the projection between ontos values and `Node[Option[Bytes]]`,
//! on the `deixis-pos-v1` position spelling. See `../PROJECTION.md`.
//!
//! ```text
//! P(Atom(b))            = Node(Some(b), {})                            total
//! P(Tuple(v₀ … vₙ₋₁))   = Node(None, { κ(i) ↦ P(vᵢ) })                 total
//! R(Node(Some(b), {}))  = Atom(b)                                      partial:
//! R(Node(None, m))      = Tuple over κ(0) … κ(n−1), exactly            exact or refusal
//! ```
//!
//! Deixis `v0.2.0` gives **every** node an own value independently of its children
//! (`Node[T] = T × FinMap[Bytes, Node[T]]`), so there is no longer a leaf/struct sum to
//! match on. `Option` is **this bridge's** chosen payload domain, not a feature of the
//! deixis core: the core carries `T` opaquely and never interprets it. The two ontos
//! constructors therefore land on two disjoint node shapes — a present value with no
//! children, and an absent value with the dense positional children — and the shapes
//! that are *neither* are exactly what `R` refuses.
//!
//! The recognizer never parses a key: `κ` is order-preserving, so deixis's canonical
//! entry order is tuple order, and recognition is one pairwise walk comparing each entry
//! key against the generated `κ(i)`. It never sorts entries into new positions, fills
//! gaps, drops keys, or normalizes an alternate spelling to its index — recognition is
//! exact or it is [`Unrecognized`], because a repair pass would silently coarsen
//! identity.

#![forbid(unsafe_code)]

use core::fmt;
use ontos_core::Value;

/// The projection's codomain: a deixis node whose payload is an optional byte string.
///
/// `Option` is the bridge's choice, made here and nowhere else. Deixis requires a value
/// at every node and says nothing about what it means; this profile reads `Some(b)` as
/// "an atom's bytes" and `None` as "no atom here, a tuple's positions instead".
pub type BytesNode = deixis_core::Node<Option<Vec<u8>>>;

/// The name of the profile this crate implements.
pub const PROFILE: &str = "ontos-over-deixis-v1";

/// The position spelling the profile is defined over.
pub const POSITION_SPELLING: &str = "deixis-pos-v1";

/// The deixis identity `=D` at this bridge's slot: the lifted relation over equality of
/// the **whole** `Option<Vec<u8>>` payload.
///
/// Both halves matter and neither is deixis's to supply — the core deliberately has no
/// `PartialEq` for `Node<T>`, because lifting an equality it did not choose is exactly
/// the commitment the floor declines to make. So the relation is passed explicitly here:
/// `None` differs from every `Some`, and two `Some`s compare by exact bytes.
pub fn node_eq(a: &BytesNode, b: &BytesNode) -> bool {
    a.equal_by(b, &|x: &Option<Vec<u8>>, y: &Option<Vec<u8>>| x == y)
}

/// A node with a payload and no children. Composing zero children cannot collide, so the
/// only failure `compose` has is unreachable.
fn childless(own: Option<Vec<u8>>) -> BytesNode {
    BytesNode::compose(own, core::iter::empty::<(Vec<u8>, BytesNode)>())
        .expect("a childless node has no keys, so no duplicate is possible")
}

/// `P` — total. Every ontos value is a deixis node.
pub fn project(value: &Value) -> BytesNode {
    match value {
        // Some(b) and NO children. The childlessness is half the projection: it is what
        // makes `R` able to tell an atom from a tuple without a tag.
        Value::Atom(atom) => childless(Some(atom.bytes().to_vec())),

        // None and the dense positional children. Law 6 falls straight out: the empty
        // tuple is Node(None, {}) and the empty atom is Node(Some(""), {}), which differ
        // in the payload rather than in the child map.
        Value::Tuple(tuple) => BytesNode::compose(
            None,
            tuple
                .items()
                .iter()
                .enumerate()
                .map(|(i, child)| (deixis_pos::key(i as u64), project(child))),
        )
        .expect("κ is injective, so projected keys never collide"),
    }
}

/// `R` — partial. Succeeds exactly on the image of [`project`].
pub fn recognize(node: &BytesNode) -> Result<Value, Unrecognized> {
    let mut path = Vec::new();
    recognize_at(node, &mut path)
}

fn recognize_at(node: &BytesNode, path: &mut Vec<u64>) -> Result<Value, Unrecognized> {
    let children = node.children();

    match node.own() {
        // A present payload is an atom — but ONLY if the node is childless. A node
        // carrying both is well-formed deixis and outside the image of P, and it is a
        // shape the old leaf/struct sum could not even express. Refusing it is not a
        // key question, so it does not get a key answer.
        Some(bytes) => {
            if !children.is_empty() {
                return Err(Unrecognized::ValueWithChildren {
                    path: path.clone(),
                    children: children.len(),
                });
            }
            Ok(Value::atom(bytes.clone()))
        }

        // An absent payload is a tuple, and its domain must be exactly κ(0) … κ(n−1).
        // n = 0 is the empty tuple and is in the image.
        None => {
            let mut items = Vec::with_capacity(children.len());
            // Canonical entry order is κ order, so entry i must carry exactly κ(i).
            for (i, (key, child)) in children.iter().enumerate() {
                let expected = deixis_pos::key(i as u64);
                if key != expected {
                    return Err(Unrecognized::KeyMismatch {
                        path: path.clone(),
                        entry: i as u64,
                        expected,
                        found: key.to_vec(),
                    });
                }
                path.push(i as u64);
                let item = recognize_at(child, path)?;
                path.pop();
                items.push(item);
            }
            Ok(Value::tuple(items))
        }
    }
}

/// Why a node is not an ontos value.
///
/// `Node[Option[Bytes]]` admits shapes the projection never produces, and they do not all
/// fail for the same reason — so they do not all get the same explanation. A malformed key
/// domain is a statement about *which* positions a tuple carries; a payload beside
/// children is a statement about *what kind of node* it is at all. Collapsing the second
/// into the first would name a key as the culprit when no key is wrong.
///
/// Every variant carries `path`, the tuple indices from the root to the refusing node.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Unrecognized {
    /// The first entry, in canonical order, whose key is not the spelling of its
    /// position. A shifted or sparse domain, a named key, a non-canonical spelling and a
    /// stray entry after a dense prefix all surface here, located by `entry`.
    KeyMismatch {
        /// Tuple indices from the root to the node containing the mismatch.
        path: Vec<u64>,
        /// The entry position (in canonical order) whose key mismatched.
        entry: u64,
        /// `κ(entry)` — the key that position must carry.
        expected: Vec<u8>,
        /// The key bytes actually present.
        found: Vec<u8>,
    },

    /// The node carries an own value **and** children. `P` emits a payload only at a
    /// childless node, so this is outside its image however well-formed the keys are —
    /// and the keys are not consulted, because the shape is already wrong.
    ValueWithChildren {
        /// Tuple indices from the root to the offending node.
        path: Vec<u64>,
        /// How many children the node carries. Any number but zero refuses.
        children: usize,
    },
}

impl Unrecognized {
    /// The tuple indices from the root to the node that refused, whatever the reason.
    pub fn path(&self) -> &[u64] {
        match self {
            Unrecognized::KeyMismatch { path, .. }
            | Unrecognized::ValueWithChildren { path, .. } => path,
        }
    }
}

impl fmt::Display for Unrecognized {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Unrecognized::KeyMismatch {
                path,
                entry,
                expected,
                found,
            } => write!(
                f,
                "not an ontos value: at path {path:?}, entry {entry} carries key {found:02x?}, \
                 not κ({entry}) = {expected:02x?}"
            ),
            Unrecognized::ValueWithChildren { path, children } => write!(
                f,
                "not an ontos value: at path {path:?}, the node carries an own value and \
                 {children} children; P gives a value only to a childless node"
            ),
        }
    }
}

impl std::error::Error for Unrecognized {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_across_the_kappa_length_boundary() {
        // Arity 300 crosses κ's one-byte magnitude boundary at position 256.
        let value = Value::tuple((0..300u16).map(|i| Value::atom(i.to_be_bytes().to_vec())));
        let node = project(&value);

        assert!(
            node.own().is_none(),
            "a tuple projects to an absent payload"
        );
        let children = node.children();
        assert_eq!(children.len(), 300);
        let keys: Vec<&[u8]> = children.keys().collect();
        assert_eq!(keys[255], &deixis_pos::key(255)[..], "κ(255) = 00ff");
        assert_eq!(keys[256], &[0xff, 0x00, 0x01, 0x00], "κ(256) = ff000100");

        assert_eq!(recognize(&node).unwrap(), value);
    }

    #[test]
    fn pointing_commutes_with_projection() {
        // Law 7: the value at index path (1, 0) is the node at key path (κ(1), κ(0)).
        let inner = Value::tuple([Value::atom(b"here".to_vec()), Value::atom(vec![])]);
        let value = Value::tuple([Value::atom(vec![0x00]), inner]);
        let node = project(&value);

        let reached = node
            .at([deixis_pos::key(1), deixis_pos::key(0)])
            .expect("key path (κ(1), κ(0)) reaches a node");
        assert_eq!(reached.own().as_deref(), Some(&b"here"[..]));
        assert!(reached.children().is_empty(), "an atom projects childless");
    }

    #[test]
    fn the_mismatch_is_located() {
        // Outer dense, inner shifted: the error points inside, in tuple indices.
        let inner =
            BytesNode::compose(None, [(deixis_pos::key(1), childless(Some(vec![])))]).unwrap();
        let node = BytesNode::compose(None, [(deixis_pos::key(0), inner)]).unwrap();

        match recognize(&node).unwrap_err() {
            Unrecognized::KeyMismatch {
                path,
                entry,
                expected,
                found,
            } => {
                assert_eq!(path, vec![0]);
                assert_eq!(entry, 0);
                assert_eq!(expected, deixis_pos::key(0));
                assert_eq!(found, deixis_pos::key(1));
            }
            other => panic!("expected a key mismatch, got {other:?}"),
        }
    }

    #[test]
    fn a_value_beside_children_is_refused_without_blaming_a_key() {
        // The shape the v0.1.0 sum could not express: Some(b) AND dense, valid children.
        // Every key here is exactly κ(i), so a key-mismatch answer would be a false one.
        let node = BytesNode::compose(
            Some(b"payload".to_vec()),
            [(deixis_pos::key(0), childless(Some(vec![])))],
        )
        .unwrap();

        match recognize(&node).unwrap_err() {
            Unrecognized::ValueWithChildren { path, children } => {
                assert!(path.is_empty());
                assert_eq!(children, 1);
            }
            other => panic!("expected a value-with-children refusal, got {other:?}"),
        }
    }

    #[test]
    fn the_two_empties_stay_apart() {
        // Law 6, restated in the mandatory-value model: both are childless, and they
        // differ in the payload alone.
        let empty_atom = project(&Value::atom(vec![]));
        let empty_tuple = project(&Value::tuple([]));

        assert_eq!(empty_atom.own().as_deref(), Some(&[][..]));
        assert_eq!(empty_tuple.own(), &None);
        assert!(empty_atom.children().is_empty());
        assert!(empty_tuple.children().is_empty());
        assert!(!node_eq(&empty_atom, &empty_tuple));
    }
}
