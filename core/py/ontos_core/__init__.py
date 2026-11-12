"""ontos/core (L0) — the frozen value model.

    Bytes = finite octet strings
    Value = Atom(bytes) | Tuple(Value*)

A value is finite, immutable, well-founded (a finite tree, never cyclic),
uninterpreted, and compared by structural identity. This module defines what a
value is and when two values are the same — nothing else. There is no byte
encoding here (that is ``ontos_codec``) and no interpretation of atoms or shapes.
See docs/spec/ontos-core.md.

This is the Python peer of the go/rs/ts cores (ontos-internal#60). It exists to
empirically validate the conformance protocol: it implements the same contract
and registers as a fourth ``--impl`` in the differential harness with no protocol
change. It is a validation lane, **not** a published/substrate lane.

Common Value API (all four cores)
---------------------------------
The Go, Rust, TypeScript, and Python cores expose the same conceptual surface so
a developer who learns one can predict the others. Every core provides, by its
own naming convention:

- Construct — ``atom(bytes)`` / ``tuple_(items)`` (Go ``NewAtom``/``NewTuple``,
  Rust ``Value::atom``/``tuple``, TS ``atom``/``tuple``).
- Atom bytes + length — ``Atom.bytes()`` and ``len(atom)``.
- Tuple children + arity + indexed access — ``Tuple.items()``, ``len(tuple)``,
  and ``Tuple.at(i)``.
- Structural equality — ``==`` (``__eq__``) and the module-level ``equals``.
- Diagnostic string — ``str(value)`` (Go ``String``, Rust ``Display``, TS
  ``toString``); **not** a canonical encoding.

Intentional per-language extras
--------------------------------
Python exposes ``is_atom``/``is_tuple`` (idiomatic ``isinstance`` shorthands) and
hashability (``__hash__``) so values can be dict keys / set members in Python
code. These are binding conveniences; they confer no new identity (``__hash__`` is
consistent with structural ``__eq__``) and no canonical form.
"""

from __future__ import annotations

from typing import Iterable, Union

__all__ = [
    "Value",
    "Atom",
    "Tuple",
    "atom",
    "tuple_",
    "is_value",
    "equals",
]


class Value:
    """The abstract base of the two value constructors: ``Atom`` and ``Tuple``.

    ``Value`` itself is never instantiated; it exists only so ``isinstance(v,
    Value)`` and type hints have a single nominal type. The value set is closed:
    every value is exactly one of ``Atom`` or ``Tuple`` (ontos-core §1).
    """

    __slots__ = ()


class Atom(Value):
    """An opaque byte atom. The bytes have no built-in interpretation.

    The bytes are copied and stored immutably; ``bytes()`` returns them as an
    (immutable) ``bytes`` object, so a caller can never mutate the atom.
    """

    __slots__ = ("_bytes",)

    def __init__(self, data: Union[bytes, bytearray, Iterable[int]] = b"") -> None:
        # bytes(...) copies and validates that every element is a 0..255 int, so
        # an out-of-range or non-int element raises ValueError/TypeError here —
        # exactly the "an atom carries octets" invariant (ontos-core §1).
        object.__setattr__(self, "_bytes", bytes(data))

    def __setattr__(self, name: str, value: object) -> None:  # pragma: no cover
        raise AttributeError("ontos values are immutable")

    def __delattr__(self, name: str) -> None:  # pragma: no cover
        raise AttributeError("ontos values are immutable")

    def bytes(self) -> bytes:
        """Return the atom's octets. ``bytes`` is itself immutable in Python."""
        return self._bytes

    def __len__(self) -> int:
        """The atom's byte length (the analog of TS ``Atom#length``)."""
        return len(self._bytes)

    @property
    def is_atom(self) -> bool:
        return True

    @property
    def is_tuple(self) -> bool:
        return False

    def __eq__(self, other: object) -> bool:
        # Atom(b) = Atom(c) iff b and c are the same octet string; Atom != Tuple
        # always (ontos-core §3). NotImplemented lets Python try the reflected op
        # for unrelated types rather than declaring inequality prematurely.
        if isinstance(other, Atom):
            return self._bytes == other._bytes
        if isinstance(other, Tuple):
            return False
        return NotImplemented

    def __ne__(self, other: object) -> bool:
        result = self.__eq__(other)
        if result is NotImplemented:
            return result
        return not result

    def __hash__(self) -> int:
        # Tagged so an Atom and a Tuple with related structure never share a hash
        # bucket by accident; consistent with __eq__ (equal atoms hash equal).
        return hash(("atom", self._bytes))

    def __str__(self) -> str:
        return f"Atom(0x{self._bytes.hex()})"

    def __repr__(self) -> str:
        return self.__str__()


class Tuple(Value):
    """A finite ordered tuple of values. Arity, order, and multiplicity matter.

    Children are validated to be ``Value`` instances and stored in an immutable
    builtin tuple, so a ``Tuple`` cannot be mutated and cannot hold a non-value.
    """

    __slots__ = ("_items",)

    def __init__(self, items: Iterable[Value] = ()) -> None:
        copied = tuple(items)
        for item in copied:
            if not isinstance(item, Value):
                raise TypeError("expected an ontos Value as a tuple child")
        object.__setattr__(self, "_items", copied)

    def __setattr__(self, name: str, value: object) -> None:  # pragma: no cover
        raise AttributeError("ontos values are immutable")

    def __delattr__(self, name: str) -> None:  # pragma: no cover
        raise AttributeError("ontos values are immutable")

    def items(self) -> tuple:
        """Return the children as an immutable builtin tuple of ``Value``."""
        return self._items

    def at(self, index: int) -> Value:
        """The child at ``index`` (Go ``Tuple.At`` / Rust ``Tuple::at``)."""
        return self._items[index]

    def __len__(self) -> int:
        """The arity (number of children)."""
        return len(self._items)

    @property
    def is_atom(self) -> bool:
        return False

    @property
    def is_tuple(self) -> bool:
        return True

    def __eq__(self, other: object) -> bool:
        # Tuple(xs) = Tuple(ys) iff same arity and xs[i] = ys[i] recursively;
        # Tuple != Atom always (ontos-core §3).
        if isinstance(other, Tuple):
            return _tuples_equal(self, other)
        if isinstance(other, Atom):
            return False
        return NotImplemented

    def __ne__(self, other: object) -> bool:
        result = self.__eq__(other)
        if result is NotImplemented:
            return result
        return not result

    def __hash__(self) -> int:
        return _tuple_hash(self)

    def __str__(self) -> str:
        # Walks with an explicit stack of open tuples, never one Python frame per
        # nesting level, so any value renders whatever its depth. The recursive form
        # raised RecursionError from 900 levels, below the codec's default decode depth
        # of 1024. Building one list and joining it once also makes the cost linear.
        #
        # The output is exactly the recursive form's: a child whose __str__ is this
        # method is expanded in place, and any other child (an Atom, or a subclass that
        # overrides __str__) renders through str(), as it did before.
        parts = ["Tuple("]
        open_tuples = [iter(self._items)]
        # Whether the innermost open tuple has written no child yet. A tuple that has
        # just closed was a child of the one below it, so after a close this is False.
        first = True
        while open_tuples:
            item = next(open_tuples[-1], _END)
            if item is _END:
                parts.append(")")
                open_tuples.pop()
                first = False
                continue
            if not first:
                parts.append(", ")
            if type(item).__str__ is _TUPLE_STR:
                parts.append("Tuple(")
                open_tuples.append(iter(item._items))
                first = True
            else:
                parts.append(str(item))
                first = False
        return "".join(parts)

    def __repr__(self) -> str:
        return self.__str__()


# Tuple.__str__ as defined above. A child whose __str__ is anything else, a replacement
# assigned to the class later included, is called like an override.
_TUPLE_STR = Tuple.__str__
# Marks an exhausted child iterator in Tuple.__str__; never a value.
_END = object()
# Tuple.__eq__ and Tuple.__hash__ as defined above, kept for the same reason.
_TUPLE_EQ = Tuple.__eq__
_TUPLE_HASH = Tuple.__hash__


def _tuples_equal(left: Tuple, right: Tuple) -> bool:
    """``left._items == right._items``, decided as the builtin tuple comparison decides it,
    with an explicit stack in place of its recursion through each child's ``__eq__``.

    The recursive form raised RecursionError from 1000 levels, below the codec's default
    decode depth of 1024. The builtin compares child pairs left to right and stops at the
    first pair that differs; only after the shorter tuple's last child does arity decide. A
    pair is equal if it is one object, or else if ``x == y`` is true. This walk asks the
    same questions in the same order, except that a pair of tuples that both compare
    through Tuple.__eq__ is opened in place instead of being called. When Python would have
    asked the right one first (its class is a proper subclass of the left one's), the pair
    is opened right to left, as that call would have compared it.
    """
    # Each open pair of tuples: an iterator over its child pairs, and whether the two
    # arities match.
    open_pairs = [(zip(left._items, right._items), len(left._items) == len(right._items))]
    while open_pairs:
        pairs, same_arity = open_pairs[-1]
        pair = next(pairs, None)
        if pair is None:
            if not same_arity:
                return False
            open_pairs.pop()
            continue
        x, y = pair
        if x is y:
            continue
        if (
            type(x).__eq__ is _TUPLE_EQ
            and type(y).__eq__ is _TUPLE_EQ
            and isinstance(x, Tuple)
            and isinstance(y, Tuple)
        ):
            if type(x) is not type(y) and issubclass(type(y), type(x)):
                x, y = y, x
            open_pairs.append((zip(x._items, y._items), len(x._items) == len(y._items)))
        elif not x == y:
            return False
    return True


class _Lane:
    """Stands in for a child tuple whose hash is already known: the builtin tuple hash asks
    it for that number, as it would have asked the tuple itself."""

    __slots__ = ("_hash",)

    def __init__(self, hash_: int) -> None:
        self._hash = hash_

    def __hash__(self) -> int:
        return self._hash


def _tuple_hash(root: Tuple) -> int:
    """``hash(("tuple", root._items))``, the same number the recursive form computed, with an
    explicit stack in place of its recursion through each child's ``__hash__``.

    The recursive form raised RecursionError from 1000 levels, so a decoded 1024-deep value
    could not be a dict key. The walk hashes each tuple after its children. A child tuple
    whose ``__hash__`` is Tuple's own goes into its parent's builtin tuple as a ``_Lane``
    carrying its hash, so the builtin tuple hash combines exactly the numbers it combined
    before, and existing dicts and sets keep agreeing. Any other child (an Atom, or a subclass
    with its own ``__hash__``) goes in as itself and is hashed by the builtin, as before. A
    tuple reached twice is hashed once.
    """
    # id(tuple) -> its hash, for every tuple walked. Each one is alive under root while the
    # walk runs, so no other object shares its id, and only a walked child is found here.
    hashes = {}
    pending = [(root, False)]
    while pending:
        node, children_hashed = pending.pop()
        if children_hashed:
            lanes = tuple(
                _Lane(hashes[id(child)]) if id(child) in hashes else child
                for child in node._items
            )
            hashes[id(node)] = hash(("tuple", lanes))
            continue
        if id(node) in hashes:
            continue
        pending.append((node, True))
        for child in reversed(node._items):
            if (
                type(child).__hash__ is _TUPLE_HASH
                and isinstance(child, Tuple)
                and id(child) not in hashes
            ):
                pending.append((child, False))
    return hashes[id(root)]


def atom(data: Union[bytes, bytearray, Iterable[int]] = b"") -> Atom:
    """Construct an ``Atom`` from bytes (or an iterable of 0..255 ints)."""
    return Atom(data)


def tuple_(items: Iterable[Value] = ()) -> Tuple:
    """Construct a ``Tuple`` from an iterable of values.

    Named ``tuple_`` (trailing underscore) so it does not shadow the builtin
    ``tuple``; the type is exported as ``Tuple``.
    """
    return Tuple(items)


def is_value(value: object) -> bool:
    """Whether ``value`` is an ontos ``Value`` (an ``Atom`` or a ``Tuple``)."""
    return isinstance(value, (Atom, Tuple))


def equals(left: Value, right: Value) -> bool:
    """Structural equality (ontos-core §3). The same relation as ``left == right``."""
    return left == right
