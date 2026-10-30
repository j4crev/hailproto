use crate::{
    api::Client,
    cli::Args,
    codec,
    contract::{Error, UUID},
    crypto, plc, private, vault,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
fn invalid() -> Error {
    Error::client(
        "Custody transition preparation or retained state differs from the reviewed account",
    )
}
fn integer(v: &Value) -> Option<i64> {
    v.as_i64()
        .filter(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
}
fn retained(mut state: Value, a: &Value, direction: &str) -> Result<Value, Error> {
    if state["type"] != "hailp.custody-transition-state"
        || state["version"].as_f64() != Some(1.0)
        || state["provider"] != a["provider"]
        || state["accountId"] != a["accountId"]
        || state["did"] != a["did"]
        || state["direction"].as_str().unwrap_or("owner-to-managed") != direction
        || !state["transitionId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
        || ![
            "operation",
            "operationCid",
            "approval",
            "signature",
            "binding",
            "bindingDigest",
        ]
        .iter()
        .all(|f| state[f].is_string())
        || !state["newIdentityKey"]
            .as_str()
            .is_some_and(|s| crypto::did_bytes(s).is_ok())
        || codec::decode_base64(state["signature"].as_str().unwrap())?.len() != 64
    {
        return Err(invalid());
    }
    if state.get("generationTo").is_none() {
        let approval = plc::decoded(
            &codec::decode_base64(state["approval"].as_str().unwrap())?,
            262144,
        )?;
        if approval["type"] != "hailp.custody-transition"
            || approval["version"] != 1
            || approval["transition_id"] != state["transitionId"]
            || approval["did"] != state["did"]
            || approval["direction"] != direction
        {
            return Err(invalid());
        }
        state["generationTo"] = approval["generation_to"].clone();
    }
    if !integer(&state["generationTo"]).is_some_and(|n| n >= 1) {
        return Err(invalid());
    }
    Ok(state)
}
fn preparation(
    raw: &Value,
    a: &Value,
    owner: &vault::Unlocked,
    direction: &str,
) -> Result<Value, Error> {
    let current = plc::document(&raw["currentState"])?;
    plc::operation(&raw["unsignedOperation"])?;
    if !raw["transitionId"]
        .as_str()
        .is_some_and(|s| UUID.is_match(s))
        || raw["accountId"] != a["accountId"]
        || raw["did"] != a["did"]
        || raw["direction"] != direction
        || raw["ownerRecoveryKey"] != owner.vault["recovery"]["publicDidKey"]
        || raw["oldIdentityKey"] != a["identityPublicKey"]
        || !raw["newIdentityKey"]
            .as_str()
            .is_some_and(|s| crypto::ed_public(s).is_ok())
        || ![
            "previousOperationCid",
            "historyCheckpointDigest",
            "bindingDigest",
            "expiresAt",
        ]
        .iter()
        .all(|f| raw[f].is_string())
        || integer(&raw["generationFrom"]).is_none()
        || integer(&raw["generationTo"]) != integer(&raw["generationFrom"]).map(|v| v + 1)
    {
        return Err(invalid());
    }
    if owner.vault["did"].is_null()
        || raw["did"] != owner.vault["did"]
        || current["did"] != raw["did"]
        || current["rotationKeys"][0] != owner.vault["recovery"]["publicDidKey"]
        || current["verificationMethods"]["hail-identity"] != raw["oldIdentityKey"]
        || raw["newIdentityKey"] == raw["oldIdentityKey"]
        || if direction == "owner-to-managed" {
            raw["oldIdentityKey"] != owner.vault["identity"]["publicDidKey"]
        } else {
            raw["newIdentityKey"] != owner.vault["identity"]["publicDidKey"]
        }
    {
        return Err(invalid());
    }
    let mut methods = current["verificationMethods"].clone();
    methods["hail-identity"] = raw["newIdentityKey"].clone();
    let expected = json!({"type":"plc_operation","prev":raw["previousOperationCid"],"rotationKeys":current["rotationKeys"],"verificationMethods":methods,"alsoKnownAs":current["alsoKnownAs"],"services":current["services"]});
    if raw["unsignedOperation"] != expected {
        return Err(invalid());
    }
    let expiry = chrono::DateTime::parse_from_rfc3339(raw["expiresAt"].as_str().unwrap())
        .map_err(|_| invalid())?
        .timestamp();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    if expiry <= now {
        return Err(invalid());
    }
    let mut operation = expected;
    operation["sig"] = URL_SAFE_NO_PAD
        .encode(crypto::sign_recovery(
            &owner.recovery,
            &plc::dag(&operation)?,
        ))
        .into();
    let (_, cid) = plc::identity(&operation)?;
    let mut random = *crypto::random::<16>()?;
    random[6] = 0x40 | (random[6] & 15);
    random[8] = 0x80 | (random[8] & 63);
    let hex: String = random.iter().map(|b| format!("{b:02x}")).collect();
    let nonce = format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    );
    let approval = json!({"type":"hailp.custody-transition","version":1,"transition_id":raw["transitionId"],"did":raw["did"],"direction":direction,"provider_service_base":format!("{}/hail",a["provider"].as_str().unwrap()),"owner_recovery_key":raw["ownerRecoveryKey"],"old_identity_key":raw["oldIdentityKey"],"new_identity_key":raw["newIdentityKey"],"previous_operation_cid":raw["previousOperationCid"],"operation_cid":cid,"history_checkpoint_sha256":raw["historyCheckpointDigest"],"binding_sha256":raw["bindingDigest"],"generation_from":raw["generationFrom"],"generation_to":raw["generationTo"],"nonce":nonce,"issued_at":now,"expires_at":expiry.min(now+3600)});
    let bytes = plc::with_digests(&approval, &["history_checkpoint_sha256", "binding_sha256"])?;
    let mut input = b"hailp.custody-transition.v1\0".to_vec();
    input.extend_from_slice(&bytes);
    Ok(
        json!({"type":"hailp.custody-transition-state","version":1,"provider":a["provider"],"accountId":a["accountId"],"did":a["did"],"direction":direction,"transitionId":raw["transitionId"],"operation":URL_SAFE_NO_PAD.encode(operation.to_string()),"operationCid":cid,"approval":URL_SAFE_NO_PAD.encode(bytes),"signature":URL_SAFE_NO_PAD.encode(crypto::sign_recovery(&owner.recovery,&input)),"binding":raw["bindingCose"],"bindingDigest":raw["bindingDigest"],"newIdentityKey":raw["newIdentityKey"],"generationTo":raw["generationTo"]}),
    )
}
pub async fn run(client: &Client, args: &Args) -> Result<Value, Error> {
    let to_owner = args.command == "account custody owner-controlled";
    let direction = if to_owner {
        "managed-to-owner"
    } else {
        "owner-to-managed"
    };
    let path = &args.options["state"];
    let vp = args.options.get("vault");
    let a = client.account().await?;
    if !a["scopes"]
        .as_array()
        .is_some_and(|s| s.iter().any(|v| v == "account:write"))
    {
        return Err(Error::client(
            "Custody transition requires account:write authority",
        ));
    }
    let raw = private::optional_bytes(path, if to_owner { 524288 } else { 131072 })?
        .map(|b| serde_json::from_slice::<Value>(&b).map_err(|_| invalid()))
        .transpose()?;
    let mut key_ready = None;
    let existing = if let Some(raw) = raw {
        if to_owner
            && raw["type"] == "hailp.custody-transition-key"
            && raw["version"] == 1
            && raw["provider"] == a["provider"]
            && raw["accountId"] == a["accountId"]
            && raw["did"] == a["did"]
            && raw["direction"] == direction
            && raw["newIdentityKey"]
                .as_str()
                .is_some_and(|s| crypto::did_bytes(s).is_ok())
        {
            key_ready = Some(raw);
            None
        } else {
            Some(retained(raw, &a, direction)?)
        }
    } else {
        None
    };
    let state = if let Some(state) = existing {
        state
    } else {
        if a["custodyProfile"]
            != if to_owner {
                "managed"
            } else {
                "owner-controlled"
            }
            || !a["identityPublicKey"].is_string()
            || !a["ownerRecoveryPublicKey"].is_string()
        {
            return Err(invalid());
        }
        let vp = vp.ok_or_else(|| {
            Error::client(
                "First custody preparation requires --vault; exact retries use retained --state",
            )
        })?;
        if !to_owner {
            let raw = client.post("/custody/managed", &json!({})).await?;
            if !raw["bindingCose"].is_string()
                || raw["ownerRecoveryKey"] != a["ownerRecoveryPublicKey"]
            {
                return Err(invalid());
            }
            let secret = private::recovery_secret()?;
            let user = vault::unlock(
                serde_json::from_slice(&private::read(vp, 16384)?).map_err(|_| invalid())?,
                &secret,
            )?;
            let state = preparation(&raw, &a, &user, direction)?;
            private::replace(path, &state)?;
            state
        } else {
            let secret = private::recovery_secret()?;
            let stored =
                serde_json::from_slice(&private::read(vp, 16384)?).map_err(|_| invalid())?;
            let user = if key_ready.is_some() {
                vault::unlock(stored, &secret)?
            } else {
                vault::replace_identity(stored, &secret)?
            };
            if let Some(key) = key_ready {
                if key["newIdentityKey"] != user.vault["identity"]["publicDidKey"] {
                    return Err(invalid());
                }
            } else {
                private::replace(vp, &user.vault)?;
                private::replace(
                    path,
                    &json!({"type":"hailp.custody-transition-key","version":1,"provider":a["provider"],"accountId":a["accountId"],"did":a["did"],"direction":direction,"newIdentityKey":user.vault["identity"]["publicDidKey"]}),
                )?;
            }
            let review = client
                .post(
                    "/custody/owner-controlled/review",
                    &json!({"newIdentityKey":user.vault["identity"]["publicDidKey"]}),
                )
                .await?;
            if review["direction"] != direction
                || review["accountId"] != a["accountId"]
                || review["did"] != a["did"]
                || review["ownerRecoveryKey"] != user.vault["recovery"]["publicDidKey"]
                || review["oldIdentityKey"] != a["identityPublicKey"]
                || review["newIdentityKey"] != user.vault["identity"]["publicDidKey"]
                || !review["unsignedOperation"].is_object()
            {
                return Err(invalid());
            }
            let binding = plc::decoded(
                &codec::decode_base64(review["binding"].as_str().ok_or_else(invalid)?)?,
                262144,
            )?;
            if binding["type"] != "hail.address-binding"
                || binding["version"] != 1
                || binding["address"] != a["address"]
                || binding["did"] != a["did"]
                || binding["key_id"] != format!("{}#hail-identity", a["did"].as_str().unwrap())
            {
                return Err(invalid());
            }
            let signed = codec::sign(
                "hail.address-binding",
                &codec::from_diagnostic("hail.address-binding", &binding)?,
                &user.identity,
            )?;
            let binding = URL_SAFE_NO_PAD.encode(signed);
            let mut grants = Vec::new();
            for raw in review["activeGrants"].as_array().ok_or_else(invalid)? {
                if ![
                    "grantId",
                    "payload",
                    "predecessorDigest",
                    "destinationServiceBase",
                ]
                .iter()
                .all(|f| raw[f].is_string())
                {
                    return Err(invalid());
                }
                let p = plc::decoded(
                    &codec::decode_base64(raw["payload"].as_str().unwrap())?,
                    262144,
                )?;
                if p["grant_id"] != raw["grantId"]
                    || p["grantor"] != a["did"]
                    || p["key_id"] != format!("{}#hail-identity", a["did"].as_str().unwrap())
                    || p["status"] != "active"
                    || !integer(&p["revision"]).is_some_and(|n| n >= 2)
                    || p["previous"] != raw["predecessorDigest"]
                {
                    return Err(invalid());
                }
                let cose = codec::sign(
                    "hail.grant",
                    &codec::from_diagnostic("hail.grant", &p)?,
                    &user.identity,
                )?;
                grants.push(json!({"grantId":raw["grantId"],"cose":URL_SAFE_NO_PAD.encode(cose)}));
            }
            let mut raw=client.post("/custody/owner-controlled",&json!({"newIdentityKey":user.vault["identity"]["publicDidKey"],"binding":binding,"grants":grants})).await?;
            raw["bindingCose"] = binding.into();
            let state = preparation(&raw, &a, &user, direction)?;
            private::replace(path, &state)?;
            state
        }
    };
    let result=client.post("/custody/managed/commit",&json!({"transitionId":state["transitionId"],"operation":state["operation"],"approval":state["approval"],"signature":state["signature"]})).await?;
    if result["transitionId"] != state["transitionId"]
        || result["did"] != state["did"]
        || result["state"] != "complete"
        || result["generation"] != state["generationTo"]
    {
        return Err(invalid());
    }
    let mut result = json!({"did":state["did"],"custodyProfile":if to_owner{"owner-controlled"}else{"managed"},"identityPublicKey":state["newIdentityKey"],"generation":result["generation"],"stateFile":path,"instruction":if to_owner{"Old credentials are terminal; use identity login with the updated vault for fresh access."}else{"Old credentials are terminal; use owner-recovery login for fresh access."}});
    if to_owner {
        result["vaultFile"] = vp.unwrap().clone().into();
    }
    Ok(result)
}
