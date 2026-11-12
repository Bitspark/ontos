//! The hex input's surrounding whitespace and UTF-8 rule (docs/spec/ontos-cli.md
//! "Synopsis"): space, tab, LF and CR are stripped, and nothing else is; bytes that are
//! not UTF-8 are read as U+FFFD, so they fail as `invalid_hex` with the JSON line.

use std::io::Write;
use std::process::{Command, Stdio};

/// Run the CLI with `args` and `stdin`; returns (exit code, stdout).
fn run(args: &[&str], stdin: &[u8]) -> (i32, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_ontos"))
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("failed to spawn ontos binary");
    child
        .stdin
        .take()
        .expect("stdin is piped")
        .write_all(stdin)
        .expect("write stdin");
    let output = child.wait_with_output().expect("wait for ontos");
    (
        output.status.code().expect("process killed by signal"),
        String::from_utf8(output.stdout).expect("stdout not utf-8"),
    )
}

const INVALID: &str = "{\"ok\":false,\"command\":\"canon\",\"error\":\"invalid_hex\"}\n";

#[test]
fn hex_input_strips_only_space_tab_lf_cr() {
    for input in [
        "\u{feff}000100",
        "000100\u{00a0}",
        "000100\u{000c}",
        "\u{000b}000100",
        "000100\u{001c}",
        "00 0100",
    ] {
        let as_arg = run(&["canon", "--emit", "--format", "json", input], b"");
        assert_eq!(as_arg, (2, INVALID.to_string()), "argument {input:?}");
        let on_stdin = run(&["canon", "--emit", "--format", "json"], input.as_bytes());
        assert_eq!(on_stdin, (2, INVALID.to_string()), "stdin {input:?}");
    }
    for input in [" \t\r\n000100\r\n", "000100\n"] {
        assert_eq!(
            run(&["canon", "--emit", input], b""),
            (0, "000100\n".to_string())
        );
        assert_eq!(
            run(&["canon", "--emit"], input.as_bytes()),
            (0, "000100\n".to_string())
        );
    }
}

#[test]
fn hex_input_that_is_not_utf8_is_invalid_hex_with_its_line() {
    // It exited 2 with no JSON line before ("failed to read stdin").
    for input in [&b"\xff"[..], b"000100\xff"] {
        let on_stdin = run(&["canon", "--emit", "--format", "json"], input);
        assert_eq!(on_stdin, (2, INVALID.to_string()), "stdin {input:?}");
    }
}
