//! `ontos` — the byte-first inspector CLI (Rust build of the tri-core tool).
//!
//! ```text
//! ontos <command> [--format human|json] [--from-json <json|->] [<hex>]
//! ```
//!
//! Bytes in, evidence out: given canonical `ontos-codec-v1` bytes (a positional
//! hex string, or stdin when the argument is `-` or absent), `ontos decode`
//! decodes them to the L0 value tree and renders it either as the core's `Display`
//! form (`human`) or as the `vectors/` authoring notation (`json`).
//!
//! The one text→bytes affordance is `--from-json <json|->`: the value is *parsed*
//! from the authoring notation (`{"atom":"<hex>"}` | `{"tuple":[ … ]}`) — the exact
//! inverse of the `json` value rendering — instead of decoded from hex. No bytes are
//! decoded; the value is built directly, so it is canonical by construction. It is
//! mutually exclusive with a positional `<hex>` and works with every command. See
//! `docs/spec/ontos-cli.md` "Value input".
//!
//! All four v1 commands are implemented: `decode`, `inspect`, `read`, and `canon`
//! (ontos-internal#18–ontos-internal#21). The `json` output is a stable, byte-comparable contract —
//! compact, fixed key order, lowercase hex, one line terminated by `\n` — so the
//! differential harness can diff it byte-for-byte against the `go`/`ts` builds.
//! See `docs/spec/ontos-cli.md`.

use std::io::{self, Read};
use std::process::ExitCode;

use ontos_codec::{decode, encode, DecodeError};
use ontos_core::Value;
use ontos_data::{
    read_bool, read_list, read_map, read_null, read_set, read_text, recognize_decimal,
    recognize_int,
};

const VERSION_LINE: &str = "ontos 0.1.0";
const CODEC_ID: &str = "ontos-codec-v1";

const USAGE: &str = "\
Usage: ontos <command> [--format human|json] [--from-json <json|->] [<hex>]

Commands:
  decode [<hex>]                       decode ontos-codec-v1 bytes to the L0 value tree
  inspect [<hex>]                      decode + report codec id, canonical?, value, recognized
  read [--all|--kind <k>] [<hex>]      recognize registered embeddings (int|utf8-text|bool|list|map|set|decimal|null)
  canon [--check|--emit] [<hex>]       is the input canonical (--check), or emit canonical hex (--emit)

Options:
  -f, --format <human|json>   output format (default: human)
      --from-json <json|->    build the value from the authoring notation
                              ({\"atom\":\"<hex>\"}|{\"tuple\":[ … ]}) instead of hex
                              (`-` reads from stdin); mutually exclusive with <hex>
  -h, --help                  print this help and exit
  -V, --version               print version and exit

Input is canonical ontos-codec-v1 bytes as a hex string, or read from stdin
when the hex argument is `-` or omitted. With --from-json the value is parsed
from the authoring notation instead (canonical by construction).";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Human,
    Json,
}

/// Parsed command line, or an early exit (help/version) / usage error.
enum Parsed {
    /// A command to run, with its chosen format, optional positional hex, optional
    /// `--from-json` authoring source, and any command-specific flags (e.g. `--all`,
    /// `--kind <k>`, `--check`, `--emit`) gathered verbatim for the command to
    /// interpret.
    Run {
        command: String,
        format: Format,
        hex: Option<String>,
        from_json: Option<String>,
        flags: Vec<String>,
    },
    /// `--help`/`--version`: print `text` to stdout and exit 0.
    PrintAndExit { text: String },
    /// A usage error: `message` to stderr, exit 2.
    Usage { message: String },
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args) {
        Parsed::PrintAndExit { text } => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Parsed::Usage { message } => {
            eprintln!("ontos: {message}");
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
        Parsed::Run {
            command,
            format,
            hex,
            from_json,
            flags,
        } => run(&command, format, hex, from_json, &flags),
    }
}

/// Parse `ontos <command> [--format <fmt>] [<hex>]`.
///
/// `--help`/`-h` and `--version`/`-V` are honored before command validation so
/// `ontos --help` works. Flags may appear before or after the positional hex.
fn parse_args(args: &[String]) -> Parsed {
    let mut command: Option<String> = None;
    let mut format = Format::Human;
    let mut hex: Option<String> = None;
    let mut from_json: Option<String> = None;
    let mut flags: Vec<String> = Vec::new();
    let mut i = 0;

    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-h" | "--help" => return Parsed::PrintAndExit { text: USAGE.into() },
            "-V" | "--version" => {
                return Parsed::PrintAndExit {
                    text: VERSION_LINE.into(),
                }
            }
            "-f" | "--format" => {
                i += 1;
                let Some(value) = args.get(i) else {
                    return Parsed::Usage {
                        message: format!("flag `{arg}` needs a value (human|json)"),
                    };
                };
                match parse_format(value) {
                    Some(f) => format = f,
                    None => {
                        return Parsed::Usage {
                            message: format!("unknown format `{value}` (expected human|json)"),
                        }
                    }
                }
            }
            _ if arg == "-" => {
                if hex.is_some() {
                    return Parsed::Usage {
                        message: "unexpected extra argument".into(),
                    };
                }
                hex = Some(arg.clone());
            }
            _ if arg.starts_with("--format=") => {
                let value = &arg["--format=".len()..];
                match parse_format(value) {
                    Some(f) => format = f,
                    None => {
                        return Parsed::Usage {
                            message: format!("unknown format `{value}` (expected human|json)"),
                        }
                    }
                }
            }
            // `--from-json <json|->`: an alternative input source to the positional
            // hex. The value (even `-`, the stdin marker) is consumed here so it is
            // never mistaken for the positional argument. Repeating it is a usage
            // error; mutual exclusion with `<hex>` is checked after parsing.
            "--from-json" => {
                i += 1;
                let Some(value) = args.get(i) else {
                    return Parsed::Usage {
                        message: "flag `--from-json` needs a value (<json> or `-` for stdin)"
                            .into(),
                    };
                };
                if from_json.is_some() {
                    return Parsed::Usage {
                        message: "flag `--from-json` given more than once".into(),
                    };
                }
                from_json = Some(value.clone());
            }
            _ if arg.starts_with("--from-json=") => {
                if from_json.is_some() {
                    return Parsed::Usage {
                        message: "flag `--from-json` given more than once".into(),
                    };
                }
                from_json = Some(arg["--from-json=".len()..].to_string());
            }
            // `--kind <k>` takes a separate value; consume it here so the command
            // parser sees a single `--kind=<k>` token. (`--kind=<k>` falls through
            // to the generic flag collector below.)
            "--kind" => {
                i += 1;
                let Some(value) = args.get(i) else {
                    return Parsed::Usage {
                        message:
                            "flag `--kind` needs a value (int|utf8-text|bool|list|map|set|decimal|null)"
                                .into(),
                    };
                };
                flags.push(format!("--kind={value}"));
            }
            // Any other leading-dash token is a command-specific flag (`--all`,
            // `--kind=<k>`, `--check`, `--emit`): gather it for the command to
            // interpret rather than rejecting it globally.
            _ if arg.starts_with('-') => flags.push(arg.clone()),
            _ if command.is_none() => command = Some(arg.clone()),
            _ if hex.is_none() => hex = Some(arg.clone()),
            _ => {
                return Parsed::Usage {
                    message: "unexpected extra argument".into(),
                }
            }
        }
        i += 1;
    }

    let Some(command) = command else {
        return Parsed::Usage {
            message: "missing command".into(),
        };
    };

    Parsed::Run {
        command,
        format,
        hex,
        from_json,
        flags,
    }
}

fn parse_format(value: &str) -> Option<Format> {
    match value {
        "human" => Some(Format::Human),
        "json" => Some(Format::Json),
        _ => None,
    }
}

/// Dispatch a parsed command.
fn run(
    command: &str,
    format: Format,
    hex: Option<String>,
    from_json: Option<String>,
    flags: &[String],
) -> ExitCode {
    match command {
        "decode" => run_decode(format, hex, from_json, flags),
        "inspect" => run_inspect(format, hex, from_json, flags),
        "read" => run_read(format, hex, from_json, flags),
        "canon" => run_canon(format, hex, from_json, flags),
        other => {
            eprintln!("ontos: unknown command `{other}`");
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

/// The fixed order in which the registered embeddings are reported by `inspect`
/// and `read --all`, filtered to the matches. A top-level value is a well-formed
/// instance of at most one of these (by its label).
const KINDS: [&str; 8] = [
    "int",
    "utf8-text",
    "bool",
    "list",
    "map",
    "set",
    "decimal",
    "null",
];

/// Recognize `value` against each registered embedding in `KINDS` order, keeping
/// the labels whose recognizer (`recognizes()`) succeeds. A bare atom matches none -> `[]`.
fn recognized_kinds(value: &Value) -> Vec<&'static str> {
    KINDS
        .into_iter()
        .filter(|kind| recognizes(kind, value))
        .collect()
}

/// Whether `value` is a well-formed canonical instance of the embedding `kind`.
///
/// `int`/`decimal` use the structural recognizer (`recognize_int`/`recognize_decimal`),
/// NOT `read_*`: a canonical value whose mantissa/magnitude exceeds a binding's host
/// integer width is still recognized — the materialization limit is not a recognition
/// miss (ontos-data.md §5.1/§5.9), so all cores agree here.
fn recognizes(kind: &str, value: &Value) -> bool {
    match kind {
        "int" => recognize_int(value).is_ok(),
        "utf8-text" => read_text(value).is_ok(),
        "bool" => read_bool(value).is_ok(),
        "list" => read_list(value).is_ok(),
        "map" => read_map(value).is_ok(),
        "set" => read_set(value).is_ok(),
        "decimal" => recognize_decimal(value).is_ok(),
        "null" => read_null(value).is_ok(),
        _ => false,
    }
}

/// The canonical `human`-format rendering of the recognized labels, shared by
/// `inspect` and `read --all` so both lines match the other cores byte-for-byte.
///
/// Labels are joined by `", "` (comma-space); the empty case renders `none`. This
/// is the tri-core human-output contract (docs/spec/ontos-cli.md "Human format",
/// ontos-internal#46), enforced by the conformance harness `--human-roundtrip` mode.
fn human_labels(labels: &[&str]) -> String {
    if labels.is_empty() {
        "none".to_string()
    } else {
        labels.join(", ")
    }
}

/// Append a JSON array of string labels (`["map"]`, `[]`) to `out`, compact.
fn push_labels_json(labels: &[&str], out: &mut String) {
    out.push('[');
    for (index, label) in labels.iter().enumerate() {
        if index != 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(label);
        out.push('"');
    }
    out.push(']');
}

/// `ontos decode [<hex>]` — decode the bytes to the L0 value tree.
fn run_decode(
    format: Format,
    hex: Option<String>,
    from_json: Option<String>,
    flags: &[String],
) -> ExitCode {
    if let Some(flag) = flags.first() {
        return unknown_flag("decode", flag);
    }
    let value = match resolve_value("decode", format, hex, from_json) {
        Ok(value) => value,
        Err(code) => return code,
    };

    match format {
        Format::Human => println!("{value}"),
        Format::Json => {
            let mut out = String::new();
            out.push_str(r#"{"ok":true,"command":"decode","codec":""#);
            out.push_str(CODEC_ID);
            out.push_str(r#"","value":"#);
            push_authoring_json(&value, &mut out);
            out.push('}');
            println!("{out}");
        }
    }
    ExitCode::SUCCESS
}

/// `ontos inspect [<hex>]` — decode + report codec id, canonical?, value, and the
/// registered embeddings recognized at the top level.
fn run_inspect(
    format: Format,
    hex: Option<String>,
    from_json: Option<String>,
    flags: &[String],
) -> ExitCode {
    if let Some(flag) = flags.first() {
        return unknown_flag("inspect", flag);
    }
    let (input, value) = match resolve_value_with_input("inspect", format, hex, from_json) {
        Ok(pair) => pair,
        Err(code) => return code,
    };

    // canonical = re-encoding the decoded value equals the input bytes. Decode only
    // accepts canonical bytes, so this is true whenever decode succeeded.
    let canonical = encode(&value) == input;
    let recognized = recognized_kinds(&value);

    match format {
        Format::Human => {
            println!("{value}");
            println!("canonical: {}", if canonical { "yes" } else { "no" });
            println!("recognized: {}", human_labels(&recognized));
        }
        Format::Json => {
            let mut out = String::new();
            out.push_str(r#"{"ok":true,"command":"inspect","codec":""#);
            out.push_str(CODEC_ID);
            out.push_str(r#"","canonical":"#);
            out.push_str(if canonical { "true" } else { "false" });
            out.push_str(r#","value":"#);
            push_authoring_json(&value, &mut out);
            out.push_str(r#","recognized":"#);
            push_labels_json(&recognized, &mut out);
            out.push('}');
            println!("{out}");
        }
    }
    ExitCode::SUCCESS
}

/// `ontos read [--all | --kind <kind>] [<hex>]` — recognize registered embeddings.
fn run_read(
    format: Format,
    hex: Option<String>,
    from_json: Option<String>,
    flags: &[String],
) -> ExitCode {
    // Parse the command-specific flags: exactly one of `--all` or `--kind <k>`.
    let mut all = false;
    let mut kind: Option<String> = None;
    for flag in flags {
        if flag == "--all" {
            all = true;
        } else if let Some(value) = flag.strip_prefix("--kind=") {
            kind = Some(value.to_string());
        } else {
            return unknown_flag("read", flag);
        }
    }

    // An unknown --kind value is a usage error (before any decode).
    if let Some(k) = &kind {
        if !KINDS.contains(&k.as_str()) {
            eprintln!(
                "ontos: unknown kind `{k}` (expected int|utf8-text|bool|list|map|set|decimal|null)"
            );
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    }
    // Exactly one selector is required; neither (or both) is a usage error.
    match (all, &kind) {
        (false, None) => {
            eprintln!("ontos: read needs --all or --kind <kind>");
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
        (true, Some(_)) => {
            eprintln!("ontos: read takes --all or --kind, not both");
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
        _ => {}
    }

    let value = match resolve_value("read", format, hex, from_json) {
        Ok(value) => value,
        Err(code) => return code,
    };

    if let Some(k) = kind {
        let recognized = recognizes(&k, &value);
        match format {
            // Canonical human form: `<kind>: yes|no` (docs/spec/ontos-cli.md "Human
            // format") — names the probed kind, matching go/ts byte-for-byte.
            Format::Human => println!("{k}: {}", if recognized { "yes" } else { "no" }),
            Format::Json => {
                let mut out = String::new();
                out.push_str(r#"{"ok":true,"command":"read","kind":""#);
                out.push_str(&k);
                out.push_str(r#"","recognized":"#);
                out.push_str(if recognized { "true" } else { "false" });
                out.push('}');
                println!("{out}");
            }
        }
        return if recognized {
            ExitCode::SUCCESS
        } else {
            ExitCode::from(1)
        };
    }

    // `--all`: try each embedding, report the matches, always exit 0.
    let recognized = recognized_kinds(&value);
    match format {
        Format::Human => println!("recognized: {}", human_labels(&recognized)),
        Format::Json => {
            let mut out = String::new();
            out.push_str(r#"{"ok":true,"command":"read","recognized":"#);
            push_labels_json(&recognized, &mut out);
            out.push('}');
            println!("{out}");
        }
    }
    ExitCode::SUCCESS
}

/// `ontos canon [--check | --emit] [<hex>]` — canonical byte witness. Default
/// (neither flag) is `--check`.
fn run_canon(
    format: Format,
    hex: Option<String>,
    from_json: Option<String>,
    flags: &[String],
) -> ExitCode {
    let mut check = false;
    let mut emit = false;
    for flag in flags {
        match flag.as_str() {
            "--check" => check = true,
            "--emit" => emit = true,
            other => return unknown_flag("canon", other),
        }
    }
    if check && emit {
        eprintln!("ontos: canon takes --check or --emit, not both");
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    }

    let (input, value) = match resolve_value_with_input("canon", format, hex, from_json) {
        Ok(pair) => pair,
        Err(code) => return code,
    };

    if emit {
        // --emit: print the canonical bytes as hex; decode the hex before hashing it.
        let canon_bytes = encode(&value);
        match format {
            Format::Human => {
                let mut out = String::new();
                push_hex(&canon_bytes, &mut out);
                println!("{out}");
            }
            Format::Json => {
                let mut out = String::new();
                out.push_str(r#"{"ok":true,"command":"canon","hex":""#);
                push_hex(&canon_bytes, &mut out);
                out.push_str(r#""}"#);
                println!("{out}");
            }
        }
        return ExitCode::SUCCESS;
    }

    // --check (the default): is the input canonical (decodes AND re-encodes to the
    // same bytes)? True whenever decode succeeded.
    let _ = check;
    let canonical = encode(&value) == input;
    match format {
        Format::Human => println!("canonical: {}", if canonical { "yes" } else { "no" }),
        Format::Json => {
            let mut out = String::new();
            out.push_str(r#"{"ok":true,"command":"canon","canonical":"#);
            out.push_str(if canonical { "true" } else { "false" });
            out.push('}');
            println!("{out}");
        }
    }
    ExitCode::SUCCESS
}

/// Emit an unknown-flag usage error (exit 2) for `command`.
fn unknown_flag(command: &str, flag: &str) -> ExitCode {
    eprintln!("ontos: unknown flag `{flag}` for `{command}`");
    eprintln!("{USAGE}");
    ExitCode::from(2)
}

/// Resolve the value for `command` from its one input source — the positional hex
/// (decoded via `ontos-codec-v1`) or `--from-json` (parsed from the authoring
/// notation) — discarding the input bytes.
fn resolve_value(
    command: &str,
    format: Format,
    hex: Option<String>,
    from_json: Option<String>,
) -> Result<Value, ExitCode> {
    resolve_value_with_input(command, format, hex, from_json).map(|(_, value)| value)
}

/// Resolve the value for `command` and the bytes it corresponds to.
///
/// Exactly one source is used. `--from-json` together with a positional `<hex>` is
/// a `usage_error` (exit 2). With `--from-json` the value is *built* from the
/// authoring notation and the bytes are its canonical encoding (canonical by
/// construction); otherwise the hex is decoded via `ontos-codec-v1`.
fn resolve_value_with_input(
    command: &str,
    format: Format,
    hex: Option<String>,
    from_json: Option<String>,
) -> Result<(Vec<u8>, Value), ExitCode> {
    if let Some(json_src) = from_json {
        // `--from-json` together with ANY positional is a usage error — including the
        // `-` stdin sentinel. `-` still names a bytes source (stdin), so combining it
        // with `--from-json` (which is its own source) is equally ambiguous; we adopt
        // the stricter Go/TS rule here so the three cores agree (ontos-internal#45,
        // docs/spec/ontos-cli.md "Value input").
        if hex.is_some() {
            let message = "--from-json cannot be combined with a positional <hex>";
            return Err(usage_error(command, format, message));
        }
        let text = match resolve_json_text(json_src) {
            Ok(text) => text,
            Err(message) => {
                eprintln!("ontos: {message}");
                return Err(ExitCode::from(2));
            }
        };
        // Parse + structurally validate the authoring notation. Any malformed input
        // is the stable `invalid_json` error (exit 2).
        let value = match parse_authoring(&text) {
            Ok(value) => value,
            Err(()) => return Err(decode_error(command, "invalid_json", format, 2)),
        };
        // The value was built, not decoded, so its canonical encoding is the input.
        let bytes = encode(&value);
        return Ok((bytes, value));
    }

    decode_hex_with_input(command, format, hex)
}

/// Resolve the hex input, convert it to bytes, and decode it for `command`,
/// returning both the input bytes and the decoded value on success.
///
/// On failure this writes the negative/usage result (json line or stderr) and
/// returns the appropriate `ExitCode`: invalid hex / missing input is a usage
/// error (exit 2); a `DecodeError` is a well-formed negative result (exit 1).
fn decode_hex_with_input(
    command: &str,
    format: Format,
    hex: Option<String>,
) -> Result<(Vec<u8>, Value), ExitCode> {
    let input = match resolve_input(hex) {
        Ok(input) => input,
        Err(message) => {
            eprintln!("ontos: {message}");
            return Err(ExitCode::from(2));
        }
    };

    // (1) hex -> bytes. Invalid hex is a usage error (exit 2).
    let bytes = match hex_to_bytes(&input) {
        Ok(bytes) => bytes,
        Err(()) => return Err(decode_error(command, "invalid_hex", format, 2)),
    };

    // (2) decode. A DecodeError is a well-formed negative result (exit 1).
    match decode(&bytes) {
        Ok(value) => Ok((bytes, value)),
        Err(err) => Err(decode_decode_error(command, &err, format)),
    }
}

/// Resolve the hex input: the positional arg, or stdin when it is `-`/absent.
/// Surrounding whitespace is stripped.
fn resolve_input(hex: Option<String>) -> Result<String, String> {
    match hex {
        Some(ref s) if s != "-" => Ok(s.trim().to_string()),
        _ => read_stdin(),
    }
}

fn read_stdin() -> Result<String, String> {
    let mut buf = String::new();
    io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| format!("failed to read stdin: {e}"))?;
    Ok(buf.trim().to_string())
}

/// Resolve the `--from-json` source text: the literal argument, or stdin when it is
/// `-`. Surrounding whitespace is stripped (mirroring the hex path).
fn resolve_json_text(src: String) -> Result<String, String> {
    if src == "-" {
        read_stdin()
    } else {
        Ok(src.trim().to_string())
    }
}

/// Emit a `usage_error` (exit 2) for `command`: the stable code as a json line in
/// json format, or a diagnostic on stderr (with the usage banner) in human format.
fn usage_error(command: &str, format: Format, message: &str) -> ExitCode {
    if format == Format::Json {
        println!(r#"{{"ok":false,"command":"{command}","error":"usage_error"}}"#);
    } else {
        eprintln!("ontos: {message}");
        eprintln!("{USAGE}");
    }
    ExitCode::from(2)
}

/// Emit a decode `DecodeError` as a negative result (exit 1): the stable code on
/// stdout in json, the diagnostic on stderr in human.
fn decode_decode_error(command: &str, err: &DecodeError, format: Format) -> ExitCode {
    match format {
        Format::Human => {
            eprintln!("ontos: decode failed: {err}");
            ExitCode::from(1)
        }
        Format::Json => decode_error(command, err.code(), format, 1),
    }
}

/// Print the json error object for `command` and return `code`. In human format
/// only the exit code is returned (the caller has already written stderr).
fn decode_error(command: &str, error: &str, format: Format, code: u8) -> ExitCode {
    if format == Format::Json {
        println!(r#"{{"ok":false,"command":"{command}","error":"{error}"}}"#);
    } else {
        eprintln!("ontos: {command}: {error}");
    }
    ExitCode::from(code)
}

// ----- `--from-json`: authoring notation -> core `Value` ---------------------
//
// The exact inverse of `push_authoring_json`. Parsing is two stages, mirroring the
// `go` (encoding/json) and `ts` (JSON.parse) peers so all three share one structural
// validation and agree on `invalid_json` even where their raw tokenizers differ on
// exotic syntax:
//   (1) a hand-rolled, dependency-free JSON tokenizer -> a generic `JsonValue`
//       (no serde, like the hand-rolled JSON *output* already here);
//   (2) structural validation of that tree into the authoring shape
//       (`{atom}` | `{tuple}`) -> a core `Value`.
// Any failure in either stage is the single stable `invalid_json` result (`Err(())`).

/// A generic JSON value, the output of the stage-(1) tokenizer. Numbers are kept as
/// their source slice (never needed numerically — they are only ever rejected).
enum JsonValue {
    Null,
    Bool,
    Number,
    String(String),
    Array(Vec<JsonValue>),
    Object(Vec<(String, JsonValue)>),
}

/// A dependency-free recursive-descent JSON tokenizer. Accepts the JSON grammar
/// (RFC 8259) strictly enough that malformed input is rejected; the *shape* is then
/// checked in stage (2). Returns `Err(())` on any syntax error.
struct JsonParser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> JsonParser<'a> {
    fn new(text: &'a str) -> Self {
        JsonParser {
            bytes: text.as_bytes(),
            pos: 0,
        }
    }

    /// Parse a whole document: one value, then only trailing whitespace.
    fn parse_document(&mut self) -> Result<JsonValue, ()> {
        self.skip_ws();
        let value = self.parse_value()?;
        self.skip_ws();
        if self.pos != self.bytes.len() {
            return Err(()); // trailing junk after the value
        }
        Ok(value)
    }

    fn skip_ws(&mut self) {
        while let Some(&b) = self.bytes.get(self.pos) {
            // JSON insignificant whitespace: space, tab, LF, CR.
            if matches!(b, b' ' | b'\t' | b'\n' | b'\r') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    /// Consume an exact ASCII literal (`true`/`false`/`null`) or fail.
    fn eat_literal(&mut self, lit: &[u8]) -> Result<(), ()> {
        if self.bytes[self.pos..].starts_with(lit) {
            self.pos += lit.len();
            Ok(())
        } else {
            Err(())
        }
    }

    fn parse_value(&mut self) -> Result<JsonValue, ()> {
        self.skip_ws();
        match self.peek().ok_or(())? {
            b'{' => self.parse_object(),
            b'[' => self.parse_array(),
            b'"' => Ok(JsonValue::String(self.parse_string()?)),
            b't' => {
                self.eat_literal(b"true")?;
                Ok(JsonValue::Bool)
            }
            b'f' => {
                self.eat_literal(b"false")?;
                Ok(JsonValue::Bool)
            }
            b'n' => {
                self.eat_literal(b"null")?;
                Ok(JsonValue::Null)
            }
            b'-' | b'0'..=b'9' => self.parse_number(),
            _ => Err(()),
        }
    }

    fn parse_object(&mut self) -> Result<JsonValue, ()> {
        self.pos += 1; // consume '{'
        let mut entries: Vec<(String, JsonValue)> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(JsonValue::Object(entries));
        }
        loop {
            self.skip_ws();
            if self.peek() != Some(b'"') {
                return Err(()); // a key must be a string
            }
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(());
            }
            self.pos += 1; // ':'
            let value = self.parse_value()?;
            entries.push((key, value));
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(JsonValue::Object(entries));
                }
                _ => return Err(()),
            }
        }
    }

    fn parse_array(&mut self) -> Result<JsonValue, ()> {
        self.pos += 1; // consume '['
        let mut items: Vec<JsonValue> = Vec::new();
        self.skip_ws();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(JsonValue::Array(items));
        }
        loop {
            let item = self.parse_value()?;
            items.push(item);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                    continue;
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(JsonValue::Array(items));
                }
                _ => return Err(()),
            }
        }
    }

    /// Parse a JSON string (the leading `"` is at `self.pos`). Honors the standard
    /// escapes including `\uXXXX` (and surrogate pairs). The decoded text is kept so
    /// stage (2) can validate an `atom`'s hex; control characters are rejected.
    fn parse_string(&mut self) -> Result<String, ()> {
        self.pos += 1; // opening quote
        let mut out = String::new();
        loop {
            let b = *self.bytes.get(self.pos).ok_or(())?;
            match b {
                b'"' => {
                    self.pos += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.pos += 1;
                    let esc = *self.bytes.get(self.pos).ok_or(())?;
                    self.pos += 1;
                    match esc {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => out.push(self.parse_unicode_escape()?),
                        _ => return Err(()),
                    }
                }
                // Unescaped control characters are not allowed in JSON strings.
                0x00..=0x1f => return Err(()),
                _ => {
                    // Copy one UTF-8 code point verbatim (the source is valid UTF-8).
                    let ch = self.next_utf8_char()?;
                    out.push(ch);
                }
            }
        }
    }

    /// Decode a `\uXXXX` escape (the `\u` is already consumed), combining a
    /// high+low surrogate pair when present.
    fn parse_unicode_escape(&mut self) -> Result<char, ()> {
        let first = self.read_hex4()?;
        if (0xd800..=0xdbff).contains(&first) {
            // High surrogate: must be followed by `\uXXXX` low surrogate.
            if self.bytes.get(self.pos) != Some(&b'\\')
                || self.bytes.get(self.pos + 1) != Some(&b'u')
            {
                return Err(());
            }
            self.pos += 2;
            let second = self.read_hex4()?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err(());
            }
            let cp = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
            char::from_u32(cp).ok_or(())
        } else if (0xdc00..=0xdfff).contains(&first) {
            Err(()) // lone low surrogate
        } else {
            char::from_u32(first).ok_or(())
        }
    }

    /// Read exactly four hex digits as a u32.
    fn read_hex4(&mut self) -> Result<u32, ()> {
        let mut value = 0u32;
        for _ in 0..4 {
            let c = *self.bytes.get(self.pos).ok_or(())?;
            let digit = match c {
                b'0'..=b'9' => c - b'0',
                b'a'..=b'f' => c - b'a' + 10,
                b'A'..=b'F' => c - b'A' + 10,
                _ => return Err(()),
            };
            value = value * 16 + u32::from(digit);
            self.pos += 1;
        }
        Ok(value)
    }

    /// Consume one UTF-8 scalar at `self.pos` (source is guaranteed valid UTF-8).
    fn next_utf8_char(&mut self) -> Result<char, ()> {
        let rest = std::str::from_utf8(&self.bytes[self.pos..]).map_err(|_| ())?;
        let ch = rest.chars().next().ok_or(())?;
        self.pos += ch.len_utf8();
        Ok(ch)
    }

    /// Parse and validate a JSON number's syntax, discarding the value (it is only
    /// ever rejected by stage (2)).
    fn parse_number(&mut self) -> Result<JsonValue, ()> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => {
                while matches!(self.peek(), Some(b'0'..=b'9')) {
                    self.pos += 1;
                }
            }
            _ => return Err(()),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(());
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(());
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let _ = start;
        Ok(JsonValue::Number)
    }
}

/// Parse the `--from-json` authoring notation into a core `Value`, or `Err(())` for
/// the stable `invalid_json` result. Stage (1) tokenizes; stage (2) validates shape.
fn parse_authoring(text: &str) -> Result<Value, ()> {
    let json = JsonParser::new(text).parse_document()?;
    validate_authoring(&json)
}

/// Stage (2): structurally validate a parsed `JsonValue` into a core `Value`.
///
/// A value is a JSON object with EXACTLY ONE of `atom` or `tuple` (no extra keys,
/// neither/both rejected). `atom` is an even-length lowercase-hex string; `tuple`
/// is an array of values (recursively). Any deviation is `Err(())`.
fn validate_authoring(node: &JsonValue) -> Result<Value, ()> {
    let JsonValue::Object(entries) = node else {
        return Err(()); // a value must be an object
    };
    // Duplicate keys resolve last-value-wins, matching `encoding/json` (Go) and
    // `JSON.parse` (TS) so all three cores agree byte-for-byte on every input. After
    // that collapse the object must have EXACTLY ONE distinct key, `atom` or `tuple`
    // (`atom`+`tuple`, or any extra/other key, are two distinct keys -> rejected).
    let mut distinct: Vec<(&String, &JsonValue)> = Vec::new();
    for (k, v) in entries {
        match distinct.iter_mut().find(|(dk, _)| *dk == k) {
            Some(slot) => slot.1 = v,
            None => distinct.push((k, v)),
        }
    }
    if distinct.len() != 1 {
        return Err(());
    }
    let (key, value) = distinct[0];
    match key.as_str() {
        "atom" => {
            let JsonValue::String(hex) = value else {
                return Err(()); // atom payload must be a string
            };
            let bytes = parse_lower_hex(hex)?;
            Ok(Value::atom(bytes))
        }
        "tuple" => {
            let JsonValue::Array(items) = value else {
                return Err(()); // tuple payload must be an array
            };
            let mut children = Vec::with_capacity(items.len());
            for item in items {
                children.push(validate_authoring(item)?);
            }
            Ok(Value::tuple(children))
        }
        _ => Err(()), // the single key is neither atom nor tuple
    }
}

// ----- the two hex decoders are an intentional, case-sensitivity-split PAIR -----
//
// `ontos` has two hex→bytes decoders that look near-identical but differ ONLY in
// case handling, and that difference is load-bearing — do NOT "dedup" them into one
// (ontos-internal#56):
//
//   * `parse_lower_hex` / `lower_hex_nibble` (below) — STRICT LOWERCASE. Used for the
//     `--from-json` authoring `atom` payload, which is the exact inverse of the
//     `--format json` value rendering: that rendering only ever emits lowercase hex,
//     so accepting uppercase here would let a non-round-tripping form in and break the
//     cross-core agreement (Go's `authoringHex` and TS's `lowerHexNibble` reject
//     uppercase for the same reason).
//   * `hex_to_bytes` / `hex_nibble` (further below) — MIXED CASE. Used for the
//     positional `<hex>` input, where a human pasting bytes may use either case (Go's
//     `hex.DecodeString` and TS's `hexNibble` likewise accept both).
//
// Keep the pair separate; a single "case-insensitive everywhere" helper would silently
// loosen the authoring notation.

/// Parse an even-length string of *lowercase* hex digits to bytes (`""` -> empty).
/// `Err(())` on odd length, an uppercase digit, or any non-hex character.
/// The strict-lowercase half of the decoder pair documented above (authoring input).
fn parse_lower_hex(s: &str) -> Result<Vec<u8>, ()> {
    if !s.len().is_multiple_of(2) {
        return Err(());
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = lower_hex_nibble(bytes[i])?;
        let lo = lower_hex_nibble(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

/// A single lowercase hex digit -> nibble. Uppercase `A`–`F` is rejected (the
/// authoring notation is strictly lowercase, matching the `json` output).
fn lower_hex_nibble(c: u8) -> Result<u8, ()> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        _ => Err(()),
    }
}

/// Append the authoring-notation JSON for `value` to `out`.
///
/// `Atom(bytes)` -> `{"atom":"<lowercase-hex>"}`, `Tuple(items)` ->
/// `{"tuple":[<child>,...]}`, recursively. Compact, no spaces — this is the
/// byte-comparable contract.
fn push_authoring_json(value: &Value, out: &mut String) {
    match value {
        Value::Atom(atom) => {
            out.push_str(r#"{"atom":""#);
            push_hex(atom.bytes(), out);
            out.push_str(r#""}"#);
        }
        Value::Tuple(tuple) => {
            out.push_str(r#"{"tuple":["#);
            for (index, item) in tuple.items().iter().enumerate() {
                if index != 0 {
                    out.push(',');
                }
                push_authoring_json(item, out);
            }
            out.push_str("]}");
        }
    }
}

/// Append the lowercase hex of `bytes` to `out`.
fn push_hex(bytes: &[u8], out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
}

/// Parse an even-length string of hex digits to bytes. `Err(())` on odd length
/// or any non-hex character. Whitespace must already be stripped by the caller.
/// The mixed-case half of the decoder pair documented above `parse_lower_hex`
/// (positional `<hex>` input — uppercase A–F accepted).
fn hex_to_bytes(s: &str) -> Result<Vec<u8>, ()> {
    if !s.len().is_multiple_of(2) {
        return Err(());
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = hex_nibble(bytes[i])?;
        let lo = hex_nibble(bytes[i + 1])?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

/// A single hex digit -> nibble, MIXED case (accepts `A`–`F`). The mixed-case
/// counterpart of `lower_hex_nibble`; see the pair note above `parse_lower_hex`.
fn hex_nibble(c: u8) -> Result<u8, ()> {
    match c {
        b'0'..=b'9' => Ok(c - b'0'),
        b'a'..=b'f' => Ok(c - b'a' + 10),
        b'A'..=b'F' => Ok(c - b'A' + 10),
        _ => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::KINDS;

    /// The CLI keeps its own `KINDS` list (deliberate: the CLI does not have to depend
    /// on the data module's labels being exported — see the note at its definition).
    /// But that duplication must never silently drift from the data module's ordered
    /// `LABELS`, because the order is part of the `recognized` JSON contract that the
    /// tri-core harness pins. This test makes the deliberate duplication safe: if either
    /// list is reordered or a label is added/removed on only one side, it fails here.
    /// (Belt-and-suspenders for ontos-internal#49, which exported `LABELS` and added the
    /// per-core data tests; this is the CLI-side half. Do NOT reopen ontos-internal#49.)
    #[test]
    fn cli_kinds_match_data_labels_order() {
        assert_eq!(
            KINDS.as_slice(),
            ontos_data::LABELS.as_slice(),
            "CLI KINDS drifted from ontos_data::LABELS (order is part of the recognized contract)"
        );
    }
}
