use super::*;
use serde_json::Value as Json;
fn vectors() -> Json {
    serde_json::from_str(include_str!(
        "../../../../packages/hail-codec-ts/vectors/v0.json"
    ))
    .unwrap()
}
fn hex(value: &Json) -> Vec<u8> {
    let s = value.as_str().unwrap();
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}
fn supported(kind: &str) -> bool {
    matches!(
        kind,
        "hail.sender-profile"
            | "hail.address-binding"
            | "hail.grant"
            | "hail.connection-invitation"
            | "hail.connection-confirmation"
    )
}
#[test]
fn shared_signed_vectors_and_representation_digests() {
    let vectors = vectors();
    let mut count = 0;
    for vector in vectors["positive"].as_array().unwrap() {
        let kind = vector["type"].as_str().unwrap();
        if !supported(kind) {
            continue;
        }
        let bytes = hex(&vector["cose_sign1_hex"]);
        assert_eq!(
            inspect(kind, &bytes).unwrap(),
            vector["diagnostic"],
            "{}",
            vector["id"]
        );
        assert_eq!(digest(&bytes), vector["representation_sha256_base64url"]);
        count += 1;
    }
    assert_eq!(count, 5);
}
#[test]
fn shared_malformed_cbor_payload_and_cose_vectors() {
    let vectors = vectors();
    for vector in vectors["negative_cbor"].as_array().unwrap() {
        let mut limits = Limits::payload(262_144);
        if let Some(n) = vector["limits"]["maximum_byte_string_length"].as_u64() {
            limits.string = n as usize;
        }
        assert!(
            decode(&hex(&vector["hex"]), limits, false).is_err(),
            "{}",
            vector["id"]
        );
    }
    for vector in vectors["negative_payload"].as_array().unwrap() {
        let kind = vector["type"].as_str().unwrap();
        if !supported(kind) {
            continue;
        }
        assert!(
            decode(&hex(&vector["hex"]), Limits::payload(262_144), false)
                .and_then(|v| schema::validate(kind, &v))
                .is_err(),
            "{}",
            vector["id"]
        );
    }
    for vector in vectors["negative_cose"].as_array().unwrap() {
        let kind = vector["type"].as_str().unwrap();
        if !supported(kind) || vector["operation"] != "inspect" {
            continue;
        }
        assert!(
            inspect(kind, &hex(&vector["hex"])).is_err(),
            "{}",
            vector["id"]
        );
    }
}
#[test]
fn bounded_parser_never_panics_on_truncated_or_untrusted_input() {
    let vectors = vectors();
    for vector in vectors["positive"].as_array().unwrap() {
        let kind = vector["type"].as_str().unwrap();
        if !supported(kind) {
            continue;
        }
        let bytes = hex(&vector["cose_sign1_hex"]);
        for size in 0..bytes.len() {
            assert!(inspect(kind, &bytes[..size]).is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(inspect(kind, &trailing).is_err());
    }
    let mut deeply_nested = vec![0x81; 33];
    deeply_nested.push(0);
    assert!(decode(&deeply_nested, Limits::payload(262_144), false).is_err());
    for byte in 0..=255 {
        let _ = decode(&[byte; 64], Limits::payload(262_144), false);
    }
    for bad in ["AA=", "AB", "a", "++//"] {
        assert!(decode_base64(bad).is_err());
    }
}

#[test]
fn deterministic_signatures_match_shared_vectors_and_reject_tampering() {
    for vectors in [
        vectors(),
        serde_json::from_str::<Json>(include_str!(
            "../../../../packages/hail-codec-ts/vectors/connections-draft.json"
        ))
        .unwrap(),
    ] {
        for vector in vectors["positive"].as_array().unwrap() {
            let kind = vector["type"].as_str().unwrap();
            if !supported(kind) {
                continue;
            }
            let key = vectors["test_keys"]
                .as_array()
                .unwrap()
                .iter()
                .find(|k| k["key_id"] == vector["diagnostic"]["key_id"])
                .unwrap();
            let signer =
                ed25519_dalek::SigningKey::from_bytes(&hex(&key["seed_hex"]).try_into().unwrap());
            let payload = from_diagnostic(kind, &vector["diagnostic"]).unwrap();
            assert_eq!(
                cbor::encode(&payload, Limits::payload(262144), false).unwrap(),
                hex(&vector["payload_hex"])
            );
            let signed = sign(kind, &payload, &signer).unwrap();
            assert_eq!(signed, hex(&vector["cose_sign1_hex"]), "{}", vector["id"]);
            let parsed = parse(kind, &signed).unwrap();
            if vector["sig_structure_hex"].is_string() {
                assert_eq!(
                    signature_input(&parsed.protected, &parsed.payload_bytes).unwrap(),
                    hex(&vector["sig_structure_hex"])
                );
            }
            let public = crate::crypto::ed_did(&signer.verifying_key());
            assert_eq!(
                verify(kind, &signed, &public).unwrap(),
                vector["diagnostic"]
            );
            let other = ed25519_dalek::SigningKey::from_bytes(&[99; 32]);
            assert!(
                verify(
                    kind,
                    &signed,
                    &crate::crypto::ed_did(&other.verifying_key())
                )
                .is_err()
            );
            let mut corrupted = signed;
            *corrupted.last_mut().unwrap() ^= 1;
            assert!(verify(kind, &corrupted, &public).is_err());
        }
    }
}
