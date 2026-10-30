use serde_json::{Value, json};
use std::{
    fs,
    process::{Command, Output},
};

fn run(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_hailp"))
        .args(args)
        .env_remove("HAILP_CREDENTIAL_FILE")
        .output()
        .unwrap()
}

fn error(args: &[&str], code: &str) {
    let result = run(args);
    assert_eq!(result.status.code(), Some(1));
    assert!(result.stdout.is_empty());
    let value: Value = serde_json::from_slice(&result.stderr).unwrap();
    assert_eq!(value["cliContractVersion"], 1);
    assert_eq!(value["error"]["code"], code);
}

#[test]
fn offline_help_version_and_usage() {
    let version = run(&["--version"]);
    assert!(version.status.success());
    assert_eq!(
        version.stdout,
        format!("{}\n", env!("CARGO_PKG_VERSION")).as_bytes()
    );
    assert!(version.stderr.is_empty());
    for args in [
        vec![],
        vec!["-h"],
        vec!["account", "--help"],
        vec!["inbox", "list", "--help"],
    ] {
        let result = run(&args);
        assert!(result.status.success());
        assert!(result.stderr.is_empty());
        assert!(String::from_utf8(result.stdout).unwrap().contains("hailp"));
    }
    for args in [
        vec!["--version", "--help"],
        vec!["--unknown"],
        vec!["account", "show", "extra"],
        vec!["account", "show", "--pages", "1"],
        vec!["inbox", "list", "--pages", "101"],
        vec!["inbox", "list", "--pages", "01"],
        vec!["inbox", "list", "--pages", "-1"],
        vec!["account", "show", "--credentials", "a", "--credentials=b"],
        vec!["account", "show", "--credentials"],
        vec!["vault", "create"],
        vec!["account", "--provider", "https://example.com", "--help"],
    ] {
        error(&args, "USAGE_ERROR");
    }
    error(&["account", "show"], "CLIENT_ERROR");
}

#[test]
fn read_and_poll_command_contracts_are_offline() {
    for command in [
        "doctor",
        "profile show",
        "binding show",
        "grant show",
        "conversation",
        "conversation list",
        "conversation show",
        "conversation thread",
        "inbox show",
        "inbox wait",
        "message status",
    ] {
        let mut args: Vec<_> = command.split_whitespace().collect();
        args.push("--help");
        let result = run(&args);
        assert!(result.status.success(), "{command}");
        assert!(result.stderr.is_empty());
        assert!(String::from_utf8(result.stdout).unwrap().contains(command));
    }
    for args in [
        vec!["grant", "show"],
        vec!["profile", "show", "--output", "unused"],
        vec!["binding", "show", "--output", "unused"],
        vec!["conversation", "show"],
        vec!["conversation", "thread"],
        vec!["inbox", "show", "sender"],
        vec!["message", "status"],
        vec!["inbox", "wait", "--pages", "2"],
        vec!["inbox", "wait", "--timeout", "301"],
        vec!["inbox", "wait", "--interval", "0"],
        vec!["doctor", "--scope", ""],
        vec!["doctor", "--trash"],
        vec!["conversation", "list", "--trash=false"],
    ] {
        error(&args, "USAGE_ERROR");
    }
    error(&["doctor"], "CLIENT_ERROR");
}

#[cfg(unix)]
#[test]
fn credential_privacy_selection_and_origin_are_checked_before_network() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("credential.json");
    let token = format!("hailp_{}", "a".repeat(43));
    let mut credential = json!({"type":"hailp.api-credential", "version":1,
        "provider":"https://example.com", "accountId":"019a0000-0000-7000-8000-000000000001", "token":token});
    fs::write(&path, credential.to_string()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let name = path.to_str().unwrap();
    error(
        &[
            "account",
            "show",
            "--credentials",
            name,
            "--provider",
            "https://other.example",
        ],
        "SELECTION_MISMATCH",
    );
    error(
        &[
            "account",
            "show",
            "--credentials",
            name,
            "--account-id",
            "wrong",
        ],
        "SELECTION_MISMATCH",
    );
    let env_result = Command::new(env!("CARGO_BIN_EXE_hailp"))
        .args(["account", "show", "--account-id", "wrong"])
        .env("HAILP_CREDENTIAL_FILE", name)
        .output()
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&env_result.stderr).unwrap()["error"]["code"],
        "SELECTION_MISMATCH"
    );
    for origin in [
        "http://example.com",
        "https://127.0.0.1",
        "https://[::1]",
        "https://example.com/",
        "https://EXAMPLE.com",
        "https://example.com:443",
        "https://user@example.com",
        "https://example.com?x",
    ] {
        credential["provider"] = origin.into();
        fs::write(&path, credential.to_string()).unwrap();
        error(&["account", "show", "--credentials", name], "CLIENT_ERROR");
    }
    credential["provider"] = "https://example.com".into();
    fs::write(&path, credential.to_string()).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    let output = run(&["account", "show", "--credentials", name]);
    assert!(!String::from_utf8_lossy(&output.stderr).contains(&token));
    error(&["account", "show", "--credentials", name], "CLIENT_ERROR");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    fs::write(&path, "a".repeat(16_385)).unwrap();
    error(&["account", "show", "--credentials", name], "CLIENT_ERROR");
}
