pub(crate) mod cbor;
mod schema;
#[cfg(test)]
mod tests;

use crate::contract::Error;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use cbor::{Limits, Value, decode, invalid};
use sha2::{Digest, Sha256};

pub fn decode_base64(text: &str) -> Result<Vec<u8>, Error> {
    URL_SAFE_NO_PAD
        .decode(text)
        .map_err(|_| Error::client("Invalid canonical unpadded base64url"))
}
pub fn digest(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
}

fn profile(kind: &str) -> Result<(&'static str, &'static str, &'static str, usize), Error> {
    Ok(match kind {
        "hail.address-binding" => (
            "application/hail-address-binding+cbor",
            "did",
            "hail-identity",
            16384,
        ),
        "hail.sender-profile" => (
            "application/hail-sender-profile+cbor",
            "did",
            "hail-messaging",
            65536,
        ),
        "hail.grant" => (
            "application/hail-grant+cbor",
            "grantor",
            "hail-identity",
            262144,
        ),
        "hail.connection-invitation" => (
            "application/hail-connection-invitation+cbor",
            "from",
            "hail-identity",
            16384,
        ),
        "hail.connection-confirmation" => (
            "application/hail-connection-confirmation+cbor",
            "from",
            "hail-identity",
            16384,
        ),
        _ => return Err(invalid()),
    })
}
struct Parsed {
    payload: Value,
    protected: Vec<u8>,
    payload_bytes: Vec<u8>,
    signature: Vec<u8>,
}
fn parse(kind: &str, bytes: &[u8]) -> Result<Parsed, Error> {
    let (content_type, signer, role, maximum) = profile(kind)?;
    let Value::Tag(18, outer) = decode(bytes, Limits::cose(maximum), true)? else {
        return Err(invalid());
    };
    let [protected, unprotected, payload, signature] = outer.array()? else {
        return Err(invalid());
    };
    if *unprotected != Value::Map(vec![]) || signature.bytes()?.len() != 64 {
        return Err(invalid());
    }
    let Value::Map(headers) = decode(protected.bytes()?, Limits::cose(1024), false)? else {
        return Err(invalid());
    };
    if headers.len() != 3 {
        return Err(invalid());
    }
    let header = |key| {
        headers
            .iter()
            .find(|(k, _)| *k == Value::Int(key))
            .map(|(_, v)| v)
            .ok_or_else(invalid)
    };
    if *header(1)? != Value::Int(-19) || header(3)?.text()? != content_type {
        return Err(invalid());
    }
    let kid = std::str::from_utf8(header(4)?.bytes()?).map_err(|_| invalid())?;
    let payload_bytes = payload.bytes()?.to_vec();
    let payload = decode(&payload_bytes, Limits::payload(maximum), false)?;
    schema::validate(kind, &payload)?;
    if kid != format!("{}#{role}", payload.field(signer).text()?)
        || payload.field("key_id").text()? != kid
    {
        return Err(invalid());
    }
    Ok(Parsed {
        payload,
        protected: protected.bytes()?.to_vec(),
        payload_bytes,
        signature: signature.bytes()?.to_vec(),
    })
}
fn signature_input(protected: &[u8], payload: &[u8]) -> Result<Vec<u8>, Error> {
    cbor::encode(
        &Value::Array(vec![
            Value::Text("Signature1".into()),
            Value::Bytes(protected.to_vec()),
            Value::Bytes(vec![]),
            Value::Bytes(payload.to_vec()),
        ]),
        Limits::cose(264192),
        false,
    )
}
// Read-only inspection is intentionally separate from signature authentication.
pub fn inspect(kind: &str, bytes: &[u8]) -> Result<serde_json::Value, Error> {
    Ok(parse(kind, bytes)?.payload.diagnostic())
}
pub fn verify(kind: &str, bytes: &[u8], public: &str) -> Result<serde_json::Value, Error> {
    let parsed = parse(kind, bytes)?;
    let key = crate::crypto::ed_public(public)?;
    key.verify_strict(
        &signature_input(&parsed.protected, &parsed.payload_bytes)?,
        &ed25519_dalek::Signature::from_slice(&parsed.signature).map_err(|_| invalid())?,
    )
    .map_err(|_| Error::client("Signature verification failed"))?;
    Ok(parsed.payload.diagnostic())
}
pub fn sign(
    kind: &str,
    payload: &Value,
    key: &ed25519_dalek::SigningKey,
) -> Result<Vec<u8>, Error> {
    use ed25519_dalek::Signer;
    let (content_type, signer, role, maximum) = profile(kind)?;
    schema::validate(kind, payload)?;
    let kid = format!("{}#{role}", payload.field(signer).text()?);
    let protected = cbor::encode(
        &Value::Map(vec![
            (Value::Int(1), Value::Int(-19)),
            (Value::Int(3), Value::Text(content_type.into())),
            (Value::Int(4), Value::Bytes(kid.into_bytes())),
        ]),
        Limits::cose(1024),
        false,
    )?;
    let payload = cbor::encode(payload, Limits::payload(maximum), false)?;
    let signature = key
        .sign(&signature_input(&protected, &payload)?)
        .to_bytes()
        .to_vec();
    cbor::encode(
        &Value::Tag(
            18,
            Box::new(Value::Array(vec![
                Value::Bytes(protected),
                Value::Map(vec![]),
                Value::Bytes(payload),
                Value::Bytes(signature),
            ])),
        ),
        Limits::cose(maximum),
        true,
    )
}
pub fn from_diagnostic(kind: &str, value: &serde_json::Value) -> Result<Value, Error> {
    fn convert(value: &mut Value) -> Result<(), Error> {
        match value {
            Value::Array(values) => {
                for value in values {
                    convert(value)?;
                }
            }
            Value::Map(entries) => {
                let digest = entries.iter().any(|(k, v)| {
                    *k == Value::Text("algorithm".into()) && *v == Value::Text("sha-256".into())
                });
                for (key, value) in entries {
                    let name = key.text()?;
                    if matches!(name, "token" | "previous" | "data") || name == "value" && digest {
                        if let Value::Text(text) = value {
                            let bytes = decode_base64(text)?;
                            if name != "data" && bytes.len() != 32 {
                                return Err(invalid());
                            }
                            *value = Value::Bytes(bytes);
                        }
                    } else {
                        convert(value)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut result = cbor::from_json(value)?;
    convert(&mut result)?;
    schema::validate(kind, &result)?;
    Ok(result)
}
