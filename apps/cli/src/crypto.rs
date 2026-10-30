use crate::contract::Error;
use ed25519_dalek::{Signer, Verifier};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

pub fn random<const N: usize>() -> Result<Zeroizing<[u8; N]>, Error> {
    let mut bytes = Zeroizing::new([0; N]);
    OsRng
        .try_fill_bytes(bytes.as_mut())
        .map_err(|_| Error::client("Secure random generation failed"))?;
    Ok(bytes)
}
pub fn ed_did(key: &ed25519_dalek::VerifyingKey) -> String {
    did(&[0xed, 1], key.as_bytes())
}
pub fn p256_did(key: &p256::SecretKey) -> String {
    did(
        &[0x80, 0x24],
        key.public_key().to_encoded_point(true).as_bytes(),
    )
}
fn did(prefix: &[u8], bytes: &[u8]) -> String {
    let mut raw = prefix.to_vec();
    raw.extend_from_slice(bytes);
    format!("did:key:z{}", bs58::encode(raw).into_string())
}
pub fn did_bytes(key: &str) -> Result<Vec<u8>, Error> {
    let value = key
        .strip_prefix("did:key:z")
        .filter(|s| !s.is_empty() && s.len() <= 248)
        .ok_or_else(|| Error::client("Invalid public did:key"))?;
    bs58::decode(value)
        .into_vec()
        .map_err(|_| Error::client("Invalid public did:key"))
}
pub fn ed_public(key: &str) -> Result<ed25519_dalek::VerifyingKey, Error> {
    let raw = did_bytes(key)?;
    if raw.len() != 34 || raw[..2] != [0xed, 1] {
        return Err(Error::client("Expected an Ed25519 public key"));
    }
    ed25519_dalek::VerifyingKey::from_bytes(raw[2..].try_into().unwrap())
        .map_err(|_| Error::client("Invalid Ed25519 public key"))
}
pub fn rotation_key(key: &str) -> Result<(), Error> {
    let raw = did_bytes(key)?;
    match raw.get(..2) {
        Some([0x80, 0x24]) => {
            p256::PublicKey::from_sec1_bytes(&raw[2..])
                .map_err(|_| Error::client("Invalid P-256 public key"))?;
        }
        Some([0xe7, 1]) => {
            k256::PublicKey::from_sec1_bytes(&raw[2..])
                .map_err(|_| Error::client("Invalid secp256k1 public key"))?;
        }
        _ => return Err(Error::client("Unsupported PLC rotation key")),
    }
    Ok(())
}
pub fn verify(key: &str, input: &[u8], signature: &[u8]) -> Result<(), Error> {
    let raw = did_bytes(key)?;
    let invalid = || Error::client("Signature verification failed");
    match raw.get(..2) {
        Some([0xed, 1]) => ed_public(key)?
            .verify_strict(
                input,
                &ed25519_dalek::Signature::from_slice(signature).map_err(|_| invalid())?,
            )
            .map_err(|_| invalid()),
        Some([0x80, 0x24]) => {
            let key =
                p256::ecdsa::VerifyingKey::from_sec1_bytes(&raw[2..]).map_err(|_| invalid())?;
            let sig = p256::ecdsa::Signature::from_slice(signature).map_err(|_| invalid())?;
            if sig.normalize_s().is_some() {
                return Err(invalid());
            }
            key.verify(input, &sig).map_err(|_| invalid())
        }
        Some([0xe7, 1]) => {
            let key =
                k256::ecdsa::VerifyingKey::from_sec1_bytes(&raw[2..]).map_err(|_| invalid())?;
            let sig = k256::ecdsa::Signature::from_slice(signature).map_err(|_| invalid())?;
            key.verify(input, &sig).map_err(|_| invalid())
        }
        _ => Err(invalid()),
    }
}
pub fn sign_recovery(key: &p256::SecretKey, input: &[u8]) -> [u8; 64] {
    let signer = p256::ecdsa::SigningKey::from(key);
    let sig: p256::ecdsa::Signature = signer.sign(input);
    sig.normalize_s().unwrap_or(sig).to_bytes().into()
}
