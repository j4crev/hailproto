use crate::{
    api::Client,
    cli::Args,
    contract::{DID, Error, ID},
    messages, private, reads,
};
use serde_json::{Value, json};

fn invalid() -> Error {
    Error::client("Conversation retry changed operation, account, source, audience or content")
}

pub async fn run(client: &Client, args: &Args) -> Result<Value, Error> {
    let opt = |key: &str| args.options.get(key).map(String::as_str);
    let positional = |n: usize| reads::component(&args.positionals[n]);
    match args.command.as_str() {
        "conversation start" | "conversation reply-all" | "conversation revive" => {
            submit(client, args).await
        }
        "conversation status" | "conversation cancel" => {
            let path = format!("/connection-messages/{}", positional(0));
            let result = if args.command == "conversation cancel" {
                client.post(&format!("{path}/cancel"), &json!({})).await?
            } else {
                client.get(&path).await?
            };
            batch(result, &args.positionals[0])
        }
        "conversation messages" => {
            let query = opt("offset").map_or(String::new(), |v| format!("?offset={v}"));
            client
                .get(&format!(
                    "/connection-threads/{}/{}{query}",
                    positional(0),
                    positional(1)
                ))
                .await
        }
        "conversation inbox" | "sent list" => {
            let query = if let Some(after) = opt("after") {
                if !reads::cursor(
                    if args.command == "sent list" {
                        "grants"
                    } else {
                        "inbox"
                    },
                    after,
                ) {
                    return Err(Error::usage("Invalid continuation cursor"));
                }
                format!("?{}", reads::query(&[("after", after)]))
            } else {
                String::new()
            };
            let path = if args.command == "sent list" {
                "/sent"
            } else {
                "/connection-inbox"
            };
            client.get(&format!("{path}{query}")).await
        }
        "sent show" => client.get(&format!("/sent/{}", positional(0))).await,
        "conversation preferences show" => {
            client
                .get("/connections/cli-conversation-preferences")
                .await
        }
        "conversation preferences set" => {
            let allowed = match opt("allow").unwrap() {
                "true" => json!(true),
                "false" => json!(false),
                _ => Value::Null,
            };
            let request = if let Some(connection) = opt("connection") {
                json!({"connectionId":connection,"epoch":args.options["epoch"].parse::<u64>().unwrap(),"override":allowed})
            } else {
                json!({"allowIntroductions":allowed})
            };
            client
                .post("/connections/cli-conversation-preferences", &request)
                .await
        }
        _ => {
            client
                .post(
                    "/connections/cli-conversation-membership",
                    &json!({
                        "creator":args.positionals[0],"conversationId":args.positionals[1],
                        "action":args.command.split_whitespace().nth(1).unwrap()
                    }),
                )
                .await
        }
    }
}

async fn submit(client: &Client, args: &Args) -> Result<Value, Error> {
    let state_path = &args.options["state"];
    let account = client.account().await?;
    if !account["migrationState"].is_null()
        || !account["scopes"]
            .as_array()
            .is_some_and(|s| s.iter().any(|v| v == "messages:write"))
    {
        return Err(Error::client("Account cannot send or revive conversations"));
    }
    let saved: Option<Value> = match std::fs::metadata(state_path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        _ => Some(
            serde_json::from_slice(&private::read(
                state_path,
                messages::MESSAGE_STATE_MAX_BYTES,
            )?)
            .map_err(|_| invalid())?,
        ),
    };
    let mut intent = json!({"command":args.command,"source":args.positionals});
    if args.command != "conversation revive" {
        intent["text"] = messages::read_text(&args.options["file"])?.into();
    }
    if args.command == "conversation start" {
        let mut ids = args.connections.clone();
        ids.sort();
        intent["connections"] = json!(ids);
    }
    let path = match args.command.as_str() {
        "conversation start" => "/connection-messages",
        "conversation reply-all" => "/connection-messages/reply-all",
        _ => "/connections/cli-conversation-revive",
    };
    let state = if let Some(state) = saved {
        if state["type"] != "hailp.conversation-operation"
            || state["version"] != 1
            || state["accountId"] != account["accountId"]
            || state["provider"] != account["provider"]
            || state["intent"] != intent
            || state["path"] != path
        {
            return Err(invalid());
        }
        state
    } else {
        let id = messages::new_id()?;
        let request = match args.command.as_str() {
            "conversation start" => {
                json!({"publicationId":id,"connections":intent["connections"],"text":intent["text"],"delivery":"shared"})
            }
            "conversation reply-all" => {
                let sender = &args.positionals[0];
                let message = &args.positionals[1];
                let source = client
                    .get(&if account["did"] == *sender {
                        format!("/sent/{message}")
                    } else {
                        format!("/inbox/{}/{message}", reads::component(sender))
                    })
                    .await?;
                let shared = &source["sharedConversation"];
                if !shared["creator"].as_str().is_some_and(|s| DID.is_match(s))
                    || !shared["conversationId"]
                        .as_str()
                        .is_some_and(|s| ID.is_match(s))
                {
                    return Err(Error::client(
                        "Reply all requires a shared-conversation source message",
                    ));
                }
                if shared["state"] != "active" {
                    return Err(Error::client(
                        "Participation is not active; rejoin a left conversation or request creator revival after expiry",
                    ));
                }
                json!({"publicationId":id,"creator":shared["creator"],"conversationId":shared["conversationId"],"sender":sender,"messageId":message,"text":intent["text"]})
            }
            _ => json!({"operationId":id,"conversationId":args.positionals[0]}),
        };
        let state = json!({"type":"hailp.conversation-operation","version":1,"accountId":account["accountId"],"provider":account["provider"],"path":path,"intent":intent,"request":request});
        private::create(state_path, state.to_string().as_bytes())?;
        state
    };
    let request = &state["request"];
    let id_key = if args.command == "conversation revive" {
        "operationId"
    } else {
        "publicationId"
    };
    let id = request[id_key]
        .as_str()
        .filter(|s| ID.is_match(s))
        .ok_or_else(invalid)?;
    // Validate retained requests against current intent, never submit arbitrary state-file fields.
    let expected = match args.command.as_str() {
        "conversation start" => {
            json!({"publicationId":id,"connections":intent["connections"],"text":intent["text"],"delivery":"shared"})
        }
        "conversation reply-all" => {
            if !request["creator"].as_str().is_some_and(|s| DID.is_match(s))
                || !request["conversationId"]
                    .as_str()
                    .is_some_and(|s| ID.is_match(s))
            {
                return Err(invalid());
            }
            json!({"publicationId":id,"creator":request["creator"],"conversationId":request["conversationId"],"sender":args.positionals[0],"messageId":args.positionals[1],"text":intent["text"]})
        }
        _ => json!({"operationId":id,"conversationId":args.positionals[0]}),
    };
    if *request != expected {
        return Err(invalid());
    }
    let result = client.post(path, request).await?;
    if args.command == "conversation revive" {
        // A fresh operation may resolve to the provider's retained batch inside its cooldown.
        if !result["operationId"]
            .as_str()
            .is_some_and(|s| crate::contract::UUID.is_match(s))
            || result["conversationId"] != args.positionals[0]
            || !result["targets"].as_array().is_some_and(|rows| {
                rows.len() <= 100
                    && rows.iter().all(|r| {
                        r["recipient"].as_str().is_some_and(|s| DID.is_match(s))
                            && r["outcome"].as_str().is_some_and(|s| {
                                matches!(
                                    s,
                                    "pending"
                                        | "renewed"
                                        | "active"
                                        | "left"
                                        | "denied"
                                        | "expired"
                                )
                            })
                    })
            })
        {
            return Err(Error::response("Invalid conversation revival result"));
        }
        Ok(result)
    } else {
        batch(result, id)
    }
}

fn batch(result: Value, id: &str) -> Result<Value, Error> {
    if result["publicationId"] != id
        || result["kind"] != "connections"
        || !result["state"]
            .as_str()
            .is_some_and(|s| matches!(s, "publishing" | "cancelling" | "cancelled" | "finished"))
        || !result["targets"].as_array().is_some_and(|rows| {
            rows.len() <= 100
                && result["total"].as_u64() == Some(rows.len() as u64)
                && rows.iter().all(|r| {
                    r["recipient"].as_str().is_some_and(|s| DID.is_match(s))
                        && r["messageId"].as_str().is_some_and(|s| ID.is_match(s))
                })
        })
    {
        return Err(Error::response("Invalid conversation batch result"));
    }
    Ok(result)
}
