use crate::{
    api::Client,
    cli::Args,
    codec,
    contract::{Error, TOKEN, UUID},
    credentials, crypto, plc, private, vault,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
fn invalid() -> Error {
    Error::client(
        "Signup state or response differs from the reviewed provider, custody and owner keys",
    )
}
pub async fn run(args: &Args) -> Result<Value, Error> {
    let opt = |k: &str| args.options.get(k).map(String::as_str).unwrap_or("");
    let provider = opt("provider");
    let address = opt("address");
    let custody = opt("custody");
    let path = opt("state");
    let output = opt("credentials");
    let vp = opt("vault");
    let monitor = args.options.get("monitor-origin");
    let enrollment = args.options.get("passkey-enrollment");
    if let Some(enrollment) = enrollment {
        private::distinct(&[vp, path, output, enrollment])?;
    }
    let mut state = match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut state = json!({"provider":provider,"address":address,"custody":custody,"token":credentials::token()?});
            for key in ["invitation"] {
                if let Some(v) = args.options.get(key) {
                    state[key] = v.clone().into();
                }
            }
            if let Some(origin) = monitor {
                state["monitorOrigin"] = origin.clone().into();
                state["monitorKey"] = opt("monitor-key").into();
            }
            private::create(path, state.to_string().as_bytes())?;
            state
        }
        _ => {
            serde_json::from_slice::<Value>(&private::read(path, 64000)?).map_err(|_| invalid())?
        }
    };
    if state["provider"] != provider
        || state["address"] != address
        || state["custody"] != custody
        || state.get("monitorOrigin").and_then(Value::as_str) != monitor.map(String::as_str)
        || state.get("monitorKey").and_then(Value::as_str)
            != args.options.get("monitor-key").map(String::as_str)
    {
        return Err(invalid());
    }
    if enrollment.is_some()
        && state["enrollmentToken"]
            .as_str()
            .is_none_or(|s| s.is_empty())
    {
        state["enrollmentToken"] = credentials::token()?.into();
        private::replace(path, &state)?;
    }
    if let Some(token) = state.get("enrollmentToken")
        && !token
            .as_str()
            .is_some_and(|s| s.len() == 49 && TOKEN.is_match(s))
    {
        return Err(invalid());
    }
    if args
        .options
        .get("invitation")
        .is_some_and(|s| state["invitation"] != *s)
    {
        return Err(invalid());
    }
    let secret = private::recovery_secret()?;
    let mut user = vault::unlock(
        serde_json::from_slice(&private::read(vp, 16384)?).map_err(|_| invalid())?,
        &secret,
    )?;
    let client = Client::signup(provider, state["token"].as_str().ok_or_else(invalid)?)?;
    let prepared = if let Some(p) = state.get("preparation") {
        p.clone()
    } else {
        let mut request = json!({"address":address,"recoveryKey":user.vault["recovery"]["publicDidKey"],"identityKey":user.vault["identity"]["publicDidKey"],"custody":custody,"backupVerified":true,"signupHash":codec::digest(state["token"].as_str().unwrap().as_bytes())});
        if let Some(v) = state.get("invitation") {
            request["invitation"] = v.clone();
        }
        if let Some(origin) = monitor {
            request["monitorOrigin"] = origin.clone().into();
            request["monitorKey"] = opt("monitor-key").into();
        }
        client
            .request_at("", "/api/v1/onboarding", Some(&request))
            .await?
    };
    let keys = [
        "userRecoveryKey",
        "providerRotationKey",
        "providerMessagingKey",
        "userIdentityKey",
    ]
    .map(|k| prepared[k].as_str().ok_or_else(invalid))
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;
    if prepared["address"] != address.to_lowercase()
        || prepared["userRecoveryKey"] != user.vault["recovery"]["publicDidKey"]
        || prepared["custodyProfile"] != custody
        || (custody == "managed"
            && prepared["managedProfileVersion"] != "hail-managed-custody-v1"
            && (monitor.is_some() || prepared.get("managedProfileVersion").is_some()))
        || (custody == "owner-controlled"
            && (!prepared["managedProfileVersion"].is_null()
                || prepared["userIdentityKey"] != user.vault["identity"]["publicDidKey"]))
        || prepared["sourceServiceBase"] != format!("{provider}/hail")
        || !prepared["accountId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
        || keys.iter().collect::<std::collections::HashSet<_>>().len() != 4
        || monitor.is_some_and(|origin| {
            prepared["monitorOrigin"] != *origin
                || prepared["monitorPublicKey"] != opt("monitor-key")
        })
    {
        return Err(invalid());
    }
    state["preparation"] = prepared.clone();
    private::replace(path, &state)?;
    let unsigned = json!({"type":"plc_operation","prev":null,"rotationKeys":[user.vault["recovery"]["publicDidKey"],prepared["providerRotationKey"]],"verificationMethods":{"hail-identity":prepared["userIdentityKey"],"hail-messaging":prepared["providerMessagingKey"]},"alsoKnownAs":[],"services":{"hail":{"type":"HailMessaging","endpoint":format!("{provider}/hail")}}});
    if custody == "managed" {
        plc::review_managed(&unsigned, &user.vault)?;
    }
    if state.get("operation").is_none() {
        if !user.vault["did"].is_null() {
            return Err(Error::client(
                "Bound vault requires its original signup state",
            ));
        }
        let mut operation = unsigned.clone();
        operation["sig"] = URL_SAFE_NO_PAD
            .encode(crypto::sign_recovery(&user.recovery, &plc::dag(&unsigned)?))
            .into();
        let (did, _) = plc::identity(&operation)?;
        state["operation"] = operation;
        state["did"] = did.clone().into();
        state["binding"] = if custody == "managed" {
            Value::Null
        } else {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let payload = codec::from_diagnostic(
                "hail.address-binding",
                &json!({"type":"hail.address-binding","version":2,"address":address.to_lowercase(),"did":did,"issued_at":now,"key_id":format!("{did}#hail-identity")}),
            )?;
            URL_SAFE_NO_PAD
                .encode(codec::sign(
                    "hail.address-binding",
                    &payload,
                    &user.identity,
                )?)
                .into()
        };
        private::replace(path, &state)?;
    }
    let mut retained = state["operation"].clone();
    let signature = retained
        .as_object_mut()
        .ok_or_else(invalid)?
        .remove("sig")
        .ok_or_else(invalid)?;
    let (did, cid) = plc::identity(&state["operation"])?;
    if retained != unsigned || state["did"] != did {
        return Err(invalid());
    }
    crypto::verify(
        user.vault["recovery"]["publicDidKey"]
            .as_str()
            .ok_or_else(invalid)?,
        &plc::dag(&retained)?,
        &codec::decode_base64(signature.as_str().ok_or_else(invalid)?)?,
    )?;
    if user.vault["did"].is_null() {
        user.vault["did"] = did.clone().into();
        private::replace(vp, &user.vault)?;
    }
    if user.vault["did"] != did {
        return Err(invalid());
    }
    let attestation = if let Some(path) = args.options.get("monitor-attestation") {
        let v = private::optional_json(path)?.ok_or_else(invalid)?;
        if v["monitorDidKey"] != opt("monitor-key")
            || !v["payload"].is_string()
            || !v["signature"].is_string()
        {
            return Err(invalid());
        }
        Some(v)
    } else {
        None
    };
    let mut body = json!({"operation":state["operation"],"binding":state["binding"]});
    if let Some(v) = &attestation {
        body["monitor"] = json!({"payload":v["payload"],"signature":v["signature"]});
    }
    if enrollment.is_some() {
        body["enrollmentToken"] = state["enrollmentToken"].clone();
    }
    let result = client
        .request_at(
            &format!("/{}", prepared["accountId"].as_str().unwrap()),
            "/api/v1/onboarding",
            Some(&body),
        )
        .await?;
    if monitor.is_some() && attestation.is_none() && result["monitorRequired"] != true
        || attestation.is_some() && result["monitorRequired"] == true
    {
        return Err(invalid());
    }
    if result["monitorRequired"] == true {
        if result["did"] != did || result["operationCid"] != cid {
            return Err(invalid());
        }
        return Ok(
            json!({"did":did,"address":address,"custody":custody,"stateFile":path,"monitorRequired":true,"operationCid":cid}),
        );
    }
    let credential = &result["credential"];
    if result["did"] != did
        || credential["type"] != "hailp.api-credential"
        || credential["version"].as_f64() != Some(1.0)
        || credential["provider"] != provider
        || credential["accountId"] != prepared["accountId"]
        || credential["token"] != state["token"]
        || !credential["credentialId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
        || !credential["scopes"]
            .as_array()
            .is_some_and(|s| s.iter().all(Value::is_string))
        || !date(&credential["expiresAt"])
    {
        return Err(invalid());
    }
    private::save_identical(output, credential)?;
    let mut output = json!({"did":did,"address":address,"custody":custody,"credentialFile":output});
    if let Some(path) = enrollment {
        let e = &result["enrollment"];
        if e["type"] != "hailp.passkey-enrollment"
            || e["version"].as_f64() != Some(1.0)
            || e["provider"] != provider
            || e["accountId"] != prepared["accountId"]
            || e["token"] != state["enrollmentToken"]
            || !e["url"].is_string()
            || !date(&e["expiresAt"])
        {
            return Err(invalid());
        }
        private::save_identical(path, e)?;
        output["enrollmentFile"] = path.clone().into();
    }
    Ok(output)
}
fn date(v: &Value) -> bool {
    v.as_str()
        .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
}
