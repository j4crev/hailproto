use crate::{
    api::Client,
    cli::Args,
    codec, connection_signing,
    contract::{DID, Error, UUID},
    crypto, private,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use std::io::IsTerminal;
fn invalid() -> Error {
    Error::client("Connection state, review or retained artifact differs from the requested intent")
}
fn optional(path: &str) -> Result<Option<Value>, Error> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        _ => serde_json::from_slice(&private::read(path, 65536)?)
            .map(Some)
            .map_err(|_| invalid()),
    }
}
fn save(path: &str, value: &Value) -> Result<(), Error> {
    if let Some(existing) = optional(path)? {
        if existing != *value {
            return Err(invalid());
        }
        Ok(())
    } else {
        private::create(path, value.to_string().as_bytes())
    }
}
fn invitation(code: &Value) -> Result<(), Error> {
    crate::vault::exact(code, &["did", "id", "token", "type", "version"])?;
    if code["type"] != "hailp.connection-invitation"
        || code["version"].as_f64() != Some(1.0)
        || !code["id"].as_str().is_some_and(|s| UUID.is_match(s))
        || !code["did"].as_str().is_some_and(|s| DID.is_match(s))
        || !code["token"]
            .as_str()
            .is_some_and(|s| s.len() == 43 && codec::decode_base64(s).is_ok_and(|b| b.len() == 32))
    {
        return Err(invalid());
    }
    Ok(())
}
async fn selected(client: &Client, path: &str, input: Option<&Value>) -> Result<Value, Error> {
    let a = client.account().await?;
    if !a["migrationState"].is_null()
        || a["custodyProfile"] != "owner-controlled"
        || !a["scopes"]
            .as_array()
            .is_some_and(|s| s.iter().any(|v| v == "account:write"))
    {
        return Err(Error::client(
            "Connection consent requires owner-controlled custody and account:read/account:write; managed consent requires a browser passkey",
        ));
    }
    if let Some(s) = optional(path)? {
        if s["type"] != "hailp.connection-state"
            || s["version"].as_f64() != Some(1.0)
            || s["provider"] != a["provider"]
            || s["accountId"] != a["accountId"]
            || s["did"] != a["did"]
            || !s["request"]["requestId"]
                .as_str()
                .is_some_and(|s| UUID.is_match(s))
        {
            return Err(invalid());
        }
        let mut saved = s["request"].clone();
        saved
            .as_object_mut()
            .ok_or_else(invalid)?
            .shift_remove("requestId");
        if input.is_some_and(|i| *i != saved) {
            return Err(invalid());
        }
        return Ok(s);
    }
    let input = input.ok_or_else(|| Error::client("Connection state file does not exist"))?;
    let mut b = *crypto::random::<16>()?;
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    let hex: String = b.iter().map(|b| format!("{b:02x}")).collect();
    let id = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    let mut request = json!({"requestId":id});
    for (k, v) in input.as_object().ok_or_else(invalid)? {
        request[k] = v.clone();
    }
    let state = json!({"type":"hailp.connection-state","version":1,"provider":a["provider"],"accountId":a["accountId"],"did":a["did"],"request":request});
    save(path, &state)?;
    Ok(state)
}
fn summary(state: &Value, response: &Value) -> Result<(), Error> {
    let req = &state["request"];
    let review = &response["review"];
    if response["requestId"] != req["requestId"]
        || response["action"] != req["action"]
        || !review.is_object()
        || if req["action"] == "create" {
            review["label"] != req["label"]
                || review["expiresAt"] != req["expiresAt"]
                || review["personal"] != false
        } else {
            review["id"] != req["id"] || review["did"] != req["did"]
        }
    {
        return Err(invalid());
    }
    Ok(())
}
fn result(state: &Value, response: &Value) -> Result<Value, Error> {
    let r = &response["result"];
    let req = &state["request"];
    if req["action"] == "create" {
        return Ok(
            json!({"requestId":req["requestId"],"action":"create","invitationId":r["invitationId"],"state":if r.is_null(){"awaiting-signature"}else{"created"}}),
        );
    }
    if !r.is_null()
        && (!r["attemptId"].as_str().is_some_and(|s| UUID.is_match(s))
            || !matches!(
                r["state"].as_str(),
                Some("connecting" | "active" | "expired" | "conflict")
            )
            || !r["connectionId"].is_null()
                && !r["connectionId"].as_str().is_some_and(|s| UUID.is_match(s)))
    {
        return Err(invalid());
    }
    Ok(
        json!({"requestId":req["requestId"],"peerDid":req["did"],"attemptId":r["attemptId"],"state":r.get("state").unwrap_or(&json!("awaiting-signature")),"connectionId":r["connectionId"]}),
    )
}
pub async fn run(client: &Client, args: &Args) -> Result<Value, Error> {
    let opt = |k: &str| args.options.get(k).map(String::as_str).unwrap_or("");
    let path = opt("state");
    if args.command == "connection status" {
        let state = selected(client, path, None).await?;
        let response = client
            .get(&format!(
                "/connections/cli-status?requestId={}",
                state["request"]["requestId"].as_str().unwrap()
            ))
            .await?;
        summary(&state, &response)?;
        return result(&state, &response);
    }
    let create = args.command == "connection invite";
    let input = if create {
        json!({"action":"create","personal":false,"label":opt("label"),"expiresAt":opt("expires-at").parse::<u64>().map_err(|_|invalid())?})
    } else {
        let code: Value =
            serde_json::from_slice(&private::read(opt("file"), 16384)?).map_err(|_| invalid())?;
        invitation(&code)?;
        if !DID.is_match(opt("expected-did")) || code["did"] != opt("expected-did") {
            return Err(invalid());
        }
        json!({"action":"connect","id":code["id"],"did":code["did"],"token":code["token"]})
    };
    let state = selected(client, path, Some(&input)).await?;
    let mut response = client
        .post("/connections/cli-prepare", &state["request"])
        .await?;
    summary(&state, &response)?;
    let proposal_path = format!("{path}.proposal.json");
    let signed_path = format!("{path}.cose");
    if response["result"].is_null() {
        let proposal = &response["ownerSigning"];
        if proposal["requestId"] != state["request"]["requestId"]
            || proposal["provider"] != state["provider"]
        {
            return Err(invalid());
        }
        let kind = if create {
            "hail.connection-invitation"
        } else {
            "hail.connection-confirmation"
        };
        codec::from_diagnostic(kind, &proposal["payload"])?;
        let payload = &proposal["payload"];
        if payload["from"] != state["did"]
            || payload["key_id"] != format!("{}#hail-identity", state["did"].as_str().unwrap())
            || if create {
                payload["expires_at"] != input["expiresAt"]
            } else {
                payload["to"] != input["did"] || payload["invitation_id"] != input["id"]
            }
        {
            return Err(invalid());
        }
        save(&proposal_path, proposal)?;
        if !std::path::Path::new(&signed_path)
            .try_exists()
            .map_err(|_| invalid())?
        {
            let mut signing = args.clone();
            signing.positionals = vec![proposal_path.clone()];
            signing.options.insert("output".into(), signed_path.clone());
            signing.options.insert(
                "provider".into(),
                state["provider"].as_str().unwrap().into(),
            );
            connection_signing::sign_with_review(&signing, std::io::stdin().is_terminal())?;
        }
        let signed = private::read(&signed_path, 16384)?;
        if codec::inspect(kind, &signed)? != *payload {
            return Err(invalid());
        }
        response=client.post("/connections/cli-commit",&json!({"requestId":state["request"]["requestId"],"cose":URL_SAFE_NO_PAD.encode(signed)})).await?;
        summary(&state, &response)?;
    }
    if !create {
        return result(&state, &response);
    }
    let code = &response["invitation"];
    invitation(code)?;
    if code["did"] != state["did"] || code["id"] != response["result"]["invitationId"] {
        return Err(invalid());
    }
    let proposal: Value =
        serde_json::from_slice(&private::read(&proposal_path, 32768)?).map_err(|_| invalid())?;
    codec::from_diagnostic("hail.connection-invitation", &proposal["payload"])?;
    if proposal["payload"]["invitation_id"] != code["id"]
        || proposal["payload"]["token_hash"]["value"]
            != codec::digest(&codec::decode_base64(code["token"].as_str().unwrap())?)
    {
        return Err(invalid());
    }
    save(opt("output"), code)?;
    Ok(
        json!({"requestId":state["request"]["requestId"],"invitationId":code["id"],"did":code["did"],"expiresAt":input["expiresAt"],"invitationFile":opt("output")}),
    )
}
