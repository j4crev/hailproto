use crate::{
    api::Client,
    cli::Args,
    contract::{DID, Error},
    crypto, private,
};
use serde_json::{Value, json};
use std::io::Read;
fn invalid() -> Error {
    Error::client("Message retry changed account or content")
}
pub async fn send(client: &Client, args: &Args) -> Result<Value, Error> {
    let opt = |key: &str| args.options.get(key).map(String::as_str);
    let path = opt("file").unwrap();
    let state_path = opt("state").unwrap();
    let file =
        std::fs::File::open(path).map_err(|_| Error::client("Cannot read message text file"))?;
    let metadata = file.metadata().map_err(|_| invalid())?;
    if !metadata.is_file() || metadata.len() > 65536 {
        return Err(Error::client("Message text file must be at most 64 KiB"));
    }
    let mut text = String::new();
    file.take(65537)
        .read_to_string(&mut text)
        .map_err(|_| Error::client("Message text must be UTF-8"))?;
    if text.len() > 65536 {
        return Err(Error::client("Message text file must be at most 64 KiB"));
    }
    let account = client.account().await?;
    if !account["migrationState"].is_null()
        || !account["scopes"]
            .as_array()
            .is_some_and(|s| s.iter().any(|s| s == "messages:write"))
    {
        return Err(Error::client("Account cannot send messages"));
    }
    let state = match std::fs::metadata(state_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        _ => Some(
            serde_json::from_slice::<Value>(&private::read(state_path, 524288)?)
                .map_err(|_| invalid())?,
        ),
    };
    let mut request = json!({"text":text});
    if args.command == "connection send" {
        let id = &args.positionals[0];
        let (epoch, did) = if let Some(s) = &state {
            (
                s["request"]["connectionEpoch"].clone(),
                s["request"]["recipientDid"].clone(),
            )
        } else {
            let list = client.get("/connections/cli-list").await?;
            let rows = list["connections"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .filter(|r| r["id"] == *id)
                .collect::<Vec<_>>();
            if rows.len() != 1 {
                return Err(Error::client(
                    "Selected connection is not active on this account",
                ));
            }
            (rows[0]["epoch"].clone(), rows[0]["did"].clone())
        };
        if !epoch
            .as_u64()
            .is_some_and(|n| (1..=9_007_199_254_740_991).contains(&n))
            || !did.as_str().is_some_and(|s| DID.is_match(s))
        {
            return Err(Error::client(
                "Connection must identify one peer and a current epoch",
            ));
        }
        request["connectionId"] = id.clone().into();
        request["connectionEpoch"] = epoch;
        request["recipientDid"] = did;
    } else if args.command == "send" {
        request["grantId"] = opt("grant").unwrap().into();
        request["category"] = args
            .categories
            .first()
            .map(String::as_str)
            .unwrap_or("")
            .into();
    } else {
        request["replyTo"] = args.positionals[0].clone().into();
    }
    if let Some(value) = opt("reply-until") {
        request["replyUntil"] = json!(value.parse::<u64>().map_err(|_| invalid())?);
    }
    let state = if let Some(state) = state {
        state
    } else {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let random = crypto::random::<16>()?;
        let mut bytes = *random;
        bytes[..6].copy_from_slice(&(now as u64).to_be_bytes()[2..]);
        bytes[6] = 0x70 | (bytes[6] & 15);
        bytes[8] = 0x80 | (bytes[8] & 63);
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let id = format!(
            "{}-{}-{}-{}-{}",
            &hex[..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..]
        );
        let mut saved = json!({"messageId":id});
        for (k, v) in request.as_object().unwrap() {
            saved[k] = v.clone();
        }
        let state = json!({"accountId":account["accountId"],"provider":account["provider"],"request":saved});
        private::create(state_path, state.to_string().as_bytes())?;
        state
    };
    let mut saved = state["request"].clone();
    if !saved["messageId"].is_string() {
        return Err(invalid());
    }
    saved
        .as_object_mut()
        .ok_or_else(invalid)?
        .shift_remove("messageId");
    if state["accountId"] != account["accountId"]
        || state["provider"] != account["provider"]
        || saved != request
    {
        return Err(invalid());
    }
    client.post("/messages", &state["request"]).await
}
