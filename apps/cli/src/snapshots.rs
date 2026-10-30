use crate::contract::Error;
use crate::{api::Client, cli::Args, codec, crypto, private, transfers as t};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
pub fn signed(tag: &str, payload: &[u8], signature: &[u8], key: &str) -> Result<(), Error> {
    crypto::ed_public(key)?;
    let mut input = format!("{tag}\0").into_bytes();
    input.extend_from_slice(payload);
    crypto::verify(key, &input, signature)
}
pub fn read(path: &str) -> Result<Value, Error> {
    serde_json::from_slice(&private::read(path, 100_000_000)?).map_err(|_| t::invalid())
}
pub fn verify(snapshot: &Value, managed: bool) -> Result<Value, Error> {
    crate::vault::exact(
        snapshot,
        &[
            "digest",
            "manifest",
            "signature",
            "sourceMessagingPublicKey",
            "type",
            "version",
        ],
    )?;
    let versions = if managed { vec![4, 6] } else { vec![2, 3, 5] };
    if snapshot["type"]
        != if managed {
            "hail.managed-migration-transfer"
        } else {
            "hail.portable-migration-transfer"
        }
        || !snapshot["version"]
            .as_i64()
            .is_some_and(|n| versions.contains(&n))
    {
        return Err(t::invalid());
    }
    let bytes = codec::decode_base64(t::text(&snapshot["manifest"])?)?;
    let signature = codec::decode_base64(t::text(&snapshot["signature"])?)?;
    if bytes.len() > 67_108_864
        || signature.len() != 64
        || snapshot["digest"] != codec::digest(&bytes)
    {
        return Err(t::invalid());
    }
    signed(
        &format!(
            "hail-migration-snapshot-v{}",
            t::integer(&snapshot["version"])?
        ),
        &Sha256::digest(&bytes),
        &signature,
        t::text(&snapshot["sourceMessagingPublicKey"])?,
    )?;
    let manifest: Value = serde_json::from_slice(&bytes).map_err(|_| t::invalid())?;
    if !manifest.is_object()
        || manifest["version"] != snapshot["version"]
        || managed && manifest["custodyProfile"] != "managed"
    {
        return Err(t::invalid());
    }
    Ok(manifest)
}
pub fn retained(s: &Value, managed: bool) -> Result<(Value, Value, Value, Value), Error> {
    let grant = t::review_grant(s, managed)?;
    let offer = t::review_offer(s, &grant, managed, managed)?;
    let selection = t::verify(
        &s["selection"],
        if managed {
            "hail.managed-transfer-address-selection"
        } else {
            "hail.transfer-address-selection"
        },
        t::text(&s[if managed { "ownerRecoveryKey" } else { "key" }])?,
        managed,
        managed,
    )?;
    let reservation = t::verify(
        &s["reservation"],
        if managed {
            "hail.managed-transfer-reservation"
        } else {
            "hail.transfer-reservation"
        },
        t::text(&offer["destination_messaging_key"])?,
        managed,
        false,
    )?;
    if !s["cancellation"].is_null()
        || selection["did"] != s["did"]
        || selection["nonce"] != grant["nonce"]
        || selection["transfer_id"] != offer["transfer_id"]
        || reservation["did"] != s["did"]
        || reservation["nonce"] != grant["nonce"]
        || reservation["transfer_id"] != offer["transfer_id"]
        || selection["address"] != reservation["address"]
        || selection["grant_digest"] != t::hash_wire(&s["grant"])?
        || selection["offer_digest"] != t::hash_wire(&s["offer"])?
        || reservation["offer_digest"] != selection["offer_digest"]
        || reservation["selection_digest"] != t::hash_wire(&s["selection"])?
    {
        return Err(t::invalid());
    }
    if managed {
        if [
            "destination_rotation_key",
            "destination_identity_key",
            "destination_messaging_key",
        ]
        .iter()
        .any(|k| reservation[k] != offer[k])
        {
            return Err(t::invalid());
        }
    } else if t::text(&selection["address"])?.split('@').nth(1)
        != grant["destination_domain"].as_str()
    {
        return Err(t::invalid());
    }
    Ok((grant, offer, selection, reservation))
}
pub fn matches(s: &Value, m: &Value, o: &Value, managed: bool) -> Result<(), Error> {
    if m["did"] != s["did"]
        || m["accountId"] != s["accountId"]
        || m["transferId"] != o["transfer_id"]
        || m["sourceServiceBase"] != format!("{}/hail", t::text(&s["provider"])?)
        || m["destinationServiceBase"] != format!("{}/hail", t::text(&s["destination"])?)
        || m["destinationRotationPublicKey"] != o["destination_rotation_key"]
        || m["destinationMessagingPublicKey"] != o["destination_messaging_key"]
        || if managed {
            m["ownerRecoveryPublicKey"] != s["ownerRecoveryKey"]
                || m["sourceIdentityPublicKey"] != s["sourceIdentityKey"]
                || m["destinationIdentityPublicKey"] != o["destination_identity_key"]
        } else {
            m["custodyProfile"] != "portable" || !matches!(m["version"].as_i64(), Some(2 | 3 | 5))
        }
    {
        return Err(t::invalid());
    }
    Ok(())
}
pub async fn export(client: &Client, args: &Args, managed: bool) -> Result<Value, Error> {
    let a = client.account().await?;
    let s = t::load(&args.options["state"])?;
    if managed {
        if s["type"] != "hailp.managed-account-transfer"
            || s["version"] != 1
            || s["provider"] != a["provider"]
            || s["accountId"] != a["accountId"]
            || s["did"] != a["did"]
            || a["custodyProfile"] != "managed"
            || !t::allowed(&a)
        {
            return Err(t::invalid());
        }
    } else {
        t::selected(&s, &a, false)?;
    }
    if !matches!(a["migrationState"].as_str(), Some("fenced" | "exported")) {
        return Err(t::invalid());
    }
    let (_, offer, _, _) = retained(&s, managed)?;
    let snapshot = client
        .post_limit(
            if managed {
                "/transfers/managed/export"
            } else {
                "/transfers/export"
            },
            &json!({"transferId":offer["transfer_id"]}),
            100_000_000,
        )
        .await?;
    let manifest = verify(&snapshot, managed)?;
    matches(&s, &manifest, &offer, managed)?;
    let output = &args.options["output"];
    let bytes = snapshot.to_string().into_bytes();
    if let Some(prior) = private::optional_bytes(output, 100_000_000)? {
        if managed {
            if prior != bytes {
                return Err(t::invalid());
            }
        } else {
            let prior: Value = serde_json::from_slice(&prior).map_err(|_| t::invalid())?;
            if [
                "type",
                "version",
                "manifest",
                "digest",
                "signature",
                "sourceMessagingPublicKey",
            ]
            .iter()
            .any(|k| prior[k] != snapshot[k])
            {
                return Err(t::invalid());
            }
        }
    } else {
        private::create(output, &bytes)?;
    }
    Ok(
        json!({"did":s["did"],"transferId":offer["transfer_id"],"digest":snapshot["digest"],"state":"exported","snapshotFile":output}),
    )
}
pub fn warn(m: &Value) {
    if !m["connections"].is_null() {
        eprintln!(
            "Account cutover invalidates ALL old connection links and QR codes, including the permanent personal code. Existing connections are separate; create fresh codes at the destination."
        );
    }
}
pub fn base64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}
