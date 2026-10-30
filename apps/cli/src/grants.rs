use crate::{api::Client, cli::Args, codec, contract::Error, private, signed_reads, vault};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
fn invalid() -> Error {
    Error::client("Grant proposal or saved output does not match the reviewed permission")
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn scope(values: &[String]) -> Result<Value, Error> {
    let mut values = values.to_vec();
    values.sort();
    if values.is_empty()
        || values.windows(2).any(|w| w[0] == w[1])
        || values.iter().any(|s| {
            s.is_empty()
                || s.len() > 64
                || !s.as_bytes()[0].is_ascii_lowercase() && !s.as_bytes()[0].is_ascii_digit()
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        })
    {
        return Err(Error::client(
            "Select unique category IDs; wildcards are not allowed",
        ));
    }
    Ok(json!({"type":"categories","values":values}))
}
fn allowed(account: &Value) -> bool {
    account["migrationState"].is_null()
        && account["scopes"]
            .as_array()
            .is_some_and(|s| s.iter().any(|s| s == "grants:write"))
}
fn expiry(args: &Args) -> Option<Value> {
    if args.options.contains_key("no-expiry") {
        Some(Value::Null)
    } else {
        args.options
            .get("expires-at")
            .map(|v| json!(v.parse::<i64>().unwrap()))
    }
}
fn unlock(
    path: &str,
    account: &Value,
    expected_key: Option<&str>,
) -> Result<(Value, ed25519_dalek::SigningKey), Error> {
    let secret = private::recovery_secret()?;
    let v: Value = serde_json::from_slice(&private::read(path, 16384)?).map_err(|_| invalid())?;
    let key = vault::unlock_identity(&v, &secret)?;
    if v["did"].is_null()
        || v["did"] != account["did"]
        || expected_key.is_some_and(|p| v["identity"]["publicDidKey"] != p)
    {
        return Err(invalid());
    }
    Ok((v, key))
}
pub async fn submit(client: &Client, bytes: &[u8]) -> Result<Value, Error> {
    if bytes.len() > 262144 {
        return Err(invalid());
    }
    let p = codec::inspect("hail.grant", bytes)?;
    let result = client
        .put(
            &format!("/grants/{}", p["grant_id"].as_str().ok_or_else(invalid)?),
            bytes,
        )
        .await?;
    let digest = codec::digest(bytes);
    if result["grantId"] != p["grant_id"]
        || result["revision"] != p["revision"]
        || result["status"] != p["status"]
        || result["digest"] != digest
        || result["publication"] != "durable"
    {
        return Err(Error::response(
            "Provider did not acknowledge the exact signed Grant",
        ));
    }
    Ok(
        json!({"grantId":p["grant_id"],"revision":p["revision"],"status":p["status"],"digest":digest,"publication":"durable"}),
    )
}
pub async fn create(client: &Client, args: &Args) -> Result<Value, Error> {
    let a = client.account().await?;
    let selected = scope(&args.categories)?;
    if !allowed(&a) {
        return Err(Error::client("Account cannot write Grants"));
    }
    let sender = &args.positionals[0];
    let output = &args.options["output"];
    let vp = args.options.get("vault");
    let expiry = expiry(args);
    if a["custodyProfile"] == "managed" {
        if vp.is_some() {
            return Err(Error::client(
                "Managed signing does not take the owner's identity vault",
            ));
        }
        let path = format!("{output}.request.json");
        let input = if let Some(v) = private::optional_json(&path)? {
            v
        } else {
            let v = json!({"sender":sender,"category":args.categories,"expiresAt":expiry.clone().unwrap_or(json!(now()+7*86400))});
            private::create(&path, v.to_string().as_bytes())?;
            v
        };
        let categories: Vec<String> = if let Some(s) = input["category"].as_str() {
            vec![s.into()]
        } else {
            input["category"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .map(|v| v.as_str().map(String::from).ok_or_else(invalid))
                .collect::<Result<_, _>>()?
        };
        if input["sender"] != *sender
            || scope(&categories)? != selected
            || expiry.as_ref().is_some_and(|v| *v != input["expiresAt"])
        {
            return Err(invalid());
        }
        let body = if input["category"].is_array() {
            json!({"sender":sender,"scope":selected,"expiresAt":input["expiresAt"]})
        } else {
            input
        };
        let result = client.post("/grants/managed", &body).await?;
        let (_, bytes, _) =
            signed_reads::grant_record(client, result["grantId"].as_str().ok_or_else(invalid)?)
                .await?;
        if let Some(saved) = private::optional_bytes(output, 262144)? {
            if saved != bytes {
                return Err(invalid());
            }
        } else {
            private::create(output, &bytes)?;
        }
        return Ok(result);
    }
    let vp = vp.ok_or_else(|| Error::client("Owner-controlled Grant creation requires --vault"))?;
    let saved = private::optional_bytes(output, 262144)?;
    let retained = saved
        .as_ref()
        .map(|b| codec::inspect("hail.grant", b))
        .transpose()?;
    let expiry = expiry.unwrap_or_else(|| {
        retained
            .as_ref()
            .map(|p| p["expires_at"].clone())
            .unwrap_or(json!(now() + 7 * 86400))
    });
    let p = if let Some(p) = retained {
        p
    } else {
        let r = client
            .post(
                "/grants/proposals",
                &json!({"sender":sender,"scope":selected,"expiresAt":expiry}),
            )
            .await?;
        if r["type"] != "hailp.grant-proposal" || r["version"].as_f64() != Some(1.0) {
            return Err(Error::response("Invalid Grant proposal"));
        }
        codec::from_diagnostic("hail.grant", &r["grant"])?;
        r["grant"].clone()
    };
    if p["grantor"] != a["did"]
        || p["status"] != "active"
        || p["revision"] != 1
        || !p["previous"].is_null()
        || p["consent_context"]["grantee_address"] != sender.to_lowercase()
        || p["expires_at"] != expiry
        || p["scope"] != json!([selected])
    {
        return Err(invalid());
    }
    let (v, key) = unlock(vp, &a, None)?;
    let signed = if let Some(b) = &saved {
        b.clone()
    } else {
        codec::sign(
            "hail.grant",
            &codec::from_diagnostic("hail.grant", &p)?,
            &key,
        )?
    };
    codec::verify(
        "hail.grant",
        &signed,
        v["identity"]["publicDidKey"].as_str().unwrap(),
    )?;
    if saved.is_none() {
        private::create(output, &signed)?;
    }
    submit(client, &signed).await
}
pub async fn revoke(client: &Client, args: &Args) -> Result<Value, Error> {
    let a = client.account().await?;
    if !a["scopes"]
        .as_array()
        .is_some_and(|s| s.iter().any(|s| s == "grants:write"))
    {
        return Err(Error::client("Credential has no Grant write permission"));
    }
    let id = &args.positionals[0];
    let (_, current_bytes, current) = signed_reads::grant_record(client, id).await?;
    if a["custodyProfile"] == "managed" {
        if args.options.contains_key("vault") {
            return Err(invalid());
        }
        return client
            .post(&format!("/grants/{id}/revoke"), &json!({}))
            .await;
    }
    let vp = args.options.get("vault").ok_or_else(invalid)?;
    let output = args.options.get("output").ok_or_else(invalid)?;
    let (v, key) = unlock(vp, &a, None)?;
    let public = v["identity"]["publicDidKey"].as_str().unwrap();
    codec::verify("hail.grant", &current_bytes, public)?;
    if current["grantor"] != v["did"] || current["grant_id"] != *id {
        return Err(invalid());
    }
    let existing = private::optional_bytes(output, 262144)?;
    let bytes = if current["status"] == "revoked" {
        if existing.as_ref().is_some_and(|b| *b != current_bytes) {
            return Err(invalid());
        }
        current_bytes
    } else {
        let old = current["updated_at"].as_i64().ok_or_else(invalid)?;
        let updated = if let Some(b) = &existing {
            codec::inspect("hail.grant", b)?["updated_at"]
                .as_i64()
                .ok_or_else(invalid)?
        } else {
            now().max(old + 1)
        };
        if updated <= old || updated > now() + 300 {
            return Err(invalid());
        }
        let mut p = current.clone();
        p["revision"] = json!(current["revision"].as_i64().ok_or_else(invalid)? + 1);
        p["previous"] = codec::digest(&current_bytes).into();
        p["status"] = "revoked".into();
        p["updated_at"] = updated.into();
        let b = if let Some(b) = &existing {
            b.clone()
        } else {
            codec::sign(
                "hail.grant",
                &codec::from_diagnostic("hail.grant", &p)?,
                &key,
            )?
        };
        if codec::verify("hail.grant", &b, public)? != p {
            return Err(invalid());
        }
        b
    };
    if existing.is_none() {
        private::create(output, &bytes)?;
    }
    submit(client, &bytes).await
}
pub async fn update(client: &Client, args: &Args) -> Result<Value, Error> {
    let a = client.account().await?;
    let selected = scope(&args.categories)?;
    let choice = expiry(args).unwrap_or(json!("keep"));
    if !allowed(&a) || !a["identityPublicKey"].is_string() {
        return Err(invalid());
    }
    let managed = a["custodyProfile"] == "managed";
    let vp = args.options.get("vault");
    if managed == vp.is_some() {
        return Err(invalid());
    }
    let id = &args.positionals[0];
    let output = &args.options["output"];
    let path = format!("{output}.request.json");
    let refresh = args.options.contains_key("refresh-consent");
    let sender = args.options.get("sender");
    let mut state = if let Some(b) = private::optional_bytes(&path, 524288)? {
        serde_json::from_slice::<Value>(&b).map_err(|_| invalid())?
    } else {
        let (record, bytes, p) = signed_reads::grant_record(client, id).await?;
        if record["localRole"] != "grantor" || p["grantor"] != a["did"] || p["status"] != "active" {
            return Err(invalid());
        }
        let state = json!({"provider":a["provider"],"accountId":a["accountId"],"key":a["identityPublicKey"],"grantId":id,"base":URL_SAFE_NO_PAD.encode(bytes),"scope":selected,"expiryChoice":choice,"refreshConsent":refresh,"sender":sender});
        private::create(&path, state.to_string().as_bytes())?;
        state
    };
    if state["provider"] != a["provider"]
        || state["accountId"] != a["accountId"]
        || state["key"] != a["identityPublicKey"]
        || state["grantId"] != *id
        || state["scope"] != selected
        || state["expiryChoice"] != choice
        || state["refreshConsent"] != refresh
        || state["sender"] != json!(sender)
    {
        return Err(invalid());
    }
    let public = state["key"].as_str().ok_or_else(invalid)?.to_string();
    let bytes = codec::decode_base64(state["base"].as_str().ok_or_else(invalid)?)?;
    let base = codec::verify("hail.grant", &bytes, &public)?;
    // Verification must bind the role to the authenticated account, not only a key.
    if base["key_id"] != format!("{}#hail-identity", a["did"].as_str().unwrap()) {
        return Err(invalid());
    }
    let deadline = if choice == "keep" {
        base["expires_at"].clone()
    } else {
        choice
    };
    if state.get("proposal").is_none() {
        let mut body = json!({"scope":selected,"expiresAt":deadline,"refreshConsent":refresh,"expectedRevision":base["revision"],"expectedDigest":codec::digest(&bytes)});
        if let Some(sender) = sender {
            body["sender"] = sender.clone().into();
        }
        let response = client
            .post(&format!("/grants/{id}/proposals"), &body)
            .await?;
        if response["type"] != "hailp.grant-proposal" || response["version"].as_f64() != Some(1.0) {
            return Err(invalid());
        }
        state["proposal"] = response["grant"].clone();
        private::replace(&path, &state)?;
    }
    let p = &state["proposal"];
    codec::from_diagnostic("hail.grant", p)?;
    let old_scope = &base["scope"][0];
    let subset = old_scope["type"] == selected["type"]
        && selected["values"].as_array().unwrap().iter().all(|v| {
            old_scope["values"]
                .as_array()
                .is_some_and(|values| values.contains(v))
        });
    let not_extended = base["expires_at"].is_null()
        || deadline
            .as_i64()
            .zip(base["expires_at"].as_i64())
            .is_some_and(|(a, b)| a <= b);
    let restriction = subset
        && not_extended
        && (base["scope"] != json!([selected]) || deadline != base["expires_at"]);
    let sender = sender
        .map(String::as_str)
        .unwrap_or(
            base["consent_context"]["grantee_address"]
                .as_str()
                .ok_or_else(invalid)?,
        )
        .to_lowercase();
    if p["grant_id"] != *id
        || p["grantor"] != a["did"]
        || p["grantee"] != base["grantee"]
        || p["issued_at"] != base["issued_at"]
        || p["revision"].as_i64() != base["revision"].as_i64().map(|r| r + 1)
        || p["previous"] != codec::digest(&bytes)
        || p["status"] != "active"
        || p["updated_at"].as_i64().ok_or_else(invalid)?
            <= base["updated_at"].as_i64().ok_or_else(invalid)?
        || p["updated_at"].as_i64().ok_or_else(invalid)? > now() + 300
        || p["key_id"] != format!("{}#hail-identity", a["did"].as_str().unwrap())
        || p["scope"] != json!([selected])
        || p["expires_at"] != deadline
        || restriction && p["consent_context"] != base["consent_context"]
        || !restriction && p["consent_context"]["grantee_address"] != sender
    {
        return Err(invalid());
    }
    let mut signed = private::optional_bytes(output, 262144)?;
    if let Some(b) = &signed
        && codec::verify("hail.grant", b, &public)? != *p
    {
        return Err(invalid());
    }
    if !managed {
        if signed.is_none() {
            let (_, key) = unlock(vp.unwrap(), &a, Some(&public))?;
            let bytes = codec::sign(
                "hail.grant",
                &codec::from_diagnostic("hail.grant", p)?,
                &key,
            )?;
            private::create(output, &bytes)?;
            signed = Some(bytes);
        }
        return submit(client, signed.as_ref().unwrap()).await;
    }
    let result = client
        .post(
            &format!("/grants/{id}/update"),
            &json!({"payload":p,"signingKey":public}),
        )
        .await?;
    let encoded = result["cose"]
        .as_str()
        .filter(|s| s.len() <= 349528)
        .ok_or_else(invalid)?;
    let bytes = codec::decode_base64(encoded)?;
    if codec::verify("hail.grant", &bytes, &public)? != *p
        || signed.as_ref().is_some_and(|b| *b != bytes)
        || result["grantId"] != *id
        || result["revision"] != p["revision"]
        || result["status"] != "active"
        || result["publication"] != "durable"
        || result["digest"] != codec::digest(&bytes)
    {
        return Err(invalid());
    }
    if signed.is_none() {
        private::create(output, &bytes)?;
    }
    Ok(
        json!({"grantId":id,"revision":p["revision"],"status":"active","digest":result["digest"],"publication":"durable"}),
    )
}
