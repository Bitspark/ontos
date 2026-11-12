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

use std::collections::HashMap;
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
    // `args_os`, not `args`: `args` panics on an argument that is not Unicode. Such an
    // argument is read with U+FFFD in place of each bad sequence, as Node reads argv
    // (docs/spec/ontos-cli.md "Value input"): it then fails as hex, as a flag, or as
    // JSON exactly where U+FFFD would.
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
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
        // Read the text, then check the authoring shape (two stages, below).
        let value = match parse_authoring(&text) {
            Ok(value) => value,
            // Deeper than any value the default decoder accepts: `limit_exceeded`,
            // exit 1, exactly as a decode limit (ontos-cli.md "Value input").
            Err(JsonFault::TooDeep) => {
                return Err(decode_error(command, "limit_exceeded", format, 1))
            }
            Err(JsonFault::Malformed) => {
                return Err(decode_error(command, "invalid_json", format, 2))
            }
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
        Some(ref s) if s != "-" => Ok(trim_hex_input(s).to_string()),
        _ => read_stdin(),
    }
}

/// Read all of stdin as text. Bytes that are not UTF-8 are read as U+FFFD, like an
/// argument (`main`), so they fail as `invalid_hex` with its JSON line.
fn read_stdin() -> Result<String, String> {
    let mut buf = Vec::new();
    io::stdin()
        .read_to_end(&mut buf)
        .map_err(|e| format!("failed to read stdin: {e}"))?;
    Ok(trim_hex_input(&String::from_utf8_lossy(&buf)).to_string())
}

/// Strip the whitespace allowed around hex input: space, tab, LF and CR (RFC 8259's
/// set, as `--from-json` allows), and nothing else — not a form feed, NBSP or a BOM
/// (docs/spec/ontos-cli.md "Synopsis").
fn trim_hex_input(s: &str) -> &str {
    s.trim_matches([' ', '\t', '\n', '\r'])
}

/// Resolve the `--from-json` source text: the literal argument, or stdin when it is
/// `-`. Nothing is trimmed: the reader allows only RFC 8259 whitespace.
fn resolve_json_text(src: String) -> Result<String, String> {
    if src == "-" {
        // Bytes that are not UTF-8 are read as U+FFFD, like an argument (above):
        // U+FFFD is never hex and never part of a member name, so such text is
        // always refused.
        let mut buf = Vec::new();
        io::stdin()
            .read_to_end(&mut buf)
            .map_err(|e| format!("failed to read stdin: {e}"))?;
        Ok(String::from_utf8_lossy(&buf).into_owned())
    } else {
        Ok(src)
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
// The exact inverse of `push_authoring_json`, read in two stages the same way in
// all four CLIs (docs/spec/ontos-cli.md "Value input"):
//   (1) `read_json`: the text as RFC 8259 JSON, left to right and without
//       recursion — only space/tab/LF/CR as whitespace, nothing after the value,
//       escapes decoded, lone-surrogate escapes and repeated member names refused,
//       and at most `JSON_NESTING_CAP` open arrays and objects. The first fault ends
//       the reading: a 2051st level is `limit_exceeded`, anything else `invalid_json`.
//   (2) `authoring_value`: the JSON value checked against the authoring shape
//       (`{atom}` | `{tuple}`) and built into a core `Value`, again without
//       recursion.
// Dependency-free, like the hand-rolled JSON *output* here (no serde). This reader
// is interim: a later task moves the CLIs onto a library reader.

/// The most arrays and objects the text may have open at once: 2·1024 + 2. The
/// deepest value the codec's default decoder accepts is nested 1024 deep (root at
/// depth 0, ontos-codec.md §4.1); when that deepest value is an empty tuple, its
/// 1025 tuples take two levels each (`{"tuple":[`). Anything deeper in an authoring
/// text is a value the decoder would refuse.
const JSON_NESTING_CAP: usize = 2 * 1024 + 2;

/// Why the text was refused: a 2051st nesting level, or any other fault.
#[derive(Debug, PartialEq, Eq)]
enum JsonFault {
    /// `limit_exceeded` (exit 1).
    TooDeep,
    /// `invalid_json` (exit 2).
    Malformed,
}

/// A generic JSON value, the output of stage (1). Numbers, `true`, `false` and
/// `null` are only ever refused by stage (2), so they share one variant. An
/// object maps each member name (which occurs once) to its value.
enum JsonValue {
    Scalar,
    String(String),
    Array(Vec<JsonValue>),
    Object(HashMap<String, JsonValue>),
}

/// Drop without recursion: a 2050-deep tree would otherwise take one drop frame
/// per level, more than a 1 MB main-thread stack (the Windows default) holds in a
/// debug build.
impl Drop for JsonValue {
    fn drop(&mut self) {
        let mut pending: Vec<JsonValue> = Vec::new();
        take_children(self, &mut pending);
        while let Some(mut node) = pending.pop() {
            take_children(&mut node, &mut pending);
        }
    }
}

/// Move `node`'s children (if any) onto `pending`, leaving it childless.
fn take_children(node: &mut JsonValue, pending: &mut Vec<JsonValue>) {
    match node {
        JsonValue::Array(items) => pending.append(items),
        JsonValue::Object(members) => pending.extend(members.drain().map(|(_, v)| v)),
        JsonValue::Scalar | JsonValue::String(_) => {}
    }
}

/// An open array or object while stage (1) reads: for an object, the member name
/// the next value belongs to.
enum Open {
    Array(Vec<JsonValue>),
    Object(HashMap<String, JsonValue>, String),
}

/// Stage (1)'s cursor over the text.
struct JsonReader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

/// Stage (1): read the whole text as one JSON value. Returns `TooDeep` for a 2051st
/// nesting level and `Malformed` for any other fault, whichever comes first.
fn read_json(text: &str) -> Result<JsonValue, JsonFault> {
    let mut r = JsonReader {
        bytes: text.as_bytes(),
        pos: 0,
    };
    let mut stack: Vec<Open> = Vec::new();
    r.ws();
    loop {
        // A value starts at the cursor.
        let mut value = match r.peek() {
            Some(c @ (b'{' | b'[')) => {
                if stack.len() == JSON_NESTING_CAP {
                    return Err(JsonFault::TooDeep);
                }
                r.pos += 1;
                r.ws();
                if c == b'[' {
                    if r.peek() == Some(b']') {
                        r.pos += 1;
                        JsonValue::Array(Vec::new())
                    } else {
                        stack.push(Open::Array(Vec::new()));
                        r.ws();
                        continue;
                    }
                } else if r.peek() == Some(b'}') {
                    r.pos += 1;
                    JsonValue::Object(HashMap::new())
                } else {
                    let key = r.member_name()?;
                    stack.push(Open::Object(HashMap::new(), key));
                    r.ws();
                    continue;
                }
            }
            Some(b'"') => JsonValue::String(r.string()?),
            Some(b't') => r.literal(b"true")?,
            Some(b'f') => r.literal(b"false")?,
            Some(b'n') => r.literal(b"null")?,
            Some(b'-' | b'0'..=b'9') => r.number()?,
            _ => return Err(JsonFault::Malformed),
        };

        // `value` is complete: hand it to the innermost open container, closing
        // each container whose end follows.
        loop {
            let Some(top) = stack.last_mut() else {
                r.ws();
                if r.pos != r.bytes.len() {
                    return Err(JsonFault::Malformed); // data after the value
                }
                return Ok(value);
            };
            match top {
                Open::Array(items) => items.push(value),
                Open::Object(members, key) => {
                    members.insert(std::mem::take(key), value);
                }
            }
            r.ws();
            match (r.peek(), &mut *top) {
                (Some(b','), Open::Array(_)) => {
                    r.pos += 1;
                    r.ws();
                    break;
                }
                (Some(b','), Open::Object(members, key)) => {
                    r.pos += 1;
                    let name = r.member_name()?;
                    if members.contains_key(&name) {
                        return Err(JsonFault::Malformed); // a repeated member name
                    }
                    *key = name;
                    r.ws();
                    break;
                }
                (Some(b']'), Open::Array(_)) | (Some(b'}'), Open::Object(..)) => {
                    r.pos += 1;
                    value = match stack.pop() {
                        Some(Open::Array(items)) => JsonValue::Array(items),
                        Some(Open::Object(members, _)) => JsonValue::Object(members),
                        None => unreachable!("the stack held `top`"),
                    };
                }
                _ => return Err(JsonFault::Malformed),
            }
        }
    }
}

impl JsonReader<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    /// Skip RFC 8259 whitespace: space, tab, LF and CR, nothing else.
    fn ws(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    /// Read `"name" :` (with whitespace around) and return the name. The caller
    /// refuses a name its object already has, compared after escapes are decoded.
    fn member_name(&mut self) -> Result<String, JsonFault> {
        self.ws();
        if self.peek() != Some(b'"') {
            return Err(JsonFault::Malformed);
        }
        let name = self.string()?;
        self.ws();
        if self.peek() != Some(b':') {
            return Err(JsonFault::Malformed);
        }
        self.pos += 1;
        Ok(name)
    }

    /// Read exactly the keyword `word` (`true`/`false`/`null`).
    fn literal(&mut self, word: &[u8]) -> Result<JsonValue, JsonFault> {
        if !self.bytes[self.pos..].starts_with(word) {
            return Err(JsonFault::Malformed);
        }
        self.pos += word.len();
        Ok(JsonValue::Scalar)
    }

    /// Check the RFC 8259 number grammar. The value is never used, so a number of
    /// any length is fine.
    fn number(&mut self) -> Result<JsonValue, JsonFault> {
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(JsonFault::Malformed),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(JsonFault::Malformed);
            }
            self.digits();
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            if !matches!(self.peek(), Some(b'0'..=b'9')) {
                return Err(JsonFault::Malformed);
            }
            self.digits();
        }
        Ok(JsonValue::Scalar)
    }

    fn digits(&mut self) {
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
    }

    /// Read a string (the cursor is on its opening quote) and return its decoded
    /// text. A control character must be escaped; a `\u` escape of a surrogate must
    /// be a high one followed at once by an escaped low one.
    fn string(&mut self) -> Result<String, JsonFault> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let start = self.pos;
            // Copy a run of plain characters at once. The text is valid UTF-8 and the
            // run ends at an ASCII byte, so the slice is on character boundaries.
            while matches!(self.peek(), Some(c) if c >= 0x20 && c != b'"' && c != b'\\') {
                self.pos += 1;
            }
            out.push_str(
                std::str::from_utf8(&self.bytes[start..self.pos])
                    .map_err(|_| JsonFault::Malformed)?,
            );
            match self.peek() {
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.pos += 1;
                    let escape = self.peek().ok_or(JsonFault::Malformed)?;
                    self.pos += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{0008}'),
                        b'f' => out.push('\u{000c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => out.push(self.unicode_escape()?),
                        _ => return Err(JsonFault::Malformed),
                    }
                }
                // The end of the text, or an unescaped control character.
                _ => return Err(JsonFault::Malformed),
            }
        }
    }

    /// Decode the `XXXX` of a `\uXXXX` escape (the `\u` is consumed), and the low
    /// half of a surrogate pair when the first is a high surrogate.
    fn unicode_escape(&mut self) -> Result<char, JsonFault> {
        let first = self.hex4()?;
        let code = match first {
            0xd800..=0xdbff => {
                if !self.bytes[self.pos..].starts_with(b"\\u") {
                    return Err(JsonFault::Malformed); // lone high surrogate
                }
                self.pos += 2;
                let second = self.hex4()?;
                if !(0xdc00..=0xdfff).contains(&second) {
                    return Err(JsonFault::Malformed); // lone high surrogate
                }
                0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00)
            }
            0xdc00..=0xdfff => return Err(JsonFault::Malformed), // lone low surrogate
            _ => first,
        };
        char::from_u32(code).ok_or(JsonFault::Malformed)
    }

    /// Read four hex digits, either case.
    fn hex4(&mut self) -> Result<u32, JsonFault> {
        let mut value = 0u32;
        for _ in 0..4 {
            let digit = match self.peek() {
                Some(c @ b'0'..=b'9') => c - b'0',
                Some(c @ b'a'..=b'f') => c - b'a' + 10,
                Some(c @ b'A'..=b'F') => c - b'A' + 10,
                _ => return Err(JsonFault::Malformed),
            };
            value = value * 16 + u32::from(digit);
            self.pos += 1;
        }
        Ok(value)
    }
}

/// Read the `--from-json` authoring notation into a core `Value`: stage (1), then
/// stage (2). A shape fault is `Malformed` (`invalid_json`).
fn parse_authoring(text: &str) -> Result<Value, JsonFault> {
    let json = read_json(text)?;
    authoring_value(&json).ok_or(JsonFault::Malformed)
}

/// What one authoring node is: an atom's value, or a tuple's children to walk.
enum Authoring<'a> {
    Atom(Value),
    Tuple(&'a [JsonValue]),
}

/// Stage (2): check a JSON value against the authoring notation and build the core
/// `Value`, walking the tree with an explicit stack. `None` for any other shape.
///
/// A value is a JSON object with EXACTLY ONE member, `atom` or `tuple` (stage (1)
/// has already refused a repeated name). `atom` is an even-length lowercase-hex
/// string; `tuple` is an array of values.
fn authoring_value(root: &JsonValue) -> Option<Value> {
    let children = match authoring_node(root)? {
        Authoring::Atom(value) => return Some(value),
        Authoring::Tuple(children) => children,
    };
    // Each open tuple: the children still to check, and those built so far.
    let mut stack: Vec<(std::slice::Iter<'_, JsonValue>, Vec<Value>)> =
        vec![(children.iter(), Vec::with_capacity(children.len()))];
    loop {
        let (rest, _) = stack.last_mut()?;
        match rest.next() {
            Some(child) => match authoring_node(child)? {
                Authoring::Atom(value) => stack.last_mut()?.1.push(value),
                Authoring::Tuple(children) => {
                    stack.push((children.iter(), Vec::with_capacity(children.len())));
                }
            },
            None => {
                let (_, built) = stack.pop()?;
                let tuple = Value::tuple(built);
                match stack.last_mut() {
                    Some((_, parent)) => parent.push(tuple),
                    None => return Some(tuple),
                }
            }
        }
    }
}

/// Check one authoring node.
fn authoring_node(node: &JsonValue) -> Option<Authoring<'_>> {
    let JsonValue::Object(members) = node else {
        return None; // a value must be an object
    };
    if members.len() != 1 {
        return None; // exactly one member, `atom` or `tuple`
    }
    if let Some(atom) = members.get("atom") {
        let JsonValue::String(hex) = atom else {
            return None; // atom payload must be a string
        };
        return parse_lower_hex(hex)
            .ok()
            .map(|bytes| Authoring::Atom(Value::atom(bytes)));
    }
    match members.get("tuple")? {
        JsonValue::Array(items) => Some(Authoring::Tuple(items)),
        _ => None, // tuple payload must be an array
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
