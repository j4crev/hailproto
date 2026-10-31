use crate::{api::Client, cli::Args, codec, contract::Error, private, signed_reads, vault};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
fn invalid() -> Error {
    Error::client("Binding publication request, signing key or retained artifact changed")
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub async fn publish(client: &Client, args: &Args) -> Result<Value, Error> {
    let output = &args.options["output"];
    let vp = args.options.get("vault");
    let account = client.account().await?;
    if !account["migrationState"].is_null()
        || !account["scopes"]
            .as_array()
            .is_some_and(|s| s.iter().any(|s| s == "account:write"))
        || !account["identityPublicKey"].is_string()
    {
        return Err(invalid());
    }
    let managed = account["custodyProfile"] == "managed";
    if managed == vp.is_some() {
        return Err(Error::client(
            "Select managed signing without a vault or owner identity signing with a vault",
        ));
    }
    let path = format!("{output}.request.json");
    let state = if let Some(s) = private::optional_json(&path)? {
        s
    } else {
        let record = client.get("/binding").await?;
        let (_, payload) = signed_reads::binding_record(&record)?;
        if payload["did"] != account["did"] || payload["address"] != account["address"] {
            return Err(invalid());
        }
        let issued = now().max(payload["issued_at"].as_i64().ok_or_else(invalid)? + 1);
        let state = json!({"provider":account["provider"],"accountId":account["accountId"],"signingKey":account["identityPublicKey"],"previous":record["digest"],"payload":{"type":"hail.address-binding","version":2,"address":account["address"],"did":account["did"],"issued_at":issued,"key_id":format!("{}#hail-identity",account["did"].as_str().unwrap())}});
        private::create(&path, state.to_string().as_bytes())?;
        state
    };
    let p = &state["payload"];
    if state["provider"] != account["provider"]
        || state["accountId"] != account["accountId"]
        || state["signingKey"] != account["identityPublicKey"]
        || p["address"] != account["address"]
        || p["did"] != account["did"]
        || p["key_id"] != format!("{}#hail-identity", account["did"].as_str().unwrap())
    {
        return Err(invalid());
    }
    codec::from_diagnostic("hail.address-binding", p)?;
    let public = state["signingKey"].as_str().ok_or_else(invalid)?;
    let mut signed = private::optional_bytes(output, 16384)?;
    if let Some(bytes) = &signed
        && codec::verify("hail.address-binding", bytes, public)? != *p
    {
        return Err(invalid());
    }
    if !managed && signed.is_none() {
        let secret = private::recovery_secret()?;
        let v: Value =
            serde_json::from_slice(&private::read(vp.unwrap(), 16384)?).map_err(|_| invalid())?;
        let identity = vault::unlock_identity(&v, &secret)?;
        if v["did"] != account["did"] || v["identity"]["publicDidKey"] != public {
            return Err(invalid());
        }
        let bytes = codec::sign(
            "hail.address-binding",
            &codec::from_diagnostic("hail.address-binding", p)?,
            &identity,
        )?;
        private::create(output, &bytes)?;
        signed = Some(bytes);
    }
    let mut request = json!({"previous":state["previous"],"signingKey":public});
    if managed {
        request["payload"] = p.clone();
    } else {
        request["cose"] = URL_SAFE_NO_PAD.encode(signed.as_ref().unwrap()).into();
    }
    let response = client.post("/binding", &request).await?;
    let (bytes, _) = signed_reads::binding_record(&response)?;
    if codec::verify("hail.address-binding", &bytes, public)? != *p
        || signed.as_ref().is_some_and(|s| *s != bytes)
    {
        return Err(Error::client(
            "Provider did not retain the exact signed binding",
        ));
    }
    if signed.is_none() {
        private::create(output, &bytes)?;
    }
    Ok(
        json!({"bindingId":response["bindingId"],"digest":response["digest"],"status":response["status"],"signedFile":output}),
    )
}
