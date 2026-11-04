use crate::{
    api::{Client, SCOPES},
    contract::Error,
};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

fn failure(error: &Error) -> Value {
    json!({"code": error.code, "message": error.message})
}

// Match the provider fields' JavaScript truthiness before forwarding the report.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64() != Some(0.0),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}

pub async fn doctor(
    client: &Client,
    required: &[String],
    inspect_account: bool,
    action: Option<&String>,
) -> Result<Value, Error> {
    if required.iter().any(|s| !SCOPES.contains(&s.as_str())) {
        return Err(Error::usage("Unknown required scope"));
    }
    let mut checks = json!({});
    let mut blockers = Vec::new();
    let capabilities = async {
        let result = client.capabilities().await?;
        if result["type"] != "racr.capabilities"
            || result["version"].as_f64() != Some(1.0)
            || !truthy(&result["features"])
            || !truthy(&result["signup"])
        {
            return Err(Error::response("Invalid provider capabilities"));
        }
        Ok(result)
    }
    .await;
    match capabilities {
        Ok(capabilities) => {
            let mut provider = json!({"reachable":true});
            provider
                .as_object_mut()
                .unwrap()
                .extend(capabilities.as_object().unwrap().clone());
            checks["provider"] = provider;
            if let Some(action) = action.filter(|a| !a.is_empty())
                && capabilities["passkeyRequired"]
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == action))
            {
                blockers.push(json!({"code":"PASSKEY_REQUIRED", "message":format!("{action} requires a passkey")}));
            }
            if capabilities["signup"]["mode"] == "invite" {
                blockers.push(json!({"code":"SIGNUP_INVITATION_REQUIRED", "message":"Signup requires an invitation"}));
            }
        }
        Err(error) => {
            checks["provider"] =
                json!({"reachable":error.status.is_some(), "error":failure(&error)});
            blockers.push(failure(&error));
        }
    }
    if inspect_account {
        match client.account().await {
            Ok(account) => {
                for scope in required {
                    if !account["scopes"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|s| s == scope)
                    {
                        blockers.push(json!({"code":"MISSING_SCOPE", "message":format!("This workflow requires {scope}; select an explicitly authorized credential")}));
                    }
                }
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as i64;
                if account["credential"]["expiresAt"]
                    .as_str()
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|t| t.timestamp_millis() <= now)
                {
                    blockers.push(json!({"code":"CREDENTIAL_EXPIRED", "message":"Selected credential has expired"}));
                }
                if let Some(state) = account["migrationState"].as_str() {
                    blockers.push(json!({"code":"ACCOUNT_FENCED", "message":format!("Account migration state is {state}")}));
                }
                checks["account"] = account;
            }
            Err(error) => {
                checks["account"] = json!({"error":failure(&error)});
                blockers.push(failure(&error));
            }
        }
    } else if !required.is_empty() {
        blockers.push(json!({"code":"CREDENTIAL_REQUIRED", "message":"Select a credential to check required scopes"}));
    }
    Ok(json!({"readOnly":true, "checks":checks, "ok":blockers.is_empty(), "blockers":blockers}))
}

// Escape provider-controlled terminal controls while keeping ordinary text readable.
fn display(value: &Value) -> String {
    let text = match value {
        Value::String(text) => text.clone(),
        Value::Null => "—".into(),
        _ => value.to_string(),
    };
    text.chars()
        .flat_map(|c| {
            if c.is_control() {
                c.escape_default().collect::<Vec<_>>()
            } else {
                vec![c]
            }
        })
        .collect()
}

fn rows(value: &Value, prefix: &str, output: &mut Vec<(String, String)>) {
    match value {
        Value::Object(fields) if !fields.is_empty() => {
            for (key, value) in fields {
                let key = display(&Value::String(key.clone()));
                let label = if prefix.is_empty() {
                    key
                } else {
                    format!("{prefix}.{key}")
                };
                rows(value, &label, output);
            }
        }
        Value::Array(values) if !values.is_empty() => {
            for (index, value) in values.iter().enumerate() {
                if value.is_object() || value.is_array() {
                    rows(value, &format!("{prefix}[{}]", index + 1), output);
                } else {
                    output.push((
                        if index == 0 {
                            prefix.into()
                        } else {
                            String::new()
                        },
                        display(value),
                    ));
                }
            }
        }
        _ => output.push((prefix.into(), display(value))),
    }
}

pub fn render(report: &Value, bold: bool) -> String {
    let heading = |text: &str| {
        if bold {
            format!("\x1b[1m{text}\x1b[0m")
        } else {
            text.into()
        }
    };
    let status = if report["ok"] == true {
        "OK"
    } else {
        "BLOCKED"
    };
    let mut output = format!(
        "{}  {status}\nRead-only diagnostics\n",
        heading("racr doctor")
    );
    for (title, value) in [
        ("Provider", &report["checks"]["provider"]),
        ("Account", &report["checks"]["account"]),
        ("Blockers", &report["blockers"]),
    ] {
        output.push_str(&format!("\n{}\n", heading(title)));
        if value.is_null() {
            output.push_str("  Not checked (no credential selected)\n");
            continue;
        }
        if title == "Blockers" && value.as_array().is_some_and(Vec::is_empty) {
            output.push_str("  None\n");
            continue;
        }
        let mut fields = Vec::new();
        rows(value, "", &mut fields);
        let width = fields
            .iter()
            .map(|(key, _)| key.chars().count())
            .max()
            .unwrap_or(0);
        for (key, value) in fields {
            output.push_str(&format!("  {key:width$}  {value}\n"));
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readable_report_preserves_nested_details_and_escapes_controls() {
        let report = json!({
            "ok": true,
            "checks": {"provider": {
                "reachable": true, "signup": {"mode": "open"},
                "features": {"inboxWait": true},
                "passkeyRequired": ["one", "two"],
                "notice": "\u{001b}[31munsafe\nline"
            }},
            "blockers": []
        });
        let plain = render(&report, false);
        assert!(plain.starts_with("racr doctor  OK\n"));
        let signup = plain
            .lines()
            .find(|line| line.contains("signup.mode"))
            .unwrap();
        let feature = plain
            .lines()
            .find(|line| line.contains("features.inboxWait"))
            .unwrap();
        assert_eq!(signup.find("open"), feature.find("true"));
        assert!(plain.contains("two"));
        assert!(plain.contains("Account\n  Not checked"));
        assert!(plain.ends_with("Blockers\n  None\n"));
        assert!(!plain.contains('\x1b'));
        assert!(plain.contains("\\u{1b}[31munsafe\\nline"));
        let styled = render(&report, true);
        assert!(styled.contains("\x1b[1mProvider\x1b[0m"));
    }

    #[test]
    fn blocked_report_includes_account_and_all_reasons() {
        let report = json!({
            "ok": false,
            "checks": {
                "provider": {"reachable": false, "error": {"code": "TRANSPORT_ERROR"}},
                "account": {"scopes": ["account:read"], "credential": {"expiresAt": null}}
            },
            "blockers": [
                {"code": "TRANSPORT_ERROR", "message": "Check connectivity"},
                {"code": "MISSING_SCOPE", "message": "Select an authorized credential"}
            ]
        });
        let output = render(&report, false);
        for text in [
            "BLOCKED",
            "TRANSPORT_ERROR",
            "MISSING_SCOPE",
            "Check connectivity",
            "Select an authorized credential",
            "account:read",
            "credential.expiresAt",
        ] {
            assert!(output.contains(text), "{text}");
        }
    }
}
