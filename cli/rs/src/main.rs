//! `ontos` — the byte-first inspector CLI (Rust build of the tri-core tool).
//!
//! ```text
//! ontos <command> [--format human|json] [--from-json <json|->]
//!                 [--json-profile total|readable] [<hex>]
//! ```
//!
//! Bytes in, evidence out: given canonical `ontos-codec-v1` bytes (a positional
//! hex string, or stdin when the argument is `-` or absent), `ontos decode`
//! decodes them to the L0 value tree and renders it either as the core's `Display`
//! form (`human`) or as JSON (`json`) in the selected JSON profile.
//!
//! The one text→bytes affordance is `--from-json <json|->`: the value is *read*
//! from JSON text instead of decoded from hex, by the projection library
//! (`ontos_json`) in the profile `--json-profile` selects: `ontos-total-json/1` by
//! default (`{"atom":"<hex>"}` | `{"tuple":[ … ]}`, the exact inverse of the
//! default `json` value rendering), or `ontos-readable-json/1`, from stdin only. No
//! bytes are decoded; the value is built directly, so it is canonical by
//! construction. It is mutually exclusive with a positional `<hex>` and works with
//! every command. See `docs/spec/ontos-cli.md` "Value input" and "JSON profiles".
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
use ontos_json::{readable, total, Code};

const VERSION_LINE: &str = "ontos 0.1.0";
const CODEC_ID: &str = "ontos-codec-v1";

const USAGE: &str = "\
Usage: ontos <command> [--format human|json] [--from-json <json|->]
                       [--json-profile total|readable] [<hex>]

Commands:
  decode [<hex>]                       decode ontos-codec-v1 bytes to the L0 value tree
  inspect [<hex>]                      decode + report codec id, canonical?, value, recognized
  read [--all|--kind <k>] [<hex>]      recognize registered embeddings (int|utf8-text|bool|list|map|set|decimal|null)
  canon [--check|--emit] [<hex>]       is the input canonical (--check), or emit canonical hex (--emit)

Options:
  -f, --format <human|json>   output format (default: human)
      --from-json <json|->    build the value from json text instead of hex
                              (`-` reads from stdin); mutually exclusive with <hex>
      --json-profile <total|readable>
                              the json profile of --from-json and of json value
                              output (default total: {\"atom\":\"<hex>\"}|{\"tuple\":[ … ]});
                              readable input only from stdin
  -h, --help                  print this help and exit
  -V, --version               print version and exit

Input is canonical ontos-codec-v1 bytes as a hex string, or read from stdin
when the hex argument is `-` or omitted. With --from-json the value is read
from json text instead (canonical by construction).";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Human,
    Json,
}

/// The JSON profile selected by `--json-profile`: the profile `--from-json` is read in
/// and the value of `--format json` output is rendered in.
#[derive(Clone, Copy, PartialEq, Eq)]
enum JsonProfile {
    /// `ontos-total-json/1`, the default.
    Total,
    /// `ontos-readable-json/1`, read from stdin only.
    Readable,
}

/// Parsed command line, or an early exit (help/version) / usage error.
enum Parsed {
    /// A command to run, with its chosen format, optional positional hex, optional
    /// `--from-json` source, its JSON profile, and any command-specific flags (e.g.
    /// `--all`, `--kind <k>`, `--check`, `--emit`) gathered verbatim for the command
    /// to interpret.
    Run {
        command: String,
        format: Format,
        hex: Option<String>,
        from_json: Option<String>,
        profile: JsonProfile,
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
            profile,
            flags,
        } => run(
            &command,
            Input {
                format,
                hex,
                from_json,
                profile,
            },
            &flags,
        ),
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
    let mut profile = JsonProfile::Total;
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
            "--json-profile" => {
                i += 1;
                let Some(value) = args.get(i) else {
                    return Parsed::Usage {
                        message: "flag `--json-profile` needs a value (total|readable)".into(),
                    };
                };
                match parse_json_profile(value) {
                    Some(p) => profile = p,
                    None => {
                        return Parsed::Usage {
                            message: format!(
                                "unknown json profile `{value}` (expected total|readable)"
                            ),
                        }
                    }
                }
            }
            _ if arg.starts_with("--json-profile=") => {
                let value = &arg["--json-profile=".len()..];
                match parse_json_profile(value) {
                    Some(p) => profile = p,
                    None => {
                        return Parsed::Usage {
                            message: format!(
                                "unknown json profile `{value}` (expected total|readable)"
                            ),
                        }
                    }
                }
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
        profile,
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

fn parse_json_profile(value: &str) -> Option<JsonProfile> {
    match value {
        "total" => Some(JsonProfile::Total),
        "readable" => Some(JsonProfile::Readable),
        _ => None,
    }
}

/// What every command shares: the output format, the one input source (a positional
/// hex or `--from-json`), and the JSON profile.
struct Input {
    format: Format,
    hex: Option<String>,
    from_json: Option<String>,
    profile: JsonProfile,
}

/// Dispatch a parsed command.
fn run(command: &str, input: Input, flags: &[String]) -> ExitCode {
    match command {
        "decode" => run_decode(input, flags),
        "inspect" => run_inspect(input, flags),
        "read" => run_read(input, flags),
        "canon" => run_canon(input, flags),
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
fn run_decode(input: Input, flags: &[String]) -> ExitCode {
    if let Some(flag) = flags.first() {
        return unknown_flag("decode", flag);
    }
    let (format, profile) = (input.format, input.profile);
    let value = match resolve_value("decode", input) {
        Ok(value) => value,
        Err(code) => return code,
    };

    match format {
        Format::Human => println!("{value}"),
        Format::Json => {
            let rendered = match render_value("decode", &value, profile) {
                Ok(rendered) => rendered,
                Err(code) => return code,
            };
            let mut out = String::new();
            out.push_str(r#"{"ok":true,"command":"decode","codec":""#);
            out.push_str(CODEC_ID);
            out.push_str(r#"","value":"#);
            out.push_str(&rendered);
            out.push('}');
            println!("{out}");
        }
    }
    ExitCode::SUCCESS
}

/// `ontos inspect [<hex>]` — decode + report codec id, canonical?, value, and the
/// registered embeddings recognized at the top level.
fn run_inspect(input: Input, flags: &[String]) -> ExitCode {
    if let Some(flag) = flags.first() {
        return unknown_flag("inspect", flag);
    }
    let (format, profile) = (input.format, input.profile);
    let (input, value) = match resolve_value_with_input("inspect", input) {
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
            let rendered = match render_value("inspect", &value, profile) {
                Ok(rendered) => rendered,
                Err(code) => return code,
            };
            let mut out = String::new();
            out.push_str(r#"{"ok":true,"command":"inspect","codec":""#);
            out.push_str(CODEC_ID);
            out.push_str(r#"","canonical":"#);
            out.push_str(if canonical { "true" } else { "false" });
            out.push_str(r#","value":"#);
            out.push_str(&rendered);
            out.push_str(r#","recognized":"#);
            push_labels_json(&recognized, &mut out);
            out.push('}');
            println!("{out}");
        }
    }
    ExitCode::SUCCESS
}

/// `ontos read [--all | --kind <kind>] [<hex>]` — recognize registered embeddings.
fn run_read(input: Input, flags: &[String]) -> ExitCode {
    let format = input.format;
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

    let value = match resolve_value("read", input) {
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
fn run_canon(input: Input, flags: &[String]) -> ExitCode {
    let format = input.format;
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

    let (input, value) = match resolve_value_with_input("canon", input) {
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
/// (decoded via `ontos-codec-v1`) or `--from-json` (read by the projection library)
/// — discarding the input bytes.
fn resolve_value(command: &str, input: Input) -> Result<Value, ExitCode> {
    resolve_value_with_input(command, input).map(|(_, value)| value)
}

/// Resolve the value for `command` and the bytes it corresponds to.
///
/// Exactly one source is used. `--from-json` together with a positional `<hex>` is
/// a `usage_error` (exit 2). With `--from-json` the value is *built* by the
/// projection library in the selected profile and the bytes are its canonical
/// encoding (canonical by construction); otherwise the hex is decoded via
/// `ontos-codec-v1`.
fn resolve_value_with_input(command: &str, input: Input) -> Result<(Vec<u8>, Value), ExitCode> {
    let Input {
        format,
        hex,
        from_json,
        profile,
    } = input;
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
        // Readable input is read from stdin only: an argument may have been decoded
        // lossily on its way in (Node's argv is, and `main` reads ours that way), and
        // a replaced byte inside a string would read as another value
        // (ontos-readable-json.md §10.1).
        if profile == JsonProfile::Readable && json_src != "-" {
            let message =
                "--json-profile readable reads --from-json from stdin only (--from-json -)";
            return Err(usage_error(command, format, message));
        }
        let text = match resolve_json_text(json_src, profile) {
            Ok(text) => text,
            Err(message) => {
                eprintln!("ontos: {message}");
                return Err(ExitCode::from(2));
            }
        };
        let parsed = match profile {
            JsonProfile::Total => total::parse_utf8(&text, &total::DEFAULT_LIMITS),
            JsonProfile::Readable => readable::parse_utf8(&text, &readable::DEFAULT_LIMITS),
        };
        let value = match parsed {
            Ok(value) => value,
            Err(err) => {
                if format == Format::Human {
                    eprintln!("ontos: json input: {err}");
                }
                let (error, code) = json_failure(&err);
                return Err(decode_error(command, error, format, code));
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

/// Resolve the `--from-json` source text as bytes: the literal argument, or stdin
/// when it is `-`. Nothing is trimmed: the reader allows only RFC 8259 whitespace.
///
/// Under the total profile, bytes that are not UTF-8 are read as U+FFFD, from stdin
/// as from an argument (`main`): that is the CLI's total transport, because Node
/// decodes argv that way before ts sees it. U+FFFD is never hex and never part of
/// `atom` or `tuple`, so such a text is always refused. The library's reader itself is
/// strict. Readable input (stdin only) keeps its exact bytes, so ill-formed UTF-8 is
/// refused by the reader (ontos-readable-json.md §10.1).
fn resolve_json_text(src: String, profile: JsonProfile) -> Result<Vec<u8>, String> {
    if src != "-" {
        return Ok(src.into_bytes());
    }
    let mut buf = Vec::new();
    io::stdin()
        .read_to_end(&mut buf)
        .map_err(|e| format!("failed to read stdin: {e}"))?;
    Ok(match profile {
        JsonProfile::Readable => buf,
        JsonProfile::Total => match String::from_utf8(buf) {
            Ok(text) => text.into_bytes(),
            Err(err) => String::from_utf8_lossy(err.as_bytes())
                .into_owned()
                .into_bytes(),
        },
    })
}

/// Map a library refusal onto the CLI's codes: a limit is `limit_exceeded`, exit 1,
/// as a decode limit; anything else is `invalid_json`, exit 2.
fn json_failure(err: &ontos_json::Error) -> (&'static str, u8) {
    if err.code() == Code::LimitExceeded {
        ("limit_exceeded", 1)
    } else {
        ("invalid_json", 2)
    }
}

/// Render the value of a `--format json` result in the selected profile. Under the
/// defaults the total writer accepts every value the CLI can hold (none is deeper than
/// 1024), and the readable writer refuses only an integer of more than 4300 digits: that
/// refusal is emitted as the command's error line (`limit_exceeded`, exit 1).
fn render_value(command: &str, value: &Value, profile: JsonProfile) -> Result<String, ExitCode> {
    let rendered = match profile {
        JsonProfile::Total => total::render_utf8(value, &total::DEFAULT_LIMITS),
        JsonProfile::Readable => readable::render_utf8(value, &readable::DEFAULT_LIMITS),
    };
    match rendered {
        // The writers emit UTF-8; the lossy conversion never replaces anything.
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(err) => {
            eprintln!("ontos: cannot render the value: {err}");
            let (error, code) = json_failure(&err);
            println!(r#"{{"ok":false,"command":"{command}","error":"{error}"}}"#);
            Err(ExitCode::from(code))
        }
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
/// Uppercase A–F is accepted (positional `<hex>` input).
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

/// A single hex digit -> nibble, MIXED case (accepts `A`–`F`).
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
