use crate::contract::Error;
use crate::{cli::Args, codec, crypto, plc, private, snapshots as snap, transfers as t, vault};
use ed25519_dalek::Signer;
use serde_json::{Value, json};
fn parse(bytes: &[u8]) -> Result<Value, Error> {
    let v: Value = serde_json::from_slice(bytes).map_err(|_| t::invalid())?;
    if !v.is_object() {
        return Err(t::invalid());
    }
    Ok(v)
}
fn operation(bytes: &[u8]) -> Result<Value, Error> {
    let v = parse(bytes)?;
    let mut unsigned = v.clone();
    unsigned
        .as_object_mut()
        .unwrap()
        .shift_remove("sig")
        .ok_or_else(t::invalid)?;
    plc::operation(&unsigned)?;
    t::text(&v["sig"])?;
    Ok(v)
}
fn operation_verify(op: &Value, key: &str) -> Result<(), Error> {
    let mut unsigned = op.clone();
    unsigned
        .as_object_mut()
        .ok_or_else(t::invalid)?
        .shift_remove("sig");
    plc::operation(&unsigned)?;
    crypto::verify(
        key,
        &plc::dag(&unsigned)?,
        &codec::decode_base64(t::text(&op["sig"])?)?,
    )
}
fn evidence(m: &Value) -> Result<(&Value, &Value), Error> {
    let old = m["tables"]["account_keys"]
        .as_array()
        .ok_or_else(t::invalid)?
        .iter()
        .find(|k| k["role"] == "plc-rotation")
        .ok_or_else(t::invalid)?;
    let evidence = m["tables"]["plc_operation_evidence"]
        .as_array()
        .and_then(|a| a.last())
        .ok_or_else(t::invalid)?;
    Ok((old, evidence))
}
fn prior(evidence: &Value) -> Result<Value, Error> {
    if let Some(s) = evidence["expected_state"].as_str() {
        parse(s.as_bytes())
    } else {
        Ok(evidence["expected_state"].clone())
    }
}
fn make_operation(
    current: &Value,
    prev: &Value,
    old: &Value,
    offer: &Value,
    destination: &Value,
    managed: bool,
) -> Result<Value, Error> {
    let keys = current["rotationKeys"].as_array().ok_or_else(t::invalid)?;
    let mut keys = keys
        .iter()
        .filter(|k| *k != old)
        .cloned()
        .collect::<Vec<_>>();
    keys.push(offer["destination_rotation_key"].clone());
    let mut methods = current["verificationMethods"].clone();
    if !methods.is_object() {
        return Err(t::invalid());
    }
    methods["hail-messaging"] = offer["destination_messaging_key"].clone();
    if managed {
        methods["hail-identity"] = offer["destination_identity_key"].clone();
    }
    let mut services = current["services"].clone();
    if !services.is_object() {
        return Err(t::invalid());
    }
    services["hail"] = json!({"type":"HailMessaging","endpoint":destination});
    let op = json!({"type":"plc_operation","prev":prev,"rotationKeys":keys,"verificationMethods":methods,"alsoKnownAs":current["alsoKnownAs"],"services":services});
    plc::operation(&op)?;
    Ok(op)
}
pub fn sign(args: &Args, managed: bool) -> Result<Value, Error> {
    let path = &args.options["state"];
    let snapshot_path = &args.options["snapshot"];
    let op_path = &args.options["operation"];
    let mut state = t::load(path)?;
    if !managed && (state["type"] != "hailp.account-transfer" || state["version"] != 1) {
        return Err(t::invalid());
    }
    let (grant, offer, selection, reservation) = snap::retained(&state, managed)?;
    let snapshot = snap::read(snapshot_path)?;
    let manifest = snap::verify(&snapshot, managed)?;
    snap::matches(&state, &manifest, &offer, managed)?;
    if managed {
        return sign_managed(args, state, snapshot, manifest, grant, offer, selection);
    }
    let consent_path = &args.options["consent"];
    let binding_path = &args.options["binding"];
    let review = json!({"snapshotDigest":snapshot["digest"],"consentPath":consent_path,"operationPath":op_path,"bindingPath":binding_path});
    if !state["cutover"].is_null() {
        for (k, v) in review.as_object().unwrap() {
            if state["cutover"][k] != *v {
                return Err(t::invalid());
            }
        }
    }
    if !state["cutover"]["operationCid"].is_null() {
        private::read(op_path, 16000)?;
        private::read(consent_path, 16384)?;
        private::read(binding_path, 16384)?;
    }
    if state["cutover"].is_null() {
        state["cutover"] = json!({});
    }
    for (k, v) in review.as_object().unwrap() {
        state["cutover"][k] = v.clone();
    }
    private::replace(path, &state)?;
    let secret = private::recovery_secret()?;
    let user = vault::unlock(
        parse(&private::read(&args.options["vault"], 16384)?)?,
        &secret,
    )?;
    if user.vault["did"].is_null() {
        return Err(t::invalid());
    }
    snap::warn(&manifest);
    let custody = &manifest["tables"]["portable_custody_evidence"][0];
    let (old, evidence) = evidence(&manifest)?;
    if manifest["did"] != user.vault["did"]
        || !matches!(
            custody["monitor_verification_mode"].as_str(),
            Some("poc-local" | "independent")
        )
        || custody["user_identity_public_key"] != user.vault["identity"]["publicDidKey"]
        || custody["user_recovery_public_key"] != user.vault["recovery"]["publicDidKey"]
    {
        return Err(t::invalid());
    }
    let prior = prior(evidence)?;
    if prior["rotationKeys"][0] != user.vault["recovery"]["publicDidKey"]
        || prior["verificationMethods"]["hail-identity"] != user.vault["identity"]["publicDidKey"]
        || prior["verificationMethods"]["hail-messaging"] != snapshot["sourceMessagingPublicKey"]
        || prior["services"]["hail"]["endpoint"] != manifest["sourceServiceBase"]
        || !prior["rotationKeys"]
            .as_array()
            .is_some_and(|a| a.contains(&old["public_key"]))
        || !prior["alsoKnownAs"].is_array()
    {
        return Err(t::invalid());
    }
    let unsigned = make_operation(
        &prior,
        &evidence["operation_cid"],
        &old["public_key"],
        &offer,
        &manifest["destinationServiceBase"],
        false,
    )?;
    let previous = private::optional_bytes(op_path, 16000)?;
    let consent = private::optional_bytes(consent_path, 16384)?;
    let binding = private::optional_bytes(binding_path, 16384)?;
    if previous.is_none() && (consent.is_some() || binding.is_some())
        || consent.is_none() && binding.is_some()
    {
        return Err(Error::client(
            "Retained cutover artifacts are incomplete; restore originals instead of signing replacements",
        ));
    }
    let op = if let Some(b) = previous {
        let op = operation(&b)?;
        let mut u = op.clone();
        u.as_object_mut().unwrap().shift_remove("sig");
        if u != unsigned {
            return Err(t::invalid());
        }
        operation_verify(&op, t::text(&user.vault["recovery"]["publicDidKey"])?)?;
        op
    } else {
        let mut op = unsigned;
        op["sig"] = snap::base64(&crypto::sign_recovery(&user.recovery, &plc::dag(&op)?)).into();
        plc::identity(&op)?;
        private::create(op_path, op.to_string().as_bytes())?;
        op
    };
    let (_, cid) = plc::identity(&op)?;
    let now = t::now();
    let expected = json!({"type":"hail.portable-migration-consent","version":1,"did":user.vault["did"],"transfer_id":manifest["transferId"],"snapshot_digest":snapshot["digest"],"plc_operation_sha256":codec::digest(&plc::dag(&op)?),"source_service_base":manifest["sourceServiceBase"],"destination_service_base":manifest["destinationServiceBase"],"destination_address":reservation["address"],"destination_rotation_key":manifest["destinationRotationPublicKey"],"destination_messaging_key":manifest["destinationMessagingPublicKey"],"user_recovery_key":user.vault["recovery"]["publicDidKey"],"user_identity_key":user.vault["identity"]["publicDidKey"],"created_at":now,"expires_at":now+3600});
    if let Some(bytes) = consent {
        let stored = parse(&bytes)?;
        if stored["type"] != "hail.portable-migration-consent" || stored["version"] != 1 {
            return Err(t::invalid());
        }
        let payload = codec::decode_base64(t::text(&stored["payload"])?)?;
        snap::signed(
            "hail.portable-migration-consent.v1",
            &payload,
            &codec::decode_base64(t::text(&stored["signature"])?)?,
            t::text(&user.vault["identity"]["publicDidKey"])?,
        )?;
        let mut value = plc::decoded(&payload, 262144)?;
        if t::integer(&value["expires_at"])? <= now {
            return Err(t::invalid());
        }
        value["created_at"] = now.into();
        value["expires_at"] = (now + 3600).into();
        if value != expected {
            return Err(t::invalid());
        }
    } else {
        let payload = plc::with_digests(&expected, &["snapshot_digest", "plc_operation_sha256"])?;
        let mut input = b"hail.portable-migration-consent.v1\0".to_vec();
        input.extend_from_slice(&payload);
        private::create(consent_path,json!({"type":"hail.portable-migration-consent","version":1,"payload":snap::base64(&payload),"signature":snap::base64(&user.identity.sign(&input).to_bytes())}).to_string().as_bytes())?;
    }
    if let Some(bytes) = binding {
        let p = codec::verify(
            "hail.address-binding",
            &bytes,
            t::text(&user.vault["identity"]["publicDidKey"])?,
        )?;
        if p["address"] != reservation["address"]
            || p["did"] != user.vault["did"]
        {
            return Err(t::invalid());
        }
    } else {
        let p = codec::from_diagnostic(
            "hail.address-binding",
            &json!({"type":"hail.address-binding","version":2,"address":reservation["address"],"did":user.vault["did"],"issued_at":now,"key_id":format!("{}#hail-identity",t::text(&user.vault["did"])?)}),
        )?;
        private::create(
            binding_path,
            &codec::sign("hail.address-binding", &p, &user.identity)?,
        )?;
    }
    if !state["cutover"]["operationCid"].is_null() && state["cutover"]["operationCid"] != cid {
        return Err(t::invalid());
    }
    state["cutover"]["operationCid"] = cid.clone().into();
    private::replace(path, &state)?;
    Ok(
        json!({"did":user.vault["did"],"transferId":manifest["transferId"],"address":reservation["address"],"operationCid":cid,"profile":if custody["monitor_verification_mode"]=="independent"{"public"}else{"private-poc"}}),
    )
}
fn sign_managed(
    args: &Args,
    mut state: Value,
    snapshot: Value,
    m: Value,
    grant: Value,
    offer: Value,
    selection: Value,
) -> Result<Value, Error> {
    let path = &args.options["state"];
    let sp = &args.options["snapshot"];
    let op_path = &args.options["operation"];
    let ap = &args.options["approval"];
    let result = |cid: &Value| json!({"did":state["did"],"transferId":offer["transfer_id"],"operationCid":cid,"operationFile":op_path,"approvalFile":ap,"stateFile":path});
    if !state["cutover"].is_null() {
        let c = &state["cutover"];
        if c["snapshotPath"] != *sp
            || c["operationPath"] != *op_path
            || c["approvalPath"] != *ap
            || c["snapshotDigest"] != snapshot["digest"]
        {
            return Err(t::invalid());
        }
        let op = operation(&private::read(op_path, 16000)?)?;
        let approval = t::verify(
            &parse(&private::read(ap, 16384)?)?,
            "hail.managed-transfer-approval",
            t::text(&state["ownerRecoveryKey"])?,
            true,
            true,
        )?;
        if plc::identity(&op)?.1 != c["operationCid"]
            || approval["operation_cid"] != c["operationCid"]
            || approval["snapshot_digest"] != snapshot["digest"]
        {
            return Err(t::invalid());
        }
        return Ok(result(&c["operationCid"]));
    }
    let custody = &m["tables"]["managed_custody_evidence"][0];
    let (old, evidence) = evidence(&m)?;
    if custody["owner_recovery_public_key"] != state["ownerRecoveryKey"]
        || custody["provider_identity_public_key"] != state["sourceIdentityKey"]
        || !matches!(
            custody["verification_mode"].as_str(),
            Some("poc-local" | "strict-public-v1")
        )
        || !evidence["operation_cid"].is_string()
        || !m["historyCheckpointDigest"].is_string()
        || t::integer(&m["sourceGeneration"])? < 1
    {
        return Err(t::invalid());
    }
    let current = plc::document(&prior(evidence)?)?;
    if current["verificationMethods"]["hail-identity"] != state["sourceIdentityKey"]
        || current["verificationMethods"]["hail-messaging"] != snapshot["sourceMessagingPublicKey"]
        || current["services"]["hail"]["endpoint"]
            != format!("{}/hail", t::text(&state["provider"])?)
    {
        return Err(t::invalid());
    }
    snap::warn(&m);
    let secret = private::recovery_secret()?;
    let user = vault::unlock(
        parse(&private::read(&args.options["vault"], 16384)?)?,
        &secret,
    )?;
    if user.vault["did"].is_null()
        || user.vault["did"] != state["did"]
        || user.vault["recovery"]["publicDidKey"] != state["ownerRecoveryKey"]
        || current["did"] != user.vault["did"]
        || current["rotationKeys"][0] != user.vault["recovery"]["publicDidKey"]
        || old["public_key"] == user.vault["recovery"]["publicDidKey"]
        || !current["rotationKeys"]
            .as_array()
            .is_some_and(|a| a.contains(&old["public_key"]))
    {
        return Err(t::invalid());
    }
    let keys = [
        "destination_rotation_key",
        "destination_identity_key",
        "destination_messaging_key",
    ]
    .map(|k| t::text(&offer[k]))
    .into_iter()
    .collect::<Result<Vec<_>, _>>()?;
    if keys.iter().collect::<std::collections::HashSet<_>>().len() != 3
        || keys.iter().any(|key| {
            current["rotationKeys"]
                .as_array()
                .unwrap()
                .iter()
                .any(|v| v == *key)
                || current["verificationMethods"]
                    .as_object()
                    .unwrap()
                    .values()
                    .any(|v| v == *key)
        })
    {
        return Err(t::invalid());
    }
    crypto::rotation_key(keys[0])?;
    crypto::ed_public(keys[1])?;
    crypto::ed_public(keys[2])?;
    plc::service_base(t::text(&m["destinationServiceBase"])?)?;
    let mut op = make_operation(
        &current,
        &evidence["operation_cid"],
        &old["public_key"],
        &offer,
        &m["destinationServiceBase"],
        true,
    )?;
    op["sig"] = snap::base64(&crypto::sign_recovery(&user.recovery, &plc::dag(&op)?)).into();
    let (_, cid) = plc::identity(&op)?;
    if op["rotationKeys"].as_array().unwrap().len() != 2
        || op["rotationKeys"][1] != offer["destination_rotation_key"]
        || cid == t::text(&evidence["operation_cid"])?
        || [
            t::text(&state["ownerRecoveryKey"])?,
            t::text(&state["sourceIdentityKey"])?,
            keys[0],
            keys[1],
            keys[2],
        ]
        .into_iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
            != 5
    {
        return Err(t::invalid());
    }
    let now = t::now();
    let approval = json!({"type":"hail.managed-transfer-approval","version":1,"did":state["did"],"nonce":grant["nonce"],"transfer_id":offer["transfer_id"],"source_service_base":m["sourceServiceBase"],"destination_service_base":m["destinationServiceBase"],"destination_address":selection["address"],"owner_recovery_key":state["ownerRecoveryKey"],"source_identity_key":state["sourceIdentityKey"],"destination_rotation_key":offer["destination_rotation_key"],"destination_identity_key":offer["destination_identity_key"],"destination_messaging_key":offer["destination_messaging_key"],"grant_digest":t::hash_wire(&state["grant"])?,"offer_digest":t::hash_wire(&state["offer"])?,"selection_digest":t::hash_wire(&state["selection"])?,"snapshot_version":m["version"],"snapshot_digest":snapshot["digest"],"history_checkpoint_digest":m["historyCheckpointDigest"],"source_generation":m["sourceGeneration"],"previous_operation_cid":evidence["operation_cid"],"operation_cid":cid,"issued_at":now,"expires_at":now+900});
    let bytes = plc::with_digests(
        &approval,
        &[
            "grant_digest",
            "offer_digest",
            "selection_digest",
            "snapshot_digest",
            "history_checkpoint_digest",
        ],
    )?;
    let mut input = b"hail.managed-transfer-approval.v1\0".to_vec();
    input.extend_from_slice(&bytes);
    private::create(op_path, op.to_string().as_bytes())?;
    private::create(ap,json!({"payload":snap::base64(&bytes),"signature":snap::base64(&crypto::sign_recovery(&user.recovery,&input))}).to_string().as_bytes())?;
    let result = result(&json!(cid));
    state["cutover"] = json!({"snapshotDigest":snapshot["digest"],"snapshotPath":sp,"operationPath":op_path,"approvalPath":ap,"operationCid":cid});
    private::replace(path, &state)?;
    Ok(result)
}
fn check_digests(bytes: &[u8], fields: &[&str]) -> Result<(), Error> {
    let payload = codec::cbor::decode(bytes, codec::cbor::Limits::payload(262144), false)?;
    for field in fields {
        if payload.field(field).bytes()?.len() != 32 {
            return Err(t::invalid());
        }
    }
    Ok(())
}
pub async fn complete(args: &Args, managed: bool) -> Result<Value, Error> {
    let path = &args.options["state"];
    let sp = &args.options["snapshot"];
    let mut state = t::load(path)?;
    let c = state["cutover"].clone();
    if c.is_null()
        || managed && c["snapshotPath"] != *sp
        || !managed
            && (state["type"] != "hailp.account-transfer"
                || state["version"] != 1
                || !c["operationCid"].is_string())
    {
        return Err(t::invalid());
    }
    let (_, offer, _, reservation) = snap::retained(&state, managed)?;
    let snapshot = snap::read(sp)?;
    let manifest = snap::verify(&snapshot, managed)?;
    snap::matches(&state, &manifest, &offer, managed)?;
    if snapshot["digest"] != c["snapshotDigest"] {
        return Err(t::invalid());
    }
    let op_bytes = private::read(t::text(&c["operationPath"])?, 16000)?;
    let op = operation(&op_bytes)?;
    let (_, cid) = plc::identity(&op)?;
    if cid != c["operationCid"] {
        return Err(t::invalid());
    }
    let public = managed
        && manifest["tables"]["managed_custody_evidence"][0]["verification_mode"]
            == "strict-public-v1";
    let monitor = args.options.get("monitor-attestation");
    if managed && !public && monitor.is_some() {
        return Err(t::invalid());
    }
    let mut body = json!({"snapshot":snapshot,"operation":snap::base64(&op_bytes)});
    let mut binding = None;
    if managed {
        let approval = parse(&private::read(t::text(&c["approvalPath"])?, 16384)?)?;
        t::wire(&approval, true)?;
        body["approval"] = approval;
    } else {
        let bytes = private::read(t::text(&c["bindingPath"])?, 16384)?;
        let container = parse(&private::read(t::text(&c["consentPath"])?, 16384)?)?;
        if container["type"] != "hail.portable-migration-consent" || container["version"] != 1 {
            return Err(t::invalid());
        }
        let consent = json!({"payload":container["payload"],"signature":container["signature"]});
        let (payload, signature) = t::wire(&consent, false)?;
        snap::signed(
            "hail.portable-migration-consent.v1",
            &payload,
            &signature,
            t::text(&state["key"])?,
        )?;
        let v = plc::decoded(&payload, 262144)?;
        check_digests(&payload, &["snapshot_digest", "plc_operation_sha256"])?;
        let custody = &manifest["tables"]["portable_custody_evidence"][0];
        if v["type"] != "hail.portable-migration-consent"
            || v["version"] != 1
            || v["did"] != state["did"]
            || v["transfer_id"] != offer["transfer_id"]
            || v["source_service_base"] != format!("{}/hail", t::text(&state["provider"])?)
            || v["destination_service_base"] != format!("{}/hail", t::text(&state["destination"])?)
            || v["destination_address"] != reservation["address"]
            || v["destination_rotation_key"] != offer["destination_rotation_key"]
            || v["destination_messaging_key"] != offer["destination_messaging_key"]
            || v["user_identity_key"] != state["key"]
            || v["user_recovery_key"] != custody["user_recovery_public_key"]
            || v["snapshot_digest"] != snapshot["digest"]
            || v["plc_operation_sha256"] != codec::digest(&plc::dag(&op)?)
            || t::integer(&v["expires_at"])? <= t::integer(&v["created_at"])?
            || t::integer(&v["expires_at"])? - t::integer(&v["created_at"])? > 604800
        {
            return Err(t::invalid());
        }
        body["consent"] = consent;
        body["binding"] = snap::base64(&bytes).into();
        binding = Some(bytes);
    }
    if let Some(path) = monitor {
        let wire = parse(&private::read(path, 16384)?)?;
        t::wire(&wire, managed)?;
        body["monitor"] = wire;
    }
    let (_, result) = t::target(
        t::text(&state["destination"])?,
        if managed {
            "managed-completions"
        } else {
            "completions"
        },
        &body,
    )
    .await?;
    let phase = t::text(&result["phase"])?;
    if result["type"]
        != if managed {
            "hailp.managed-transfer-completion"
        } else {
            "hailp.transfer-completion"
        }
        || result["version"] != 1
        || result["did"] != state["did"]
        || result["accountId"] != state["accountId"]
        || result["transferId"] != offer["transfer_id"]
        || result["operationCid"] != cid
        || !matches!(
            phase,
            "active" | "awaiting-connection-handover" | "awaiting-monitor"
        )
        || managed && !public && phase == "awaiting-monitor"
    {
        return Err(t::invalid());
    }
    if phase != "active" {
        let mut result = json!({"did":state["did"],"transferId":offer["transfer_id"],"operationCid":cid,"phase":phase,"pending":true,"stateFile":path});
        result[if phase == "awaiting-monitor" {
            "monitorRequired"
        } else {
            "handoverRequired"
        }] = true.into();
        return Ok(result);
    }
    if managed
        && t::integer(&result["generation"])? != t::integer(&manifest["sourceGeneration"])? + 1
    {
        return Err(t::invalid());
    }
    let receipt = &result["receipt"];
    let (bytes, sig) = t::wire(receipt, managed)?;
    snap::signed(
        "hail.portable-migration-activated.v1",
        &bytes,
        &sig,
        t::text(&offer["destination_messaging_key"])?,
    )?;
    let activated = plc::decoded(&bytes, 262144)?;
    check_digests(&bytes, &["snapshot_digest"])?;
    if activated["did"] != state["did"]
        || activated["transfer_id"] != offer["transfer_id"]
        || activated["destination_service_base"]
            != format!("{}/hail", t::text(&state["destination"])?)
        || activated["destination_messaging_key"] != offer["destination_messaging_key"]
        || activated["destination_address"] != reservation["address"]
        || activated["snapshot_digest"] != snapshot["digest"]
    {
        return Err(t::invalid());
    }
    if !managed {
        check_digests(&bytes, &["address_binding_digest"])?;
        if activated["type"] != "hail.portable-migration-activated"
            || activated["version"] != 1
            || activated.as_object().is_none_or(|o| o.len() != 10)
            || activated["address_binding_digest"] != codec::digest(binding.as_ref().unwrap())
            || t::integer(&activated["activated_at"])? > t::now() + 300
        {
            return Err(t::invalid());
        }
    }
    if !state["activationReceipt"].is_null() && state["activationReceipt"] != *receipt {
        return Err(t::invalid());
    }
    state["activationReceipt"] = receipt.clone();
    private::replace(path, &state)?;
    t::target(
        t::text(&state["provider"])?,
        if managed {
            "managed-retirements"
        } else {
            "retirements"
        },
        receipt,
    )
    .await
    .map_err(|_| {
        Error::client(
            "Destination active; source retirement is unconfirmed. Retry the exact transfer state",
        )
    })?;
    state["retired"] = true.into();
    private::replace(path, &state)?;
    let mut r = json!({"did":state["did"],"transferId":offer["transfer_id"],"destination":state["destination"],"address":reservation["address"],"destinationActive":true,"sourceRetired":true,"credentials":if managed{"destination owner-recovery login required"}else{"destination owner login required"},"stateFile":path});
    if managed {
        r["generation"] = result["generation"].clone();
    } else {
        r["operationCid"] = cid.into();
    }
    Ok(r)
}
