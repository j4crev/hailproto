use crate::{
    cli::Args,
    codec,
    contract::{Error, UUID},
    private, vault,
};
use serde_json::{Value, json};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn sign(args: &Args) -> Result<Value, Error> {
    sign_with_review(args, true)
}
pub fn sign_with_review(args: &Args, review: bool) -> Result<Value, Error> {
    let opt = |key: &str| args.options.get(key).map(String::as_str).unwrap_or("");
    let bytes = private::read(&args.positionals[0], 32768)?;
    let proposal: Value =
        serde_json::from_slice(&bytes).map_err(|_| Error::client("Invalid connection proposal"))?;
    let origin = reqwest::Url::parse(opt("provider"))
        .map_err(|_| Error::client("Invalid expected provider"))?;
    vault::exact(
        &proposal,
        &[
            "expiresAt",
            "payload",
            "provider",
            "requestId",
            "type",
            "version",
        ],
    )?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let expiry = proposal["expiresAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis());
    if origin.scheme() != "https"
        || origin.origin().ascii_serialization() != opt("provider")
        || proposal["type"] != "hailp.connection-signing"
        || proposal["version"].as_f64() != Some(1.0)
        || proposal["provider"] != opt("provider")
        || !proposal["requestId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
        || !expiry
            .is_some_and(|e| e > now.as_millis() as i64 && e <= now.as_millis() as i64 + 300000)
    {
        return Err(Error::client(
            "Connection proposal must name the expected provider and one current short-lived approval",
        ));
    }
    let kind = proposal["payload"]["type"].as_str().unwrap_or("");
    if !matches!(
        kind,
        "hail.connection-invitation" | "hail.connection-confirmation"
    ) {
        return Err(Error::client(
            "Only connection invitation/confirmation consent may be signed",
        ));
    }
    let payload = codec::from_diagnostic(kind, &proposal["payload"])?;
    if payload.field("issued_at").uint(0)? > now.as_secs() as i64 + 300
        || payload.field("expires_at") != &codec::cbor::Value::Null
            && payload.field("expires_at").uint(0)? <= now.as_secs() as i64
    {
        return Err(Error::client(
            "Connection consent has expired or is dated in the future",
        ));
    }
    if review {
        eprintln!(
            "{}",
            json!({"provider":opt("provider"),"requestId":proposal["requestId"],"consent":proposal["payload"],"warning":if kind=="hail.connection-invitation"{"Standing invitation: any authenticated holder may connect before expiry, without another approval."}else{"Explicit mutual connection consent, not a subscription."}})
        );
    }
    let secret = private::recovery_secret()?;
    let v: Value = serde_json::from_slice(&private::read(opt("vault"), 16384)?)
        .map_err(|_| Error::client("Invalid vault JSON"))?;
    let key = vault::unlock_identity(&v, &secret)?;
    if v["did"].is_null() || v["did"] != proposal["payload"]["from"] {
        return Err(Error::client(
            "Connection signer DID or purpose is not the user vault",
        ));
    }
    let signed = codec::sign(kind, &payload, &key)?;
    codec::verify(
        kind,
        &signed,
        v["identity"]["publicDidKey"].as_str().unwrap(),
    )?;
    let output = opt("output");
    if std::path::Path::new(output).try_exists().unwrap_or(false) {
        if private::read(output, 16384)? != signed {
            return Err(Error::client(
                "Existing signed artifact differs from the proposal",
            ));
        }
    } else {
        private::create(output, &signed)?;
    }
    Ok(json!({"requestId":proposal["requestId"],"type":kind,"output":output}))
}
