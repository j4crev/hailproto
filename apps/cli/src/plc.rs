use crate::{
    codec::{
        self,
        cbor::{self, Limits},
    },
    contract::Error,
    crypto, vault,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub fn dag(value: &Value) -> Result<Vec<u8>, Error> {
    cbor::encode(&cbor::from_json(value)?, Limits::payload(262144), false)
}
fn invalid() -> Error {
    Error::client("Invalid recovery identity")
}
pub fn service_base(endpoint: &str) -> Result<(), Error> {
    let url = reqwest::Url::parse(endpoint).map_err(|_| invalid())?;
    let path = if url.path() == "/" { "" } else { url.path() };
    let hostname = url.host_str().ok_or_else(invalid)?;
    let label = regex::Regex::new(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$").unwrap();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || hostname.parse::<std::net::IpAddr>().is_ok()
        || !hostname.split('.').all(|s| label.is_match(s))
        || endpoint != format!("{}{path}", url.origin().ascii_serialization())
        || !path.is_empty()
            && !path[1..].split('/').all(|s| {
                !s.is_empty()
                    && s != "."
                    && s != ".."
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"._~-".contains(&c))
            })
    {
        return Err(Error::client(
            "Managed genesis service must be a canonical HTTPS Hail service base",
        ));
    }
    Ok(())
}
pub fn review_managed(unsigned: &Value, v: &Value) -> Result<(), Error> {
    vault::exact(
        unsigned,
        &[
            "type",
            "prev",
            "rotationKeys",
            "verificationMethods",
            "alsoKnownAs",
            "services",
        ],
    )?;
    let rotations = unsigned["rotationKeys"].as_array().ok_or_else(invalid)?;
    let methods = unsigned["verificationMethods"]
        .as_object()
        .ok_or_else(invalid)?;
    let services = unsigned["services"].as_object().ok_or_else(invalid)?;
    let identity = unsigned["verificationMethods"]["hail-identity"]
        .as_str()
        .ok_or_else(invalid)?;
    let messaging = unsigned["verificationMethods"]["hail-messaging"]
        .as_str()
        .ok_or_else(invalid)?;
    if unsigned["type"] != "plc_operation"
        || !unsigned["prev"].is_null()
        || rotations.len() != 2
        || rotations[0] != v["recovery"]["publicDidKey"]
        || !unsigned["alsoKnownAs"]
            .as_array()
            .is_some_and(|v| v.is_empty())
        || methods.len() != 2
        || services.len() != 1
        || unsigned["services"]["hail"]["type"] != "HailMessaging"
    {
        return Err(invalid());
    }
    let keys = [
        rotations[0].as_str().ok_or_else(invalid)?,
        rotations[1].as_str().ok_or_else(invalid)?,
        identity,
        messaging,
    ];
    if keys.iter().collect::<HashSet<_>>().len() != 4
        || keys.iter().any(|k| v["identity"]["publicDidKey"] == *k)
    {
        return Err(invalid());
    }
    crypto::ed_public(identity)?;
    crypto::ed_public(messaging)?;
    crypto::rotation_key(keys[1])?;
    service_base(
        unsigned["services"]["hail"]["endpoint"]
            .as_str()
            .ok_or_else(invalid)?,
    )
}
pub fn extract_recovery(package: &Value, secret: &[u8]) -> Result<Value, Error> {
    vault::exact(package, &["type", "version", "vault", "operation", "setup"])?;
    if package["type"] != "hail.recovery-package"
        || package["version"].as_f64() != Some(1.0)
        || !package["setup"]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 65536)
    {
        return Err(Error::client("Invalid recovery package"));
    }
    let v = &package["vault"];
    vault::validate(v)?;
    let op = &package["operation"];
    vault::exact(
        op,
        &[
            "type",
            "prev",
            "rotationKeys",
            "verificationMethods",
            "alsoKnownAs",
            "services",
            "sig",
        ],
    )?;
    let encoded = dag(op)?;
    if encoded.len() > 7500 {
        return Err(invalid());
    }
    let mut unsigned = op.clone();
    unsigned.as_object_mut().unwrap().remove("sig");
    review_managed(&unsigned, v)?;
    crypto::verify(
        v["recovery"]["publicDidKey"].as_str().ok_or_else(invalid)?,
        &dag(&unsigned)?,
        &codec::decode_base64(op["sig"].as_str().ok_or_else(invalid)?)?,
    )?;
    let did = format!(
        "did:plc:{}",
        &data_encoding::BASE32_NOPAD
            .encode(&Sha256::digest(&encoded))
            .to_lowercase()[..24]
    );
    if v["did"] != did {
        return Err(Error::client("Recovery package identity mismatch"));
    }
    vault::verified(v, secret, None)?;
    Ok(v.clone())
}

pub fn identity(operation: &Value) -> Result<(String, String), Error> {
    let bytes = dag(operation)?;
    if bytes.len() > 7500 {
        return Err(invalid());
    }
    let digest = Sha256::digest(bytes);
    let base = data_encoding::BASE32_NOPAD.encode(&digest).to_lowercase();
    let mut cid = vec![1, 0x71, 0x12, 0x20];
    cid.extend_from_slice(&digest);
    Ok((
        format!("did:plc:{}", &base[..24]),
        format!(
            "b{}",
            data_encoding::BASE32_NOPAD.encode(&cid).to_lowercase()
        ),
    ))
}

pub fn document(value: &Value) -> Result<Value, Error> {
    let mut result = serde_json::Map::new();
    for field in [
        "did",
        "rotationKeys",
        "verificationMethods",
        "alsoKnownAs",
        "services",
    ] {
        result.insert(field.into(), value.get(field).ok_or_else(invalid)?.clone());
    }
    let result = Value::Object(result);
    if !result["did"].is_string() {
        return Err(invalid());
    }
    common(&result)?;
    Ok(result)
}
fn common(value: &Value) -> Result<(), Error> {
    for field in ["rotationKeys", "alsoKnownAs"] {
        if !value[field]
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string))
        {
            return Err(invalid());
        }
    }
    if !value["verificationMethods"]
        .as_object()
        .is_some_and(|o| o.values().all(Value::is_string))
    {
        return Err(invalid());
    }
    for service in value["services"].as_object().ok_or_else(invalid)?.values() {
        vault::exact(service, &["type", "endpoint"])?;
        if !service["type"].is_string() || !service["endpoint"].is_string() {
            return Err(invalid());
        }
    }
    Ok(())
}
pub fn operation(value: &Value) -> Result<(), Error> {
    vault::exact(
        value,
        &[
            "type",
            "rotationKeys",
            "verificationMethods",
            "alsoKnownAs",
            "services",
            "prev",
        ],
    )?;
    if value["type"] != "plc_operation" || !value["prev"].is_null() && !value["prev"].is_string() {
        return Err(invalid());
    }
    common(value)
}
pub fn with_digests(value: &Value, fields: &[&str]) -> Result<Vec<u8>, Error> {
    let mut payload = cbor::from_json(value)?;
    let cbor::Value::Map(ref mut entries) = payload else {
        return Err(invalid());
    };
    for field in fields {
        let entry = entries
            .iter_mut()
            .find(|(k, _)| *k == cbor::Value::Text((*field).into()))
            .ok_or_else(invalid)?;
        let bytes = codec::decode_base64(entry.1.text()?)?;
        if bytes.len() != 32 {
            return Err(invalid());
        }
        entry.1 = cbor::Value::Bytes(bytes);
    }
    cbor::encode(&payload, Limits::payload(262144), false)
}
pub fn decoded(bytes: &[u8], limit: usize) -> Result<Value, Error> {
    Ok(cbor::decode(bytes, Limits::payload(limit), false)?.diagnostic())
}
