use crate::{
    api::Client,
    cli::Args,
    codec::{
        self,
        cbor::{self, Limits},
    },
    contract::{DID, Error, UUID},
    crypto, plc, private, vault,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::Signer;
use serde_json::{Value, json};
pub fn invalid() -> Error {
    Error::client(
        "Transfer record differs from the reviewed account, destination or retained approval",
    )
}
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
pub fn integer(v: &Value) -> Result<i64, Error> {
    v.as_i64()
        .filter(|n| n.unsigned_abs() <= 9_007_199_254_740_991)
        .ok_or_else(invalid)
}
pub fn text(v: &Value) -> Result<&str, Error> {
    v.as_str().ok_or_else(invalid)
}
pub fn nonce() -> Result<String, Error> {
    let mut b = *crypto::random::<16>()?;
    b[6] = 64 | (b[6] & 15);
    b[8] = 128 | (b[8] & 63);
    let h: String = b.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &h[..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..]
    ))
}
pub fn destination(input: &str) -> Result<reqwest::Url, Error> {
    let url = reqwest::Url::parse(input).map_err(|_| invalid())?;
    let host = url.host_str().ok_or_else(invalid)?;
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != input
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || host.parse::<std::net::IpAddr>().is_ok()
        || !host.contains('.')
        || host.split('.').any(|s| {
            s.is_empty()
                || s.starts_with('-')
                || s.ends_with('-')
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
    {
        return Err(Error::client(
            "Select a canonical public HTTPS provider domain without a port/path",
        ));
    }
    Ok(url)
}
pub fn wire(v: &Value, managed: bool) -> Result<(Vec<u8>, Vec<u8>), Error> {
    vault::exact(v, &["payload", "signature"])?;
    let bytes = codec::decode_base64(text(&v["payload"])?)?;
    let sig = codec::decode_base64(text(&v["signature"])?)?;
    if bytes.len() > if managed { 8192 } else { 4096 } || sig.len() != 64 {
        return Err(invalid());
    }
    Ok((bytes, sig))
}
pub fn hash_wire(v: &Value) -> Result<String, Error> {
    Ok(codec::digest(&codec::decode_base64(text(&v["payload"])?)?))
}
pub fn verify(
    v: &Value,
    kind: &str,
    key: &str,
    managed: bool,
    owner: bool,
) -> Result<Value, Error> {
    let (bytes, sig) = wire(v, managed)?;
    let payload = cbor::decode(&bytes, Limits::payload(262144), false)?;
    let value = payload.diagnostic();
    let mut input = format!("{kind}.v1\0").into_bytes();
    input.extend_from_slice(&bytes);
    if owner {
        if crypto::did_bytes(key)?.get(..2) != Some(&[0x80, 0x24]) {
            return Err(invalid());
        }
    } else {
        crypto::ed_public(key)?;
    }
    crypto::verify(key, &input, &sig)?;
    if value["type"] != kind
        || value["version"] != 1
        || !DID.is_match(text(&value["did"])?)
        || !UUID.is_match(text(&value["nonce"])?)
        || integer(&value["expires_at"])? <= integer(&value["issued_at"])?
        || integer(&value["expires_at"])? - integer(&value["issued_at"])?
            > if kind == "hail.transfer-cancellation-receipt" {
                7 * 86400
            } else {
                3600
            }
    {
        return Err(invalid());
    }
    if !managed {
        let mut fields = vec!["type", "version", "did", "nonce", "issued_at", "expires_at"];
        fields.extend(match kind {
            "hail.transfer-grant" => vec![
                "source_service_base",
                "destination_service_base",
                "destination_domain",
            ],
            "hail.transfer-offer" => vec![
                "transfer_id",
                "source_service_base",
                "destination_service_base",
                "grant_digest",
                "invitation_digest",
                "invitation_challenge",
                "destination_rotation_key",
                "destination_messaging_key",
            ],
            "hail.transfer-address-selection" => vec![
                "transfer_id",
                "grant_digest",
                "offer_digest",
                "address",
                "selection_nonce",
            ],
            "hail.transfer-reservation" => {
                vec!["transfer_id", "offer_digest", "selection_digest", "address"]
            }
            "hail.transfer-cancellation" => vec!["grant_digest"],
            _ => vec![
                "grant_digest",
                "invitation_digest",
                "destination_domain",
                "source_service_base",
            ],
        });
        vault::exact(&value, &fields)?;
        if integer(&value["issued_at"])? > now() + 300 {
            return Err(invalid());
        }
        if !matches!(kind, "hail.transfer-grant" | "hail.transfer-reservation")
            && payload.field("grant_digest").bytes()?.len() != 32
        {
            return Err(invalid());
        }
        if matches!(
            kind,
            "hail.transfer-address-selection" | "hail.transfer-reservation"
        ) && (!UUID.is_match(text(&value["transfer_id"])?)
            || payload.field("offer_digest").bytes()?.len() != 32
            || !value["address"].is_string()
            || if kind == "hail.transfer-address-selection" {
                !UUID.is_match(text(&value["selection_nonce"])?)
            } else {
                payload.field("selection_digest").bytes()?.len() != 32
            })
        {
            return Err(invalid());
        }
    }
    // Byte-string digests must not be accepted as lookalike diagnostic text.
    if let cbor::Value::Map(entries) = &payload {
        for (k, v) in entries {
            if (k.text()?.ends_with("_digest") || k.text()? == "invitation_challenge")
                && v.bytes()?.len() != 32
            {
                return Err(invalid());
            }
        }
    }
    Ok(value)
}
pub fn load(path: &str) -> Result<Value, Error> {
    serde_json::from_slice(&private::read(path, 32768)?).map_err(|_| invalid())
}
pub fn allowed(a: &Value) -> bool {
    a["scopes"]
        .as_array()
        .is_some_and(|s| s.iter().any(|v| v == "account:write"))
}
pub fn selected(s: &Value, a: &Value, managed: bool) -> Result<(), Error> {
    if s["type"]
        != if managed {
            "hailp.managed-account-transfer"
        } else {
            "hailp.account-transfer"
        }
        || s["version"] != 1
        || s["provider"] != a["provider"]
        || s["accountId"] != a["accountId"]
        || s["did"] != a["did"]
        || a["custodyProfile"]
            != if managed {
                "managed"
            } else {
                "owner-controlled"
            }
        || !allowed(a)
        || if managed {
            s["ownerRecoveryKey"] != a["ownerRecoveryPublicKey"]
                || s["sourceIdentityKey"] != a["identityPublicKey"]
        } else {
            s["key"] != a["identityPublicKey"] || !s["cancellation"].is_null()
        }
    {
        return Err(invalid());
    }
    Ok(())
}
pub fn review_grant(s: &Value, managed: bool) -> Result<Value, Error> {
    let kind = if managed {
        "hail.managed-transfer-grant"
    } else {
        "hail.transfer-grant"
    };
    let key = text(&s[if managed { "ownerRecoveryKey" } else { "key" }])?;
    let grant = verify(&s["grant"], kind, key, managed, managed)?;
    let url = destination(text(&s["destination"])?)?;
    if grant["did"] != s["did"]
        || grant["source_service_base"] != format!("{}/hail", text(&s["provider"])?)
        || grant["destination_service_base"] != format!("{}/hail", text(&s["destination"])?)
        || grant["destination_domain"] != url.host_str().unwrap()
        || managed
            && (grant["owner_recovery_key"] != s["ownerRecoveryKey"]
                || grant["source_identity_key"] != s["sourceIdentityKey"])
    {
        return Err(invalid());
    }
    Ok(grant)
}
pub fn review_ack(s: &Value, grant: &Value, wire: &Value) -> Result<Value, Error> {
    let (bytes, _) = self::wire(wire, true)?;
    let raw = plc::decoded(&bytes, 262144)?;
    let ack = verify(
        wire,
        "hail.managed-transfer-acknowledgement",
        text(&raw["source_messaging_key"])?,
        true,
        false,
    )?;
    if ack["did"] != s["did"]
        || ack["nonce"] != grant["nonce"]
        || ack["source_service_base"] != grant["source_service_base"]
        || ack["destination_service_base"] != grant["destination_service_base"]
        || ack["grant_digest"] != hash_wire(&s["grant"])?
    {
        return Err(invalid());
    }
    Ok(ack)
}
pub fn review_offer(s: &Value, grant: &Value, managed: bool, live: bool) -> Result<Value, Error> {
    let (bytes, _) = wire(&s["offer"], managed)?;
    let raw = plc::decoded(&bytes, 262144)?;
    let offer = verify(
        &s["offer"],
        if managed {
            "hail.managed-transfer-offer"
        } else {
            "hail.transfer-offer"
        },
        text(&raw["destination_messaging_key"])?,
        managed,
        false,
    )?;
    if offer["did"] != s["did"]
        || offer["nonce"] != grant["nonce"]
        || offer["source_service_base"] != grant["source_service_base"]
        || offer["destination_service_base"] != grant["destination_service_base"]
        || live
            && (integer(&offer["expires_at"])? <= now()
                || integer(&offer["expires_at"])? > integer(&grant["expires_at"])?)
        || offer["grant_digest"] != hash_wire(&s["grant"])?
        || !UUID.is_match(text(&offer["transfer_id"])?)
        || !text(&offer["destination_rotation_key"])?.starts_with("did:key:z")
    {
        return Err(invalid());
    }
    if managed {
        let ack = review_ack(s, grant, &s["acknowledgement"])?;
        if offer["grant_digest"] != ack["grant_digest"]
            || offer["acknowledgement_digest"] != hash_wire(&s["acknowledgement"])?
        {
            return Err(invalid());
        }
        let keys = [
            text(&offer["destination_rotation_key"])?,
            text(&offer["destination_identity_key"])?,
            text(&offer["destination_messaging_key"])?,
        ];
        if keys.iter().any(|k| !k.starts_with("did:key:z"))
            || keys.iter().collect::<std::collections::HashSet<_>>().len() != 3
        {
            return Err(invalid());
        }
    } else if offer["destination_rotation_key"] == offer["destination_messaging_key"] {
        return Err(invalid());
    }
    Ok(offer)
}
pub fn validate_status(v: &Value, a: &Value, managed: bool) -> Result<(), Error> {
    let phases: &[&str] = if managed {
        &[
            "none",
            "acknowledgement-retained",
            "offer-ready",
            "expired",
            "expired-unresolved",
        ]
    } else {
        &[
            "none",
            "invitation-pending",
            "offer-ready",
            "expired",
            "expired-unresolved",
            "cancelled",
            "fenced",
            "exported",
            "retired",
        ]
    };
    if v["type"]
        != if managed {
            "hailp.managed-transfer-status"
        } else {
            "hailp.transfer-status"
        }
        || v["version"] != 1
        || v["provider"] != a["provider"]
        || v["accountId"] != a["accountId"]
        || v["did"] != a["did"]
        || !phases.contains(&text(&v["phase"])?)
    {
        return Err(invalid());
    }
    Ok(())
}
pub async fn status(client: &Client, managed: bool) -> Result<Value, Error> {
    let a = client.account().await?;
    let v = client
        .get(if managed {
            "/transfers/managed"
        } else {
            "/transfers"
        })
        .await?;
    validate_status(&v, &a, managed)?;
    Ok(v)
}
pub fn sign_intent(
    state: &Value,
    payload: &Value,
    vp: &str,
    managed: bool,
    digests: &[&str],
) -> Result<Value, Error> {
    let secret = private::recovery_secret()?;
    let v: Value = serde_json::from_slice(&private::read(vp, 16384)?).map_err(|_| invalid())?;
    if v["did"].is_null() || v["did"] != state["did"] {
        return Err(invalid());
    }
    let bytes = plc::with_digests(payload, digests)?;
    let mut input = format!("{}.v1\0", text(&payload["type"])?).into_bytes();
    input.extend_from_slice(&bytes);
    let signature = if managed {
        let user = vault::unlock(v, &secret)?;
        if user.vault["recovery"]["publicDidKey"] != state["ownerRecoveryKey"] {
            return Err(invalid());
        }
        crypto::sign_recovery(&user.recovery, &input)
    } else {
        let key = vault::unlock_identity(&v, &secret)?;
        if v["identity"]["publicDidKey"] != state["key"] {
            return Err(invalid());
        }
        key.sign(&input).to_bytes()
    };
    Ok(
        json!({"payload":URL_SAFE_NO_PAD.encode(bytes),"signature":URL_SAFE_NO_PAD.encode(signature)}),
    )
}
pub async fn offer(client: &Client, args: &Args, managed: bool) -> Result<Value, Error> {
    let dest = &args.options["destination"];
    let url = destination(dest)?;
    let a = client.account().await?;
    if !allowed(&a)
        || !a["migrationState"].is_null()
        || a["custodyProfile"]
            != if managed {
                "managed"
            } else {
                "owner-controlled"
            }
        || !a["identityPublicKey"].is_string()
        || managed && !a["ownerRecoveryPublicKey"].is_string()
        || a["provider"] == *dest
    {
        return Err(invalid());
    }
    let path = &args.options["state"];
    let mut s = if let Some(bytes) = private::optional_bytes(path, 32768)? {
        serde_json::from_slice::<Value>(&bytes).map_err(|_| invalid())?
    } else {
        let mut s = json!({"type":if managed{"hailp.managed-account-transfer"}else{"hailp.account-transfer"},"version":1,"provider":a["provider"],"accountId":a["accountId"],"did":a["did"],"destination":dest});
        if managed {
            s["ownerRecoveryKey"] = a["ownerRecoveryPublicKey"].clone();
            s["sourceIdentityKey"] = a["identityPublicKey"].clone();
        } else {
            s["key"] = a["identityPublicKey"].clone();
        }
        private::create(path, s.to_string().as_bytes())?;
        s
    };
    selected(&s, &a, managed)?;
    if s["destination"] != *dest {
        return Err(invalid());
    }
    if s["grant"].is_null() {
        let now = now();
        let mut p = json!({"type":if managed{"hail.managed-transfer-grant"}else{"hail.transfer-grant"},"version":1,"did":s["did"],"nonce":nonce()?,"source_service_base":format!("{}/hail",text(&s["provider"])?),"destination_service_base":format!("{dest}/hail"),"destination_domain":url.host_str().unwrap(),"issued_at":now,"expires_at":now+3600});
        if managed {
            p["owner_recovery_key"] = s["ownerRecoveryKey"].clone();
            p["source_identity_key"] = s["sourceIdentityKey"].clone();
        }
        s["grant"] = sign_intent(&s, &p, &args.options["vault"], managed, &[])?;
        private::replace(path, &s)?;
    }
    let grant = review_grant(&s, managed)?;
    if integer(&grant["expires_at"])? <= now() {
        return Err(invalid());
    }
    let response = client
        .post(
            if managed {
                "/transfers/managed/offer"
            } else {
                "/transfers/offer"
            },
            &s["grant"],
        )
        .await?;
    if managed {
        validate_status(&response, &a, true)?;
        wire(&response["acknowledgement"], true)?;
        review_ack(&s, &grant, &response["acknowledgement"])?;
        if !s["acknowledgement"].is_null() && s["acknowledgement"] != response["acknowledgement"] {
            return Err(invalid());
        }
        s["acknowledgement"] = response["acknowledgement"].clone();
        private::replace(path, &s)?;
    } else if response["type"] != "hailp.transfer-status"
        || response["version"] != 1
        || response["did"] != s["did"]
        || response["accountId"] != s["accountId"]
        || response["provider"] != s["provider"]
        || response["nonce"] != grant["nonce"]
        || response["destinationServiceBase"] != grant["destination_service_base"]
    {
        return Err(invalid());
    }
    if response["offer"].is_null() {
        if response["phase"]
            != if managed {
                "acknowledgement-retained"
            } else {
                "invitation-pending"
            }
        {
            return Err(invalid());
        }
        return Ok(json!({"did":s["did"],"destination":dest,"pending":true,"stateFile":path}));
    }
    wire(&response["offer"], managed)?;
    if !s["offer"].is_null() && s["offer"] != response["offer"] {
        return Err(invalid());
    }
    s["offer"] = response["offer"].clone();
    let offer = review_offer(&s, &grant, managed, true)?;
    if response["originConfirmed"] != true
        || response["phase"] != "offer-ready"
        || managed
            && (response["transferId"] != offer["transfer_id"]
                || response["destinationServiceBase"] != grant["destination_service_base"])
    {
        return Err(invalid());
    }
    private::replace(path, &s)?;
    let mut result = json!({"did":s["did"],"destination":dest,"transferId":offer["transfer_id"],"expiresAt":offer["expires_at"],"destinationRotationPublicKey":offer["destination_rotation_key"],"destinationMessagingPublicKey":offer["destination_messaging_key"],"phase":"offer-ready","stateFile":path});
    if managed {
        result["destinationIdentityPublicKey"] = offer["destination_identity_key"].clone();
    }
    Ok(result)
}

pub async fn target(origin: &str, operation: &str, body: &Value) -> Result<(u16, Value), Error> {
    destination(origin)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(
            if matches!(operation, "managed-completions" | "managed-retirements") {
                15
            } else {
                10
            },
        ))
        .build()
        .map_err(|_| invalid())?;
    let mut response = client
        .post(format!("{origin}/.well-known/hail/transfers/{operation}"))
        .header("Content-Type", "application/hail-transfer+json")
        .header("Accept-Encoding", "identity")
        .header("Cache-Control", "no-store")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| Error::client("Destination transport failed; retain exact transfer state"))?;
    let status = response.status().as_u16();
    let empty = matches!(
        operation,
        "cancellations" | "retirements" | "managed-retirements"
    );
    let complete = operation.ends_with("completions");
    let h = response.headers();
    if !(if empty {
        status == 204
    } else if complete {
        status == 200
    } else {
        matches!(status, 200 | 202)
    }) || h.contains_key("Location")
        || h.contains_key("Content-Encoding")
        || !empty
            && h.get("Content-Type").and_then(|v| v.to_str().ok())
                != Some("application/hail-transfer+json")
        || h.get("Content-Length").is_some_and(|v| {
            v.to_str()
                .ok()
                .and_then(|s| {
                    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
                        s.parse::<u64>().ok()
                    } else {
                        None
                    }
                })
                .is_none_or(|n| n > 16384)
        })
    {
        return Err(Error::client(
            "Destination response invalid; retain and retry exact transfer state",
        ));
    }
    if empty {
        return Ok((status, Value::Null));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| invalid())? {
        if bytes.len() + chunk.len() > 16384 {
            return Err(invalid());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((
        status,
        serde_json::from_slice(&bytes).map_err(|_| invalid())?,
    ))
}
pub async fn select(client: &Client, args: &Args, managed: bool) -> Result<Value, Error> {
    let username = &args.options["username"];
    if username.is_empty()
        || username.len() > 63
        || !username.as_bytes()[0].is_ascii_alphanumeric()
        || !username.as_bytes().last().unwrap().is_ascii_alphanumeric()
        || username.contains("..")
        || username
            .split('.')
            .any(|s| s.starts_with('-') || s.ends_with('-'))
        || !username
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
    {
        return Err(Error::client(
            "Username must be a canonical Hail local part",
        ));
    }
    let a = client.account().await?;
    let path = &args.options["state"];
    let mut s = load(path)?;
    selected(&s, &a, managed)?;
    if !a["migrationState"].is_null() && s["selection"].is_null() {
        return Err(invalid());
    }
    let grant = review_grant(&s, managed)?;
    let offer = review_offer(&s, &grant, managed, true)?;
    let address = format!("{username}@{}", text(&grant["destination_domain"])?);
    let status = if managed {
        let v = client.get("/transfers/managed").await?;
        validate_status(&v, &a, true)?;
        v
    } else {
        self::status(client, false).await?
    };
    if status["originConfirmed"] != true
        || status["transferId"] != offer["transfer_id"]
        || status["offer"] != s["offer"]
        || if managed {
            status["phase"] != "offer-ready" || status["acknowledgement"] != s["acknowledgement"]
        } else {
            status["nonce"] != grant["nonce"]
                || status["destinationServiceBase"] != grant["destination_service_base"]
                || !(status["phase"] == "offer-ready"
                    || !s["selection"].is_null()
                        && matches!(status["phase"].as_str(), Some("fenced" | "exported")))
        }
    {
        return Err(invalid());
    }
    if s["selection"].is_null() {
        let now = now();
        let p = json!({"type":if managed{"hail.managed-transfer-address-selection"}else{"hail.transfer-address-selection"},"version":1,"did":s["did"],"nonce":grant["nonce"],"transfer_id":offer["transfer_id"],"grant_digest":hash_wire(&s["grant"])?,"offer_digest":hash_wire(&s["offer"])?,"address":address,"selection_nonce":nonce()?,"issued_at":now,"expires_at":(now+1800).min(integer(&offer["expires_at"])?).min(integer(&grant["expires_at"])?) });
        s["selection"] = sign_intent(
            &s,
            &p,
            &args.options["vault"],
            managed,
            &["grant_digest", "offer_digest"],
        )?;
        private::replace(path, &s)?;
    }
    let selection = verify(
        &s["selection"],
        if managed {
            "hail.managed-transfer-address-selection"
        } else {
            "hail.transfer-address-selection"
        },
        text(&s[if managed { "ownerRecoveryKey" } else { "key" }])?,
        managed,
        managed,
    )?;
    if selection["did"] != s["did"]
        || selection["nonce"] != grant["nonce"]
        || selection["transfer_id"] != offer["transfer_id"]
        || selection["address"] != address
        || integer(&selection["expires_at"])? <= now()
        || integer(&selection["expires_at"])? > integer(&offer["expires_at"])?
        || selection["grant_digest"] != hash_wire(&s["grant"])?
        || selection["offer_digest"] != hash_wire(&s["offer"])?
    {
        return Err(invalid());
    }
    let (status, receipt) = target(
        text(&s["destination"])?,
        if managed {
            "managed-reservations"
        } else {
            "reservations"
        },
        &s["selection"],
    )
    .await?;
    let reservation = verify(
        &receipt,
        if managed {
            "hail.managed-transfer-reservation"
        } else {
            "hail.transfer-reservation"
        },
        text(&offer["destination_messaging_key"])?,
        managed,
        false,
    )?;
    if reservation["did"] != s["did"]
        || reservation["nonce"] != grant["nonce"]
        || reservation["transfer_id"] != offer["transfer_id"]
        || reservation["address"] != address
        || integer(&reservation["expires_at"])? <= now()
        || integer(&reservation["expires_at"])? > integer(&selection["expires_at"])?
        || reservation["offer_digest"] != selection["offer_digest"]
        || reservation["selection_digest"] != hash_wire(&s["selection"])?
        || managed
            && [
                "destination_rotation_key",
                "destination_identity_key",
                "destination_messaging_key",
            ]
            .iter()
            .any(|k| reservation[k] != offer[k])
    {
        return Err(invalid());
    }
    if !s["reservation"].is_null() && s["reservation"] != receipt {
        return Err(invalid());
    }
    s["reservation"] = receipt;
    private::replace(path, &s)?;
    Ok(
        json!({"did":s["did"],"destination":s["destination"],"address":address,"transferId":offer["transfer_id"],"requestAcknowledged":status==200,"stateFile":path}),
    )
}
pub async fn cancel(client: &Client, args: &Args) -> Result<Value, Error> {
    let a = client.account().await?;
    let path = &args.options["state"];
    let mut s = load(path)?;
    // Retained cancellations are intentional retries; unlike Offer/selection they remain valid state.
    let mut selection_check = s.clone();
    selection_check["cancellation"] = Value::Null;
    selected(&selection_check, &a, false)?;
    if !a["migrationState"].is_null() || s["grant"].is_null() {
        return Err(invalid());
    }
    let grant = review_grant(&s, false)?;
    if s["cancellation"].is_null() {
        let now = now();
        let p = json!({"type":"hail.transfer-cancellation","version":1,"did":s["did"],"nonce":grant["nonce"],"grant_digest":hash_wire(&s["grant"])?,"issued_at":now,"expires_at":now+3600});
        s["cancellation"] = sign_intent(&s, &p, &args.options["vault"], false, &["grant_digest"])?;
        private::replace(path, &s)?;
    }
    let cancellation = verify(
        &s["cancellation"],
        "hail.transfer-cancellation",
        text(&s["key"])?,
        false,
        false,
    )?;
    if cancellation["did"] != s["did"]
        || cancellation["nonce"] != grant["nonce"]
        || cancellation["grant_digest"] != hash_wire(&s["grant"])?
        || (s["receipt"].is_null() || s["sourceMessagingKey"].is_null())
            && integer(&cancellation["expires_at"])? <= now()
    {
        return Err(invalid());
    }
    let result = if !s["receipt"].is_null() && !s["sourceMessagingKey"].is_null() {
        json!({"type":"hailp.transfer-cancellation","version":1,"cancelled":true,"receipt":s["receipt"],"sourceMessagingPublicKey":s["sourceMessagingKey"]})
    } else {
        client.post("/transfers/cancel", &s["cancellation"]).await?
    };
    if result["type"] != "hailp.transfer-cancellation"
        || result["version"] != 1
        || result["cancelled"] != true
    {
        return Err(invalid());
    }
    let receipt = &result["receipt"];
    let value = verify(
        receipt,
        "hail.transfer-cancellation-receipt",
        text(&result["sourceMessagingPublicKey"])?,
        false,
        false,
    )?;
    if value["did"] != s["did"]
        || value["nonce"] != grant["nonce"]
        || value["source_service_base"] != format!("{}/hail", text(&s["provider"])?)
        || value["destination_domain"] != destination(text(&s["destination"])?)?.host_str().unwrap()
        || integer(&value["expires_at"])? <= now()
        || value["grant_digest"] != hash_wire(&s["grant"])?
    {
        return Err(invalid());
    }
    if !s["offer"].is_null() {
        let (bytes, _) = wire(&s["offer"], false)?;
        let offer = plc::decoded(&bytes, 262144)?;
        if value["invitation_digest"] != offer["invitation_digest"] {
            return Err(invalid());
        }
    }
    if !s["receipt"].is_null() && s["receipt"] != *receipt {
        return Err(invalid());
    }
    s["receipt"] = receipt.clone();
    s["sourceMessagingKey"] = result["sourceMessagingPublicKey"].clone();
    private::replace(path, &s)?;
    target(
        text(&s["destination"])?,
        "cancellations",
        &json!({"cancellation":s["cancellation"],"receipt":receipt}),
    )
    .await
    .map_err(|_| {
        Error::client(
            "Source cancelled; target cleanup is unconfirmed. Retry the exact transfer state",
        )
    })?;
    s["targetAcknowledged"] = true.into();
    private::replace(path, &s)?;
    Ok(
        json!({"did":s["did"],"destination":s["destination"],"cancelled":true,"targetAcknowledged":true,"stateFile":path}),
    )
}
