"""Types shared by both JSON profiles: the limits record, the refusal, spans and paths.

ontos-total-json §8 and §10 define them, and ontos-readable-json §8 and §10 reuse them
unchanged. Nothing here reads or writes text.
"""

from __future__ import annotations

import dataclasses
from typing import NamedTuple, Optional, Tuple, Union

__all__ = [
    "Limits",
    "ProjectionError",
    "Span",
    "Segment",
    "KIND_TEXT_BYTES",
    "KIND_JSON_DEPTH",
    "KIND_DECODE_DEPTH",
    "KIND_ATOM_BYTES",
    "KIND_TUPLE_ARITY",
    "KIND_INTEGER_DIGITS",
]

# The limit kinds (total §9.1, readable §9). decode_depth, atom_bytes and tuple_arity are the
# codec's own kinds (ontos-codec §4.2); the other three are new for the projection.
KIND_TEXT_BYTES = "text_bytes"
KIND_JSON_DEPTH = "json_depth"
KIND_DECODE_DEPTH = "decode_depth"
KIND_ATOM_BYTES = "atom_bytes"
KIND_TUPLE_ARITY = "tuple_arity"
KIND_INTEGER_DIGITS = "integer_digits"

# A path segment (total §8.2): a member name is a ``str``, an array index an ``int``. The two
# stay distinguishable: the member ``"0"`` is not the index ``0``.
Segment = Union[str, int]


class Span(NamedTuple):
    """A zero-based, half-open UTF-8 byte span ``[start, end)`` of the input (total §8.3)."""

    start: int
    end: int


_FIELDS = (
    "max_text_bytes",
    "max_json_depth",
    "max_value_depth",
    "max_atom_bytes",
    "max_tuple_arity",
    "max_integer_digits",
)


@dataclasses.dataclass(frozen=True, kw_only=True)
class Limits:
    """The operational bounds of both profiles (total §9, readable §9, total §10).

    Each field is a non-negative ``int`` or ``None``. ``None`` means unbounded, except for
    ``max_json_depth``, where it means **derived** from ``max_value_depth`` by the profile that
    reads or writes (``2v + 2`` for the total profile, ``3v + 4`` for the readable one, and
    unbounded when ``max_value_depth`` is ``None``).

    Every field must be given: the shipped defaults live in each profile's ``DEFAULT_LIMITS``
    (``ontos_json.total.DEFAULT_LIMITS``, ``ontos_json.readable.DEFAULT_LIMITS``), and
    ``replace`` derives a record from them, so no bound is ever unbounded by omission::

        readable.parse_utf8(data, limits=readable.DEFAULT_LIMITS.replace(max_value_depth=10))

    A value that is not a non-negative ``int`` (``bool`` included) is a caller error and
    raises ``TypeError`` or ``ValueError`` here, never a refusal.
    """

    max_text_bytes: Optional[int]
    max_json_depth: Optional[int]
    max_value_depth: Optional[int]
    max_atom_bytes: Optional[int]
    max_tuple_arity: Optional[int]
    max_integer_digits: Optional[int]

    def __post_init__(self) -> None:
        for name in _FIELDS:
            bound = getattr(self, name)
            if bound is None:
                continue
            if isinstance(bound, bool) or not isinstance(bound, int):
                raise TypeError(f"Limits.{name} must be an int or None, got {type(bound).__name__}")
            if bound < 0:
                raise ValueError(f"Limits.{name} must not be negative, got {bound}")

    def replace(self, **changes: Optional[int]) -> "Limits":
        """A copy with the given fields changed; every other field keeps its value."""
        return dataclasses.replace(self, **changes)


class ProjectionError(Exception):
    """A refusal of either JSON profile (total §8.1, readable §8).

    ``profile``, ``code``, ``path``, ``span`` and ``kind`` are normative, and every face
    reports the same for the same input and limits. ``message`` is not: its wording may
    change, and nothing may parse it.

    - ``path`` is a tuple of segments: ``str`` member names and ``int`` indexes.
    - ``span`` is a ``Span`` of input bytes for a reader refusal, and ``None`` for a writer
      refusal, which has no input text (total §9.3). A writer's path is informative.
    - ``kind`` is the limit kind for ``limit_exceeded`` and ``None`` otherwise.
    """

    def __init__(
        self,
        profile: str,
        code: str,
        path: Tuple[Segment, ...],
        span: Optional[Span],
        kind: Optional[str] = None,
        message: Optional[str] = None,
    ) -> None:
        if message is None:
            message = _describe(code, path, span, kind)
        super().__init__(message)
        self.profile = profile
        self.code = code
        self.path = tuple(path)
        self.span = span
        self.kind = kind
        self.message = message

    def __repr__(self) -> str:
        return (
            f"ProjectionError(profile={self.profile!r}, code={self.code!r}, path={self.path!r}, "
            f"span={self.span!r}, kind={self.kind!r})"
        )


def _describe(code: str, path: Tuple[Segment, ...], span: Optional[Span], kind: Optional[str]) -> str:
    what = f"{code} ({kind})" if kind is not None else code
    where = "/" + "/".join(str(seg) for seg in path)
    if span is None:
        return f"{what} while writing {where}"
    return f"{what} at {where}, bytes [{span.start}, {span.end})"


# --- linked paths ----------------------------------------------------------------------------
#
# Interpretation and writing hold a path as a chain of (parent, segment) pairs, None at the
# root, so that a node deep in the tree costs one pair and not a copy of its whole path. A
# chain becomes a tuple only for a refusal or an origin.


def path_tuple(link: object) -> Tuple[Segment, ...]:
    """The tuple of segments of a linked path, root first."""
    segs = []
    while link is not None:
        link, seg = link  # type: ignore[misc]
        segs.append(seg)
    segs.reverse()
    return tuple(segs)
