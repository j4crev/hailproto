use crate::{
    api::Client,
    codec,
    contract::{Error, ID, UUID},
};
use serde_json::{Value, json};

pub async fn profile(client: &Client) -> Result<Value, Error> {
    profile_response(client.get("/profile").await?)
}

pub fn profile_response(result: Value) -> Result<Value, Error> {
    let cose = result["cose"].as_str().filter(|s| s.len() <= 349_528);
    let digest = result["digest"].as_str().filter(|s| {
        s.len() == 43
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    });
    if result["type"] != "hailp.sender-profile"
        || result["version"].as_f64() != Some(1.0)
        || cose.is_none()
        || digest.is_none()
        || !safe_integer(&result["revision"])
    {
        return Err(Error::response("Invalid provider Sender Profile response"));
    }
    let bytes = codec::decode_base64(cose.unwrap())?;
    let payload = codec::inspect("hail.sender-profile", &bytes)?;
    let actual = codec::digest(&bytes);
    if payload["revision"].as_f64() != result["revision"].as_f64()
        || Some(actual.as_str()) != digest
    {
        return Err(Error::response(
            "Provider Sender Profile bytes do not match",
        ));
    }
    Ok(json!({"revision":payload["revision"],"digest":actual,"profile":payload}))
}

pub async fn grant(client: &Client, id: &str, output: Option<&String>) -> Result<Value, Error> {
    // Preserve the existing CLI's account check before retrieving the signed Grant.
    client.account().await?;
    let (result, bytes, payload) = grant_record(client, id).await?;
    let actual = codec::digest(&bytes);
    if let Some(path) = output.filter(|s| !s.is_empty()) {
        save_private(path, &bytes)?;
    }
    Ok(
        json!({"grantId":payload["grant_id"],"localRole":result["localRole"],"digest":actual,"grant":payload}),
    )
}

pub async fn grant_record(client: &Client, id: &str) -> Result<(Value, Vec<u8>, Value), Error> {
    if !ID.is_match(id) {
        return Err(Error::client("Grant ID must be a canonical UUIDv7"));
    }
    let result = client.get(&format!("/grants/{id}")).await?;
    let cose = result["cose"].as_str().filter(|s| s.len() <= 349_528);
    if result["type"] != "hailp.grant"
        || result["version"].as_f64() != Some(1.0)
        || cose.is_none()
        || !result["digest"].is_string()
        || !matches!(result["localRole"].as_str(), Some("grantor" | "grantee"))
    {
        return Err(Error::response("Invalid provider Grant response"));
    }
    let bytes = codec::decode_base64(cose.unwrap())?;
    let payload = codec::inspect("hail.grant", &bytes)?;
    let actual = codec::digest(&bytes);
    if payload["grant_id"] != id || result["digest"] != actual {
        return Err(Error::response("Provider Grant bytes or ID do not match"));
    }
    Ok((result, bytes, payload))
}

pub async fn binding(client: &Client) -> Result<Value, Error> {
    let account = client.account().await?;
    let result = client.get("/binding").await?;
    let (bytes, payload) = binding_record(&result)?;
    let _ = bytes;
    if payload["did"] != account["did"] || payload["address"] != account["address"] {
        return Err(Error::client("Binding belongs to another account"));
    }
    Ok(
        json!({"bindingId":result["bindingId"],"digest":result["digest"],"address":payload["address"],"did":payload["did"],
        "issuedAt":payload["issued_at"],"expiresAt":payload["expires_at"],"status":result["status"],"renewalDue":result["renewalDue"]}),
    )
}
pub fn binding_record(result: &Value) -> Result<(Vec<u8>, Value), Error> {
    let cose = result["cose"].as_str().filter(|s| s.len() <= 21_846);
    if result["type"] != "hailp.address-binding"
        || result["version"].as_f64() != Some(1.0)
        || cose.is_none()
        || !result["digest"].is_string()
        || !result["bindingId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
        || !matches!(
            result["status"].as_str(),
            Some("active" | "expired" | "superseded")
        )
        || !result["renewalDue"].is_boolean()
    {
        return Err(Error::client("Invalid binding response"));
    }
    let bytes = codec::decode_base64(cose.unwrap())?;
    let payload = codec::inspect("hail.address-binding", &bytes)?;
    if bytes.len() > 16_384
        || result["digest"] != codec::digest(&bytes)
        || result["expiresAt"].as_f64() != payload["expires_at"].as_f64()
    {
        return Err(Error::client("Binding response bytes/digest differ"));
    }
    Ok((bytes, payload))
}

fn safe_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.abs() <= 9_007_199_254_740_991.0 && n.fract() == 0.0)
}

#[cfg(unix)]
fn save_private(path: &str, bytes: &[u8]) -> Result<(), Error> {
    use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| {
            Error::client("Cannot create private signed Grant file; output must not already exist")
        })?;
    if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(Error::client("Cannot save private signed Grant file"));
    }
    Ok(())
}
#[cfg(not(unix))]
fn save_private(_: &str, _: &[u8]) -> Result<(), Error> {
    Err(Error::client(
        "Private output is currently supported only on Unix",
    ))
}
