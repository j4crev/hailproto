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
        if result["type"] != "hailp.capabilities"
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
