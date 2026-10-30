use crate::{
    codec,
    contract::{DID, Error},
    crypto, private,
};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::pkcs8::DecodePrivateKey;
use serde_json::{Value, json};
use zeroize::Zeroizing;

pub struct Unlocked {
    pub vault: Value,
    pub recovery: p256::SecretKey,
    pub identity: ed25519_dalek::SigningKey,
}
fn invalid() -> Error {
    Error::client("Invalid user vault representation")
}
fn aad(role: &str, key: &str) -> Vec<u8> {
    format!("hail-user-vault-v1\0{role}\0{key}").into_bytes()
}
fn cipher(secret: &[u8]) -> Result<Aes256Gcm, Error> {
    Aes256Gcm::new_from_slice(secret)
        .map_err(|_| Error::client("Vault recovery secret must be exactly 256 bits"))
}
fn seal(secret: &[u8], role: &str, public: &str, private: &[u8]) -> Result<Value, Error> {
    let nonce = crypto::random::<12>()?;
    let ciphertext = cipher(secret)?
        .encrypt(
            Nonce::from_slice(nonce.as_ref()),
            Payload {
                msg: private,
                aad: &aad(role, public),
            },
        )
        .map_err(|_| Error::client("Vault encryption failed"))?;
    Ok(
        json!({"role":role,"publicDidKey":public,"nonce":URL_SAFE_NO_PAD.encode(nonce.as_ref()),"ciphertext":URL_SAFE_NO_PAD.encode(ciphertext)}),
    )
}
fn unseal(secret: &[u8], record: &Value, role: &str) -> Result<Zeroizing<Vec<u8>>, Error> {
    if record["role"] != role {
        return Err(invalid());
    }
    let public = record["publicDidKey"].as_str().ok_or_else(invalid)?;
    let nonce = codec::decode_base64(record["nonce"].as_str().ok_or_else(invalid)?)?;
    let ciphertext = codec::decode_base64(record["ciphertext"].as_str().ok_or_else(invalid)?)?;
    if nonce.len() != 12 || ciphertext.len() < 17 {
        return Err(Error::client("Vault ciphertext or nonce is invalid"));
    }
    cipher(secret)?
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad(role, public),
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| Error::client("Vault decryption failed"))
}
pub fn validate(v: &Value) -> Result<(), Error> {
    exact(
        v,
        &[
            "type",
            "version",
            "did",
            "createdAt",
            "recovery",
            "identity",
        ],
    )?;
    if v["type"] != "hail.user-vault"
        || v["version"].as_f64() != Some(1.0)
        || !(v["did"].is_null() || v["did"].as_str().is_some_and(|s| DID.is_match(s)))
        || !v["createdAt"]
            .as_str()
            .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
    {
        return Err(invalid());
    }
    for (name, role) in [("recovery", "user-recovery"), ("identity", "hail-identity")] {
        let r = &v[name];
        exact(r, &["role", "publicDidKey", "nonce", "ciphertext"])?;
        if r["role"] != role
            || !r["publicDidKey"]
                .as_str()
                .is_some_and(|s| crypto::did_bytes(s).is_ok())
            || !r["nonce"].is_string()
            || !r["ciphertext"].is_string()
        {
            return Err(invalid());
        }
    }
    if v["recovery"]["publicDidKey"] == v["identity"]["publicDidKey"] {
        return Err(invalid());
    }
    Ok(())
}
pub(crate) fn exact(v: &Value, keys: &[&str]) -> Result<(), Error> {
    if !v
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
    {
        return Err(invalid());
    }
    Ok(())
}
pub fn unlock_identity(v: &Value, secret: &[u8]) -> Result<ed25519_dalek::SigningKey, Error> {
    validate(v)?;
    let bytes = unseal(secret, &v["identity"], "hail-identity")?;
    let key = ed25519_dalek::SigningKey::from_pkcs8_der(&bytes)
        .map_err(|_| Error::client("Invalid vault identity private key"))?;
    if crypto::ed_did(&key.verifying_key()) != v["identity"]["publicDidKey"] {
        return Err(Error::client(
            "Vault identity private key does not match its public key",
        ));
    }
    Ok(key)
}
pub fn unlock(v: Value, secret: &[u8]) -> Result<Unlocked, Error> {
    validate(&v)?;
    let bytes = unseal(secret, &v["recovery"], "user-recovery")?;
    let recovery = p256::SecretKey::from_slice(&bytes)
        .map_err(|_| Error::client("Invalid vault recovery private key"))?;
    if crypto::p256_did(&recovery) != v["recovery"]["publicDidKey"] {
        return Err(Error::client("Vault public keys do not match private keys"));
    }
    let identity = unlock_identity(&v, secret)?;
    Ok(Unlocked {
        vault: v,
        recovery,
        identity,
    })
}
pub fn create() -> Result<(Value, Zeroizing<[u8; 32]>), Error> {
    let recovery = loop {
        let bytes = crypto::random::<32>()?;
        if let Ok(key) = p256::SecretKey::from_slice(bytes.as_ref()) {
            break key;
        }
    };
    let identity = ed25519_dalek::SigningKey::from_bytes(&*crypto::random::<32>()?);
    let secret = crypto::random::<32>()?;
    let mut pkcs8 = Zeroizing::new(vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ]);
    pkcs8.extend_from_slice(&identity.to_bytes());
    let recovery_bytes = Zeroizing::new(recovery.to_bytes());
    let created: chrono::DateTime<chrono::Utc> = std::time::SystemTime::now().into();
    let vault = json!({"type":"hail.user-vault","version":1,"did":null,"createdAt":created.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),
        "recovery":seal(secret.as_ref(),"user-recovery",&crypto::p256_did(&recovery),&recovery_bytes)?,
        "identity":seal(secret.as_ref(),"hail-identity",&crypto::ed_did(&identity.verifying_key()),&pkcs8)?});
    Ok((vault, secret))
}
pub fn verified(v: &Value, secret: &[u8], expected: Option<&str>) -> Result<Value, Error> {
    if expected.is_some_and(|s| s != "unbound" && !DID.is_match(s)) {
        return Err(Error::client(
            "Expected DID must be a canonical PLC DID or unbound",
        ));
    }
    let user = unlock(v.clone(), secret)?;
    // Prove that both loaded private keys can sign for their retained public roles.
    use ed25519_dalek::Signer;
    let challenge = crypto::random::<32>()?;
    crypto::verify(
        user.vault["recovery"]["publicDidKey"]
            .as_str()
            .ok_or_else(invalid)?,
        challenge.as_ref(),
        &crypto::sign_recovery(&user.recovery, challenge.as_ref()),
    )?;
    crypto::verify(
        user.vault["identity"]["publicDidKey"]
            .as_str()
            .ok_or_else(invalid)?,
        challenge.as_ref(),
        &user.identity.sign(challenge.as_ref()).to_bytes(),
    )?;
    if expected.is_some_and(|s| {
        if s == "unbound" {
            !user.vault["did"].is_null()
        } else {
            user.vault["did"] != s
        }
    }) {
        return Err(Error::client("Vault does not match the reviewed DID"));
    }
    Ok(
        json!({"verified":true,"did":user.vault["did"],"recoveryPublicKey":user.vault["recovery"]["publicDidKey"],"identityPublicKey":user.vault["identity"]["publicDidKey"]}),
    )
}
pub fn run(args: &crate::cli::Args) -> Result<Value, Error> {
    let opt = |key: &str| args.options.get(key).map(String::as_str).unwrap_or("");
    if args.command == "vault create" {
        let (vault, secret) = create()?;
        let secret_text = Zeroizing::new(format!("{}\n", URL_SAFE_NO_PAD.encode(secret.as_ref())));
        private::create(opt("recovery-file"), secret_text.as_bytes())?;
        private::create(opt("vault"), vault.to_string().as_bytes())?;
        return Ok(json!({"vaultFile":opt("vault"),"recoveryFile":opt("recovery-file")}));
    }
    let secret = private::recovery_secret()?;
    let source = if args.command == "vault import" {
        opt("file")
    } else {
        opt("vault")
    };
    let mut bytes = private::read(source, 98304)?;
    let input: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let vault = if input["type"] == "hail.recovery-package" {
        let vault = crate::plc::extract_recovery(&input, &secret)?;
        bytes = vault.to_string().into_bytes();
        vault
    } else {
        input
    };
    let expected = args.options.get("expected-did").map(String::as_str);
    let mut result = verified(&vault, &secret, expected)?;
    if args.command != "vault verify" {
        let output = if args.command == "vault backup" {
            opt("output")
        } else {
            opt("vault")
        };
        private::private_parent(output)?;
        private::create(output, &bytes)?;
        let recheck = (|| {
            let copied = private::read(output, 16384)?;
            if copied != bytes {
                return Err(Error::client("Vault copy differs from the verified backup"));
            }
            let v = serde_json::from_slice(&copied).map_err(|_| invalid())?;
            verified(&v, &secret, expected)?;
            Ok(())
        })();
        if let Err(e) = recheck {
            let _ = std::fs::remove_file(output);
            return Err(e);
        }
        result["vaultFile"] = output.into();
    }
    Ok(result)
}

pub fn replace_identity(mut v: Value, secret: &[u8]) -> Result<Unlocked, Error> {
    validate(&v)?;
    if v["did"].is_null() {
        return Err(Error::client(
            "Custody transition requires a bound user vault",
        ));
    }
    let recovery_bytes = unseal(secret, &v["recovery"], "user-recovery")?;
    let recovery = p256::SecretKey::from_slice(&recovery_bytes).map_err(|_| invalid())?;
    if crypto::p256_did(&recovery) != v["recovery"]["publicDidKey"] {
        return Err(invalid());
    }
    let identity = ed25519_dalek::SigningKey::from_bytes(&*crypto::random::<32>()?);
    let public = crypto::ed_did(&identity.verifying_key());
    if v["identity"]["publicDidKey"] == public {
        return Err(invalid());
    }
    let mut pkcs8 = Zeroizing::new(vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ]);
    let seed = Zeroizing::new(identity.to_bytes());
    pkcs8.extend_from_slice(seed.as_ref());
    v["identity"] = seal(secret, "hail-identity", &public, &pkcs8)?;
    Ok(Unlocked {
        vault: v,
        recovery,
        identity,
    })
}
