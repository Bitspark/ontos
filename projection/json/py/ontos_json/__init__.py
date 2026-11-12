"""ontos JSON projections of ground values (design record 0010): the Python face.

Two value-only profiles, each with a byte reader, a host-string reader and a writer:

- ``ontos_json.total``: ``ontos-total-json/1`` (docs/spec/ontos-total-json.md), the total form
  ``{"atom":"<hex>"} | {"tuple":[...]}``.
- ``ontos_json.readable``: ``ontos-readable-json/1`` (docs/spec/ontos-readable-json.md), plain
  JSON for the common ``ontos/data`` values and the ``{"$ontos":[tag, ...]}`` envelope for the
  rest, with origins (§10.2). It depends on ``total``, whose form its ``raw`` arm embeds.

Both read text with the shared strict lexer (``_lexer``: size, well-formed UTF-8, strict
RFC 8259) and share one ``Limits`` record and one ``ProjectionError``. A JSON profile is a
presentation: identity, hashing and signing use the codec bytes of the value read back, never
the JSON text.

Source-only like ``ontos_core``, ``ontos_codec`` and ``ontos_data``, which it imports from
``core/py``, ``codec/py`` and ``data/py``; it needs nothing outside the standard library.
"""

from ._shared import Limits, ProjectionError, Span
from . import readable, total

__all__ = ["Limits", "ProjectionError", "Span", "readable", "total"]
