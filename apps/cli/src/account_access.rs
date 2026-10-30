use crate::{
    api::Client,
    cli::Args,
    codec,
    contract::{DID, Error, UUID},
    credentials, crypto, plc, private, vault,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::Signer;
use serde_json::{Value, json};
fn invalid() -> Error {
    Error::client(
        "Account access state, challenge or acknowledgement differs from the reviewed request or expired",
    )
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn integer(v: &Value) -> Option<i64> {
    v.as_i64()
        .filter(|v| v.unsigned_abs() <= 9_007_199_254_740_991)
}
fn hash_text(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 43
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    })
}
pub fn input(c: &Value) -> Result<Vec<u8>, Error> {
    vault::exact(
        c,
        &[
            "type",
            "version",
            "purpose",
            "challengeId",
            "provider",
            "accountId",
            "did",
            "signer",
            "publicKey",
            "scopes",
            "tokenHash",
            "nonce",
            "issuedAt",
            "expiresAt",
        ],
    )?;
    let purpose = c["purpose"].as_str().unwrap_or("");
    let issued = integer(&c["issuedAt"]).ok_or_else(invalid)?;
    let expires = integer(&c["expiresAt"]).ok_or_else(invalid)?;
    if c["type"] != "hailp.account-access"
        || c["version"].as_f64() != Some(1.0)
        || !matches!(purpose, "new-api-credential" | "passkey-enrollment")
        || !c["challengeId"].as_str().is_some_and(|s| UUID.is_match(s))
        || !c["accountId"].as_str().is_some_and(|s| UUID.is_match(s))
        || !c["did"].as_str().is_some_and(|s| DID.is_match(s))
        || !matches!(c["signer"].as_str(), Some("identity" | "owner-recovery"))
        || !c["publicKey"]
            .as_str()
            .is_some_and(|s| crypto::did_bytes(s).is_ok())
        || !hash_text(&c["tokenHash"])
        || !hash_text(&c["nonce"])
        || expires <= issued
        || expires - issued > 300
    {
        return Err(invalid());
    }
    credentials::scopes(&c["scopes"])?;
    if purpose == "passkey-enrollment" && c["scopes"] != json!(["credentials:write"]) {
        return Err(invalid());
    }
    crate::api::canonical_origin(c["provider"].as_str().ok_or_else(invalid)?)?;
    let mut bytes = b"hailp.account-access.v1\0".to_vec();
    bytes.extend(plc::dag(c)?);
    Ok(bytes)
}
pub async fn run(args: &Args) -> Result<Value, Error> {
    let opt = |k: &str| args.options.get(k).map(String::as_str).unwrap_or("");
    let recovery = args.command == "account passkey-recover";
    let output = opt(if recovery { "output" } else { "credentials" });
    let state_path = opt("state");
    let vault_path = opt("vault");
    let provider = opt("provider");
    let did = opt("did");
    let signer = opt("signer");
    private::distinct(&[vault_path, state_path, output])?;
    if !DID.is_match(did) || !matches!(signer, "identity" | "owner-recovery") {
        return Err(invalid());
    }
    let scopes = if recovery {
        vec!["credentials:write".to_string()]
    } else {
        credentials::scopes(&json!(args.scopes))?
    };
    let v = private::optional_json(vault_path)?.ok_or_else(invalid)?;
    if v["did"] != did {
        return Err(invalid());
    }
    let public = v[if signer == "identity" {
        "identity"
    } else {
        "recovery"
    }]["publicDidKey"]
        .as_str()
        .ok_or_else(invalid)?;
    let state_type = if recovery {
        "hailp.passkey-recovery"
    } else {
        "hailp.account-login"
    };
    let mut state = if let Some(s) = private::optional_json(state_path)? {
        s
    } else {
        if !recovery && private::optional_json(output)?.is_some() {
            return Err(invalid());
        }
        let token = credentials::token()?;
        Client::signup(provider, &token)?;
        let mut state = json!({"type":state_type,"version":1,"provider":provider,"did":did,"signer":signer,"publicKey":public,"token":token,"createdAt":now()});
        if !recovery {
            state["scopes"] = json!(scopes);
        }
        private::create(state_path, state.to_string().as_bytes())?;
        state
    };
    let created = integer(&state["createdAt"]).ok_or_else(invalid)?;
    if state["type"] != state_type
        || state["version"].as_f64() != Some(1.0)
        || state["provider"] != provider
        || state["did"] != did
        || state["signer"] != signer
        || state["publicKey"] != public
        || (!recovery && credentials::scopes(&state["scopes"])? != scopes)
        || created > now() + 30
        || now() - created >= 300
    {
        return Err(invalid());
    }
    let token = state["token"].as_str().ok_or_else(invalid)?.to_string();
    let client = Client::signup(provider, &token)?;
    let hash = codec::digest(token.as_bytes());
    let secret = private::recovery_secret()?;
    // Always unlock only the explicitly selected signer before contacting the provider.
    let identity = if signer == "identity" {
        Some(vault::unlock_identity(&v, &secret)?)
    } else {
        None
    };
    let owner = if signer == "owner-recovery" {
        Some(vault::unlock(v.clone(), &secret)?)
    } else {
        None
    };
    let challenge = if let Some(c) = state.get("challenge") {
        c.clone()
    } else {
        let mut body =
            json!({"did":did,"signer":signer,"publicKey":public,"scopes":scopes,"tokenHash":hash});
        if recovery {
            body["purpose"] = "passkey-enrollment".into();
        }
        client
            .request_at("/prepare", "/api/v1/account-access", Some(&body))
            .await?
    };
    let bytes = input(&challenge)?;
    if challenge["purpose"]
        != if recovery {
            "passkey-enrollment"
        } else {
            "new-api-credential"
        }
        || challenge["provider"] != provider
        || challenge["did"] != did
        || challenge["signer"] != signer
        || challenge["publicKey"] != public
        || challenge["tokenHash"] != hash
        || challenge["scopes"] != json!(scopes)
        || integer(&challenge["issuedAt"]).ok_or_else(invalid)? > now() + 30
        || integer(&challenge["issuedAt"]).ok_or_else(invalid)? < created - 30
        || integer(&challenge["expiresAt"]).ok_or_else(invalid)? <= now()
    {
        return Err(invalid());
    }
    state["challenge"] = challenge.clone();
    private::replace(state_path, &state)?;
    if state["signature"].as_str().is_none_or(|s| s.is_empty()) {
        let sig = if let Some(identity) = identity {
            identity.sign(&bytes).to_bytes().to_vec()
        } else {
            crypto::sign_recovery(&owner.as_ref().unwrap().recovery, &bytes).to_vec()
        };
        state["signature"] = URL_SAFE_NO_PAD.encode(sig).into();
        private::replace(state_path, &state)?;
    }
    let result=client.request_at("/complete","/api/v1/account-access",Some(&json!({"challengeId":challenge["challengeId"],"token":token,"signature":state["signature"]}))).await?;
    let artifact = &result[if recovery { "enrollment" } else { "credential" }];
    if artifact["type"]
        != if recovery {
            "hailp.passkey-enrollment"
        } else {
            "hailp.api-credential"
        }
        || artifact["version"].as_f64() != Some(1.0)
        || artifact["provider"] != provider
        || artifact["accountId"] != challenge["accountId"]
        || artifact["token"] != token
        || !artifact["expiresAt"]
            .as_str()
            .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
    {
        return Err(invalid());
    }
    let result = if recovery {
        let url = reqwest::Url::parse(artifact["url"].as_str().ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        if url.origin().ascii_serialization() != provider
            || url.path() != "/auth/recover"
            || url.query().is_some()
            || url.fragment() != Some(format!("token={token}").as_str())
        {
            return Err(invalid());
        }
        json!({"enrollmentFile":output,"expiresAt":artifact["expiresAt"],"did":did,"signer":signer})
    } else {
        if !artifact["credentialId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
            || credentials::scopes(&artifact["scopes"])? != scopes
        {
            return Err(invalid());
        }
        json!({"credentialId":artifact["credentialId"],"credentialFile":output,"scopes":scopes,"expiresAt":artifact["expiresAt"],"did":did,"signer":signer})
    };
    private::save_identical(output, artifact)?;
    Ok(result)
}
