"""Stages 1 to 3 of reading, shared by both JSON profiles (ontos-total-json §4.1 to §4.3).

1. **Size.** At most ``max_text_bytes`` bytes.
2. **Text.** Well-formed UTF-8 (Unicode §3.9, Table 3-7), checked over the whole input by this
   module's own validator, with the maximal-subpart span of the first fault.
3. **JSON.** One strict RFC 8259 text, read left to right by the procedure of total §4.3, into a
   tree of ``Node`` whose every node carries its span.

Each stage runs to completion before the next begins, and the first refusal ends the reading.
Nothing here uses the ``json`` module, and nothing recurses on nesting: open arrays and objects
are kept on an explicit stack, so the depth a text may reach is bounded by ``max_json_depth``
alone, never by Python's recursion limit (total §9.2).
"""

from __future__ import annotations

import re
from typing import List, Optional, Tuple

from ._shared import KIND_JSON_DEPTH, KIND_TEXT_BYTES, ProjectionError, Span

__all__ = [
    "Node",
    "OBJECT",
    "ARRAY",
    "STRING",
    "INTEGER",
    "NUMBER",
    "TRUE",
    "FALSE",
    "NULL",
    "read_json",
    "utf8_fault",
]

# --- the JSON tree (total §4.3, "The JSON tree") ---------------------------------------------

OBJECT = 0  # value: list of members (name, name_start, name_end, value node), in source order
ARRAY = 1  # value: list of element nodes
STRING = 2  # value: the decoded content, a str of Unicode scalar values
INTEGER = 3  # value: the lexeme (ASCII str); a number with no fraction and no exponent
NUMBER = 4  # value: the lexeme (ASCII str); a number with a fraction or an exponent
TRUE = 5
FALSE = 6
NULL = 7


class Node:
    """A node of the JSON tree, with its span ``[start, end)`` in input bytes.

    A string's span runs from its opening to its closing quotation mark, a number's or a
    literal's is its lexeme, and an object's or array's runs from its opening to its closing
    bracket, inclusive.
    """

    __slots__ = ("kind", "start", "end", "value")

    def __init__(self, kind: int, start: int, end: int, value: object) -> None:
        self.kind = kind
        self.start = start
        self.end = end
        self.value = value


# --- stage 2: well-formed UTF-8 (total §4.2) -------------------------------------------------

# Every well-formed sequence of Unicode Table 3-7, possessively repeated: the match ends at the
# first offset where the input stops being well-formed UTF-8.
_WELL_FORMED = re.compile(
    rb"(?:[\x00-\x7f]+"
    rb"|[\xc2-\xdf][\x80-\xbf]"
    rb"|\xe0[\xa0-\xbf][\x80-\xbf]"
    rb"|[\xe1-\xec\xee\xef][\x80-\xbf][\x80-\xbf]"
    rb"|\xed[\x80-\x9f][\x80-\xbf]"
    rb"|\xf0[\x90-\xbf][\x80-\xbf][\x80-\xbf]"
    rb"|[\xf1-\xf3][\x80-\xbf][\x80-\xbf][\x80-\xbf]"
    rb"|\xf4[\x80-\x8f][\x80-\xbf][\x80-\xbf]"
    rb")*+"
)


def _second_byte_range(lead: int) -> Optional[Tuple[int, int, int]]:
    """For a lead byte of Table 3-7: (low, high) of its second byte and its sequence length."""
    if 0xC2 <= lead <= 0xDF:
        return 0x80, 0xBF, 2
    if lead == 0xE0:
        return 0xA0, 0xBF, 3
    if 0xE1 <= lead <= 0xEC or lead == 0xEE or lead == 0xEF:
        return 0x80, 0xBF, 3
    if lead == 0xED:
        return 0x80, 0x9F, 3
    if lead == 0xF0:
        return 0x90, 0xBF, 4
    if 0xF1 <= lead <= 0xF3:
        return 0x80, 0xBF, 4
    if lead == 0xF4:
        return 0x80, 0x8F, 4
    return None


def utf8_fault(data: bytes) -> Optional[Span]:
    """The maximal subpart at the first offset where ``data`` is not well-formed UTF-8.

    ``None`` when the whole of ``data`` is well-formed. Otherwise the span ``[s, e)`` of the
    longest run of bytes from ``s`` that is a prefix of some well-formed sequence of Table 3-7,
    or the one byte at ``s`` when no well-formed sequence starts with it (total §4.2).
    """
    n = len(data)
    s = _WELL_FORMED.match(data).end()
    if s == n:
        return None
    rng = _second_byte_range(data[s])
    if rng is None:
        return Span(s, s + 1)
    low, high, length = rng
    e = s + 1
    if e < n and low <= data[e] <= high:
        e += 1
        while e - s < length and e < n and 0x80 <= data[e] <= 0xBF:
            e += 1
    return Span(s, e)


# --- stage 3: the strict reading (total §4.3) ------------------------------------------------

_WS = re.compile(rb"[ \t\n\r]*")  # RFC 8259 whitespace, and nothing else
_PLAIN = re.compile(rb'[^"\\\x00-\x1f]*')  # string bytes that need no attention
_DIGITS = re.compile(rb"[0-9]*")  # ASCII digits only

_SIMPLE_ESCAPES = {
    0x22: '"',
    0x5C: "\\",
    0x2F: "/",
    0x62: "\b",
    0x66: "\f",
    0x6E: "\n",
    0x72: "\r",
    0x74: "\t",
}

_HEX_VALUE = [-1] * 256
for _i, _c in enumerate(b"0123456789abcdef"):
    _HEX_VALUE[_c] = _i
for _i, _c in enumerate(b"ABCDEF"):
    _HEX_VALUE[_c] = 10 + _i
del _i, _c

_LITERALS = {0x74: (b"true", TRUE), 0x66: (b"false", FALSE), 0x6E: (b"null", NULL)}


def _char_end(data: bytes, p: int) -> int:
    """The end of the character whose UTF-8 encoding starts at ``p`` (stage 2 has passed)."""
    lead = data[p]
    if lead < 0x80:
        return p + 1
    if lead < 0xE0:
        return p + 2
    if lead < 0xF0:
        return p + 3
    return p + 4


class _Lexer:
    __slots__ = ("data", "n", "profile", "segs")

    def __init__(self, data: bytes, profile: str) -> None:
        self.data = data
        self.n = len(data)
        self.profile = profile
        # The path of the value being read: the segments of every open container, and for the
        # innermost one the segment of the child being read, once there is one.
        self.segs: List[object] = []

    # -- refusals --

    def refuse(self, code: str, path: List[object], start: int, end: int, kind: Optional[str] = None):
        return ProjectionError(self.profile, code, tuple(path), Span(start, end), kind)

    def bad_char(self, path: List[object], p: int):
        """``invalid_json`` at the character at ``p``, or at ``[n, n)`` at the end of input."""
        if p >= self.n:
            return self.refuse("invalid_json", path, self.n, self.n)
        return self.refuse("invalid_json", path, p, _char_end(self.data, p))

    # -- tokens --

    def string(self, p: int, path: List[object]) -> Tuple[str, int]:
        """Read the string whose opening quotation mark is at ``p``: (content, end)."""
        data, n = self.data, self.n
        q = p + 1
        r = _PLAIN.match(data, q).end()
        if r < n and data[r] == 0x22:
            # Stage 2 has checked these bytes with this module's own validator, so the codec
            # decodes them as they are: it never meets a sequence it could replace or drop.
            return data[q:r].decode("utf-8"), r + 1
        parts: List[str] = []
        while True:
            if r > q:
                parts.append(data[q:r].decode("utf-8"))
            if r >= n:
                raise self.refuse("invalid_json", path, n, n)
            c = data[r]
            if c == 0x22:
                return "".join(parts), r + 1
            if c < 0x20:
                raise self.refuse("invalid_json", path, r, r + 1)
            # c is a backslash
            if r + 1 >= n:
                raise self.refuse("invalid_json", path, n, n)
            e = data[r + 1]
            simple = _SIMPLE_ESCAPES.get(e)
            if simple is not None:
                parts.append(simple)
                q = r + 2
            elif e == 0x75:  # \u
                cp = self.hex4(r + 2, path)
                if 0xD800 <= cp <= 0xDBFF:
                    low = self.low_surrogate(r + 6)
                    if low is None:
                        raise self.refuse("invalid_unicode_escape", path, r, r + 6)
                    parts.append(chr(0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00)))
                    q = r + 12
                elif 0xDC00 <= cp <= 0xDFFF:
                    raise self.refuse("invalid_unicode_escape", path, r, r + 6)
                else:
                    parts.append(chr(cp))
                    q = r + 6
            else:
                raise self.refuse("invalid_json", path, r, _char_end(data, r + 1))
            r = _PLAIN.match(data, q).end()

    def hex4(self, p: int, path: List[object]) -> int:
        """The code point named by the four hexadecimal digits at ``p``, else refuse."""
        data, n = self.data, self.n
        cp = 0
        for i in range(p, p + 4):
            if i >= n:
                raise self.refuse("invalid_json", path, n, n)
            digit = _HEX_VALUE[data[i]]
            if digit < 0:
                raise self.refuse("invalid_json", path, i, _char_end(data, i))
            cp = (cp << 4) | digit
        return cp

    def low_surrogate(self, p: int) -> Optional[int]:
        """The low surrogate named by a ``\\uXXXX`` escape at ``p``, or None if there is none."""
        data = self.data
        if p + 6 > self.n or data[p] != 0x5C or data[p + 1] != 0x75:
            return None
        cp = 0
        for i in range(p + 2, p + 6):
            digit = _HEX_VALUE[data[i]]
            if digit < 0:
                return None
            cp = (cp << 4) | digit
        return cp if 0xDC00 <= cp <= 0xDFFF else None

    def number(self, p: int, path: List[object]) -> Node:
        """Read the longest match of RFC 8259's ``number`` at ``p``."""
        data, n = self.data, self.n
        start = p
        if data[p] == 0x2D:  # -
            p += 1
            if p >= n or not 0x30 <= data[p] <= 0x39:
                raise self.bad_char(path, p)
        if data[p] == 0x30:
            p += 1
        else:
            p = _DIGITS.match(data, p).end()
        kind = INTEGER
        if p < n and data[p] == 0x2E:  # .
            p += 1
            if p >= n or not 0x30 <= data[p] <= 0x39:
                raise self.bad_char(path, p)
            p = _DIGITS.match(data, p).end()
            kind = NUMBER
        if p < n and (data[p] == 0x65 or data[p] == 0x45):  # e E
            p += 1
            if p < n and (data[p] == 0x2B or data[p] == 0x2D):
                p += 1
            if p >= n or not 0x30 <= data[p] <= 0x39:
                raise self.bad_char(path, p)
            p = _DIGITS.match(data, p).end()
            kind = NUMBER
        return Node(kind, start, p, data[start:p].decode("ascii"))

    def literal(self, p: int, path: List[object]) -> Node:
        data, n = self.data, self.n
        word, kind = _LITERALS[data[p]]
        for i, expected in enumerate(word):
            if p + i >= n or data[p + i] != expected:
                raise self.bad_char(path, p + i)
        return Node(kind, p, p + len(word), None)

    def member_head(self, p: int, names: set, frame: list) -> int:
        """Read a member's name and its ``:`` (steps 1 to 3 of an object member).

        On entry ``segs`` is the object's path ``P``; on return it is ``P + [m]``, and ``p``
        is at the member's value.
        """
        data, n, segs = self.data, self.n, self.segs
        if p >= n or data[p] != 0x22:
            raise self.bad_char(segs, p)
        name_start = p
        name, p = self.string(p, segs)
        segs.append(name)
        if name in names:
            raise self.refuse("duplicate_member", segs, name_start, p)
        names.add(name)
        frame[2] = (name, name_start, p)
        p = _WS.match(data, p).end()
        if p >= n or data[p] != 0x3A:
            raise self.bad_char(segs, p)
        return _WS.match(data, p + 1).end()

    # -- the text --

    def read(self, max_json_depth: Optional[int]) -> Node:
        data, n, segs = self.data, self.n, self.segs
        if data[:3] == b"\xef\xbb\xbf":
            raise self.refuse("byte_order_mark", [], 0, 3)
        p = _WS.match(data, 0).end()
        # Open containers: [node, member names (None for an array), pending member].
        stack: List[list] = []
        while True:
            # Read one value at path ``segs``, enclosed by len(stack) open containers.
            if p >= n:
                raise self.refuse("invalid_json", segs, n, n)
            c = data[p]
            if c == 0x7B or c == 0x5B:  # { [
                if max_json_depth is not None and len(stack) + 1 > max_json_depth:
                    raise self.refuse("limit_exceeded", segs, p, p + 1, KIND_JSON_DEPTH)
                start = p
                p = _WS.match(data, p + 1).end()
                if c == 0x5B:
                    node = Node(ARRAY, start, -1, [])
                    if p < n and data[p] == 0x5D:
                        p += 1
                        node.end = p
                        done = node
                    else:
                        stack.append([node, None, None])
                        segs.append(0)
                        continue
                else:
                    node = Node(OBJECT, start, -1, [])
                    if p < n and data[p] == 0x7D:
                        p += 1
                        node.end = p
                        done = node
                    else:
                        frame = [node, set(), None]
                        stack.append(frame)
                        p = self.member_head(p, frame[1], frame)
                        continue
            elif c == 0x22:
                start = p
                content, p = self.string(p, segs)
                done = Node(STRING, start, p, content)
            elif c == 0x2D or 0x30 <= c <= 0x39:
                done = self.number(p, segs)
                p = done.end
            elif c in _LITERALS:
                done = self.literal(p, segs)
                p = done.end
            else:
                raise self.bad_char(segs, p)

            # ``done`` is complete: hand it to its container, closing every container it ends.
            while stack:
                frame = stack[-1]
                node, names = frame[0], frame[1]
                if names is None:
                    node.value.append(done)
                else:
                    name, name_start, name_end = frame[2]
                    node.value.append((name, name_start, name_end, done))
                p = _WS.match(data, p).end()
                if p >= n:
                    raise self.refuse("invalid_json", segs[:-1], n, n)
                c = data[p]
                if c == 0x2C:  # ,
                    p = _WS.match(data, p + 1).end()
                    if names is None:
                        segs[-1] += 1
                    else:
                        segs.pop()
                        p = self.member_head(p, names, frame)
                    break
                if c == (0x5D if names is None else 0x7D):  # ] }
                    p += 1
                    node.end = p
                    segs.pop()
                    stack.pop()
                    done = node
                    continue
                raise self.bad_char(segs[:-1], p)
            else:
                # The root value is complete.
                p = _WS.match(data, p).end()
                if p < n:
                    raise self.refuse("trailing_data", [], p, n)
                return done


def read_json(data: bytes, max_text_bytes: Optional[int], max_json_depth: Optional[int], profile: str) -> Node:
    """Run stages 1 to 3 over ``data`` and return the root of its JSON tree, or refuse."""
    n = len(data)
    if max_text_bytes is not None and n > max_text_bytes:
        raise ProjectionError(profile, "limit_exceeded", (), Span(max_text_bytes, n), KIND_TEXT_BYTES)
    fault = utf8_fault(data)
    if fault is not None:
        raise ProjectionError(profile, "invalid_utf8", (), fault)
    return _Lexer(data, profile).read(max_json_depth)


def as_input_bytes(data: object, caller: str) -> bytes:
    """The input of a byte reader as ``bytes``; a ``str`` is a caller error."""
    if isinstance(data, bytes):
        return data
    if isinstance(data, (bytearray, memoryview)):
        return bytes(data)
    if isinstance(data, str):
        raise TypeError(f"{caller} reads bytes; use parse_str for a str")
    raise TypeError(f"{caller} reads bytes, got {type(data).__name__}")


def str_input_bytes(text: object, caller: str) -> bytes:
    """A host string as the byte reader reads it: its generalized UTF-8 (total §10).

    A lone surrogate becomes the three bytes ``ED A0-BF 80-BF``, which stage 2 refuses as
    ``invalid_utf8`` with the one-byte span at the UTF-8 length of the characters before it.
    """
    if not isinstance(text, str):
        raise TypeError(f"{caller} reads a str, got {type(text).__name__}")
    return text.encode("utf-8", "surrogatepass")
