//! Origins (readable §10.2): for every node of a value read from text, the JSON path and
//! the span of the source that produced it. Origins are metadata, not part of the value,
//! its identity or its encoding.

use core::fmt;

use ontos_core::Value;

use crate::error::{Segment, Span};
use crate::interp::{segment, At, Interpreted, ROOT};
use crate::lex::Tree;

/// A value read together with its origins, from
/// [`parse_utf8_with_origins`](crate::readable::parse_utf8_with_origins).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed {
    pub value: Value,
    pub origins: Origins,
}

/// The origin of one value node: the JSON path (total §8.2) and the input span of the
/// source node that produced it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct Origin {
    pub path: Vec<Segment>,
    pub span: Span,
}

/// The origins of every node of a value (every atom and tuple of the expanded tree),
/// addressed by **value path**: tuple child indices from the root, `[]` for the root and
/// `[2, 1]` for child 1 of child 2. After sorting, a map entry's index is its position in
/// codec order.
#[derive(Clone, PartialEq, Eq)]
pub struct Origins {
    /// Owned paths as a parent-linked arena; `ROOT` is the empty path.
    paths: Vec<(usize, Segment)>,
    /// The value's nodes in pre-order.
    nodes: Vec<Flat>,
    /// The children of each node, as indices into `nodes`, contiguous per node.
    kids: Vec<usize>,
}

#[derive(Clone, PartialEq, Eq)]
struct Flat {
    path: usize,
    span: Span,
    kids_start: usize,
    kids_len: usize,
}

impl Origins {
    /// The number of value nodes, which is the number of origins.
    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    /// Whether there are no origins; never true for a value read from text.
    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// The origin of the value node at `value_path`, or `None` when no node is there.
    pub fn get(&self, value_path: &[usize]) -> Option<Origin> {
        let mut node = if self.nodes.is_empty() {
            return None;
        } else {
            0
        };
        for &i in value_path {
            let flat = &self.nodes[node];
            if i >= flat.kids_len {
                return None;
            }
            node = self.kids[flat.kids_start + i];
        }
        Some(self.origin(node))
    }

    /// Every value node's path and origin, in pre-order of the value.
    pub fn iter(&self) -> Iter<'_> {
        Iter {
            origins: self,
            stack: Vec::new(),
            path: Vec::new(),
            started: false,
        }
    }

    fn origin(&self, node: usize) -> Origin {
        let flat = &self.nodes[node];
        let mut path = Vec::new();
        let mut id = flat.path;
        while id != ROOT {
            let (parent, seg) = &self.paths[id];
            path.push(seg.clone());
            id = *parent;
        }
        path.reverse();
        Origin {
            path,
            span: flat.span,
        }
    }
}

impl fmt::Debug for Origins {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_list().entries(self.iter()).finish()
    }
}

/// The pre-order walk of [`Origins::iter`]: `(value path, origin)` pairs.
pub struct Iter<'a> {
    origins: &'a Origins,
    /// The open nodes, each with the position of its next child.
    stack: Vec<(usize, usize)>,
    path: Vec<usize>,
    started: bool,
}

impl Iterator for Iter<'_> {
    type Item = (Vec<usize>, Origin);

    fn next(&mut self) -> Option<Self::Item> {
        if !self.started {
            self.started = true;
            if self.origins.nodes.is_empty() {
                return None;
            }
            self.stack.push((0, 0));
            return Some((Vec::new(), self.origins.origin(0)));
        }
        loop {
            let (node, next) = self.stack.last_mut()?;
            let flat = &self.origins.nodes[*node];
            if *next < flat.kids_len {
                let child = self.origins.kids[flat.kids_start + *next];
                self.path.push(*next);
                *next += 1;
                self.stack.push((child, 0));
                return Some((self.path.clone(), self.origins.origin(child)));
            }
            self.stack.pop();
            self.path.pop();
        }
    }
}

/// Builds the public origins of `interpreted`, whose path ids refer to `tree`.
pub(crate) fn build(tree: &Tree<'_>, interpreted: &Interpreted) -> Origins {
    #[derive(Clone, Copy)]
    enum Src {
        Node(usize),
        Uniform(At),
    }
    let mut out = Origins {
        paths: Vec::new(),
        nodes: Vec::new(),
        kids: Vec::new(),
    };
    let mut remap = vec![usize::MAX; interpreted.paths.len()];
    // (value, where its origin comes from, the parent's slot for its index)
    let mut stack: Vec<(&Value, Src, usize)> = vec![(
        &interpreted.value,
        Src::Node(interpreted.origin),
        usize::MAX,
    )];
    while let Some((value, src, slot)) = stack.pop() {
        let index = out.nodes.len();
        if slot != usize::MAX {
            out.kids[slot] = index;
        }
        let (at, kids) = match src {
            Src::Node(id) => {
                let node = &interpreted.origins[id];
                (node.at, node.kids.as_deref())
            }
            Src::Uniform(at) => (at, None),
        };
        let path = own_path(tree, interpreted, &mut remap, &mut out.paths, at.path);
        let children: &[Value] = match value {
            Value::Atom(_) => &[],
            Value::Tuple(tuple) => tuple.items(),
        };
        let kids_start = out.kids.len();
        out.kids.resize(kids_start + children.len(), usize::MAX);
        out.nodes.push(Flat {
            path,
            span: at.span,
            kids_start,
            kids_len: children.len(),
        });
        for (i, child) in children.iter().enumerate().rev() {
            let child_src = match kids {
                Some(kids) => Src::Node(kids[i]),
                None => Src::Uniform(at),
            };
            stack.push((child, child_src, kids_start + i));
        }
    }
    out
}

/// The owned path id for arena path `id`, copying the segments it needs once.
fn own_path(
    tree: &Tree<'_>,
    interpreted: &Interpreted,
    remap: &mut [usize],
    owned: &mut Vec<(usize, Segment)>,
    id: usize,
) -> usize {
    // The unmapped ancestors, innermost first.
    let mut chain = Vec::new();
    let mut cursor = id;
    while cursor != ROOT && remap[cursor] == usize::MAX {
        chain.push(cursor);
        cursor = interpreted.paths[cursor].parent;
    }
    let mut parent = if cursor == ROOT { ROOT } else { remap[cursor] };
    for &node in chain.iter().rev() {
        owned.push((parent, segment(tree, interpreted.paths[node].seg)));
        parent = owned.len() - 1;
        remap[node] = parent;
    }
    parent
}
