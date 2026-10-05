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
            return self._items == other._items
        if isinstance(other, Atom):
            return False
        return NotImplemented

    def __ne__(self, other: object) -> bool:
        result = self.__eq__(other)
        if result is NotImplemented:
            return result
        return not result

    def __hash__(self) -> int:
        return hash(("tuple", self._items))

    def __str__(self) -> str:
        return "Tuple(" + ", ".join(str(item) for item in self._items) + ")"

    def __repr__(self) -> str:
        return self.__str__()


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
