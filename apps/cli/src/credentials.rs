use crate::{
    api::{Client, Credential, SCOPES},
    contract::{Error, TOKEN, UUID},
    crypto, private,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
fn invalid(message: &str) -> Error {
    Error::client(message)
}
pub fn scopes(value: &Value) -> Result<Vec<String>, Error> {
    let values = value
        .as_array()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| invalid("Invalid credential scopes"))?;
    let ordered: Vec<String> = SCOPES
        .iter()
        .filter(|s| values.iter().any(|v| v == **s))
        .map(|s| s.to_string())
        .collect();
    if ordered.len() != values.len() {
        return Err(invalid("Invalid credential scopes"));
    }
    Ok(ordered)
}
pub fn token() -> Result<String, Error> {
    Ok(format!(
        "hailp_{}",
        URL_SAFE_NO_PAD.encode(crypto::random::<32>()?.as_ref())
    ))
}
fn valid_token(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| s.len() == 49 && TOKEN.is_match(s))
}
fn migrating(v: &Value) -> bool {
    !v["migrationState"].is_null() && v["migrationState"] != false
}
fn same_scopes(a: &Value, b: &Value) -> Result<bool, Error> {
    Ok(scopes(a)? == scopes(b)?)
}
pub async fn create(
    client: &Client,
    output: &str,
    requested: Option<&[String]>,
) -> Result<Value, Error> {
    let account = client.account().await?;
    let account_scopes = scopes(&account["scopes"])?;
    if migrating(&account) || !account_scopes.iter().any(|s| s == "credentials:write") {
        return Err(invalid("Account cannot issue credentials"));
    }
    let saved = private::optional_json(output)?;
    if saved.as_ref().is_some_and(|s| {
        s["provider"] != account["provider"]
            || s["accountId"] != account["accountId"]
            || !valid_token(&s["token"])
    }) {
        return Err(invalid(
            "Credential output belongs to another account or is invalid",
        ));
    }
    let chosen = if let Some(s) = requested {
        scopes(&json!(s))?
    } else if let Some(s) = saved.as_ref().and_then(|s| s.get("scopes")) {
        scopes(s)?
    } else {
        account_scopes.clone()
    };
    if let Some(s) = saved.as_ref().and_then(|s| s.get("scopes"))
        && scopes(s)? != chosen
    {
        return Err(invalid("Credential retry changed requested scopes"));
    }
    if chosen.iter().any(|s| !account_scopes.contains(s)) {
        return Err(invalid("Credential scopes exceed the caller's permissions"));
    }
    let token = match &saved {
        Some(s) => s["token"].as_str().unwrap().to_string(),
        None => token()?,
    };
    let pending = json!({"type":"hailp.api-credential","version":1,"provider":account["provider"],"accountId":account["accountId"],"token":token,"scopes":chosen});
    if let Some(saved) = &saved {
        if saved.get("scopes").is_none() {
            private::replace(output, &pending)?;
        }
    } else {
        private::create(output, pending.to_string().as_bytes())?;
    }
    let body = if chosen == account_scopes {
        json!({"token":token})
    } else {
        json!({"token":token,"scopes":chosen})
    };
    let record = client.post("/credentials", &body).await?;
    if record["type"] != "hailp.api-credential"
        || record["version"].as_f64() != Some(1.0)
        || record["provider"] != account["provider"]
        || record["accountId"] != account["accountId"]
        || record["token"] != token
        || !record["credentialId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
        || saved
            .as_ref()
            .and_then(|s| s.get("credentialId"))
            .is_some_and(|id| *id != record["credentialId"])
        || !record["expiresAt"]
            .as_str()
            .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        || scopes(&record["scopes"])? != chosen
    {
        return Err(invalid(
            "Credential acknowledgement differs from the saved request",
        ));
    }
    private::replace(output, &record)?;
    Ok(
        json!({"credentialId":record["credentialId"],"credentialFile":output,"scopes":chosen,"expiresAt":record["expiresAt"]}),
    )
}
pub async fn rotate(source: &str, output: &str) -> Result<Value, Error> {
    fn absolute(path: &str) -> Result<std::path::PathBuf, Error> {
        let p = std::path::absolute(path).map_err(|_| invalid("Invalid credential path"))?;
        let mut normalized = std::path::PathBuf::new();
        for component in p.components() {
            match component {
                std::path::Component::ParentDir => {
                    normalized.pop();
                }
                std::path::Component::CurDir => {}
                _ => normalized.push(component),
            }
        }
        Ok(normalized)
    }
    if absolute(source)? == absolute(output)? {
        return Err(invalid("Rotation requires a new credential output path"));
    }
    let original = Client::new(Credential::load(source, None, None)?)?;
    let record =
        private::optional_json(source)?.ok_or_else(|| invalid("Missing source credential"))?;
    let state_path = format!("{output}.rotation.json");
    let state = if let Some(state) = private::optional_json(&state_path)? {
        state
    } else {
        if private::optional_json(output)?.is_some() {
            return Err(invalid(
                "Rotation output already exists without its original state",
            ));
        }
        let account = original.account().await?;
        if account["credential"].is_null() {
            return Err(invalid(
                "Provider must expose current credential metadata for rotation",
            ));
        }
        if account["credential"]["credentialId"] != record["credentialId"] {
            return Err(invalid(
                "Source credential ID differs from the authenticated credential",
            ));
        }
        if migrating(&account)
            || !scopes(&account["scopes"])?
                .iter()
                .any(|s| s == "credentials:write")
        {
            return Err(invalid("Account cannot rotate credentials"));
        }
        if !same_scopes(&account["scopes"], &record["scopes"])? {
            return Err(invalid(
                "Source credential scopes differ from its authenticated permissions",
            ));
        }
        let state = json!({"type":"hailp.credential-rotation","version":1,"provider":account["provider"],"accountId":account["accountId"],"sourceCredentialId":account["credential"]["credentialId"],"sourceTokenHash":format!("{:x}",Sha256::digest(record["token"].as_str().unwrap())),"token":token()?,"scopes":scopes(&account["scopes"])?});
        private::create(&state_path, state.to_string().as_bytes())?;
        state
    };
    if state["type"] != "hailp.credential-rotation"
        || state["version"].as_f64() != Some(1.0)
        || state["provider"] != record["provider"]
        || state["accountId"] != record["accountId"]
        || state["sourceCredentialId"] != record["credentialId"]
        || state["sourceTokenHash"]
            != format!("{:x}", Sha256::digest(record["token"].as_str().unwrap()))
        || !same_scopes(&state["scopes"], &record["scopes"])?
        || !valid_token(&state["token"])
        || state["token"] == record["token"]
        || !scopes(&state["scopes"])?
            .iter()
            .any(|s| s == "credentials:write")
    {
        return Err(invalid(
            "Rotation state does not match the original credential",
        ));
    }
    let mut pending = json!({"type":"hailp.api-credential","version":1,"provider":state["provider"],"accountId":state["accountId"],"token":state["token"],"scopes":state["scopes"]});
    if let Some(saved) = private::optional_json(output)? {
        if saved["provider"] != state["provider"]
            || saved["accountId"] != state["accountId"]
            || saved["token"] != state["token"]
            || !same_scopes(&saved["scopes"], &state["scopes"])?
        {
            return Err(invalid("Rotation output conflicts with its saved request"));
        }
    } else {
        private::create(output, pending.to_string().as_bytes())?;
    }
    let mut replacement = Client::new(Credential::load(output, None, None)?)?;
    let account = match replacement.account().await {
        Err(e) if e.status == Some(401) => {
            create(&original, output, Some(&scopes(&state["scopes"])?)).await?;
            replacement = Client::new(Credential::load(output, None, None)?)?;
            replacement.account().await?
        }
        result => result?,
    };
    if account["credential"].is_null()
        || account["credential"]["credentialId"] == state["sourceCredentialId"]
        || migrating(&account)
        || !same_scopes(&account["scopes"], &state["scopes"])?
    {
        return Err(invalid(
            "Replacement credential does not match the reviewed rotation",
        ));
    }
    pending["credentialId"] = account["credential"]["credentialId"].clone();
    pending["scopes"] = json!(scopes(&account["scopes"])?);
    pending["expiresAt"] = account["credential"]["expiresAt"].clone();
    private::replace(output, &pending)?;
    let revoked = replacement
        .post(
            "/credentials",
            &json!({"revoke":state["sourceCredentialId"]}),
        )
        .await?;
    if revoked["revoked"] != true {
        return Err(invalid(
            "Provider did not acknowledge original credential revocation",
        ));
    }
    Ok(
        json!({"credentialId":pending["credentialId"],"credentialFile":output,"scopes":pending["scopes"],"expiresAt":pending["expiresAt"],"rotatedFrom":state["sourceCredentialId"],"revoked":true}),
    )
}
