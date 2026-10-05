# producer-conformance — the adapter protocol

An adapter builds a **host value** natively from a recipe, runs the blessed producer,
and reports what happened. One process per case; no shell.

## Invocation — positional, never JSON

```
<adapter> <kind> <arg>
```

| kind    | arg                         | builds |
| ------- | --------------------------- | ------ |
| `int`   | decimal string, may be huge | the language's exact integer |
| `bool`  | `true` \| `false`           | the language's boolean |
| `text`  | comma-separated Unicode **scalar values** (decimal) | a native string |
| `utf16` | comma-separated UTF-16 **code units** (decimal)     | a native string, where the language has UTF-16 strings |
| `bytes` | hex, e.g. `80`              | a native string carrying raw bytes, where the language allows it |

**Positional rather than a JSON argv token, deliberately.** ontos is a zero-dependency
repo — the cores and the CLI avoid `serde`/`clap` on purpose — so requiring every
adapter to parse JSON would either add a dependency to the Rust lane or force four
hand-rolled parsers whose bugs would be indistinguishable from producer bugs. The
recipe is small enough that positional args cost nothing.

**Text is carried as numbers, never as a string.** A JSON string cannot portably
transport a lone surrogate or invalid UTF-8, so a string-carried recipe would be
silently repaired in transit by whichever parser touched it — the same class of defect
this corpus exists to detect.

## Output — exactly one JSON line on stdout

```json
{"status":"ok","hex":"01.."}             canonical ontos-codec-v1 bytes
{"status":"error","code":"invalid_utf8"} a classified producer rejection
{"status":"unsupported","reason":"..."}  the host value is unconstructible here
```

`unsupported` is **not** a failure. It is how a language says the input cannot exist
in it — Rust cannot build an invalid `&str`, Go has no UTF-16 string, a Python `str`
cannot hold arbitrary bytes. The runner treats it as inapplicable. This is what keeps
*"mechanisms may differ; outcome classes may not"* (ontos-data.md §4.1) honest rather
than forcing every language to fake the same invalid states.

An `UNCLASSIFIED:<Type>` code means the producer let a **non-profile** exception
escape — a §4.1 law-3 violation. Adapters report it verbatim rather than normalizing
it, so the harness can see the leak instead of hiding it.
