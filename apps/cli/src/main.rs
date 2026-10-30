mod account_access;
mod account_create;
mod api;
mod binding;
mod browser_login;
mod cli;
mod codec;
mod connection_signing;
mod connections;
mod contract;
mod credentials;
mod crypto;
mod custody;
mod cutover;
mod doctor;
mod grants;
mod messages;
mod plc;
mod poll;
mod private;
mod profiles;
mod reads;
mod signed_reads;
mod snapshots;
mod transfers;
mod vault;

use contract::Error;
use serde_json::Value;

async fn run() -> Result<(), Error> {
    let args = cli::parse(std::env::args().skip(1))?;
    if args.version {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    if args.help {
        println!("{}", cli::help(&args.command));
        return Ok(());
    }
    if args.command.starts_with("vault ") {
        let mut result = vault::run(&args)?;
        result["cliContractVersion"] = 1.into();
        println!("{}", contract::redact(&result.to_string()));
        return Ok(());
    }
    if args.command == "connection sign" {
        let mut result = connection_signing::sign(&args)?;
        result["cliContractVersion"] = 1.into();
        println!("{}", contract::redact(&result.to_string()));
        return Ok(());
    }
    if matches!(
        args.command.as_str(),
        "account login" | "account passkey-recover" | "account browser-login" | "account create"
    ) {
        let mut result = if args.command == "account create" {
            account_create::run(&args).await?
        } else if args.command == "account browser-login" {
            browser_login::run(&args).await?
        } else {
            account_access::run(&args).await?
        };
        result["cliContractVersion"] = 1.into();
        println!("{}", contract::redact(&result.to_string()));
        return Ok(());
    }
    if args.command.ends_with("sign-cutover")
        || matches!(
            args.command.as_str(),
            "account transfer complete" | "account managed-transfer complete"
        )
    {
        let managed = args.command.contains("managed-transfer");
        let mut result = if args.command.ends_with("sign-cutover") {
            cutover::sign(&args, managed)?
        } else {
            cutover::complete(&args, managed).await?
        };
        result["cliContractVersion"] = 1.into();
        println!("{}", contract::redact(&result.to_string()));
        return Ok(());
    }
    let path = args
        .options
        .get("credentials")
        .cloned()
        .or_else(|| std::env::var("HAILP_CREDENTIAL_FILE").ok())
        .filter(|p| !p.is_empty());
    let inspect_account = path.is_some();
    let client = if let Some(path) = &path {
        api::Client::new(api::Credential::load(
            path,
            args.options.get("provider"),
            args.options.get("account-id"),
        )?)?
    } else if args.command == "doctor" {
        let provider = args
            .options
            .get("provider")
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::client("Doctor requires --provider or a selected credential"))?;
        api::Client::public(provider)?
    } else {
        return Err(Error::client("Set --credentials or HAILP_CREDENTIAL_FILE"));
    };
    let option = |key: &str| args.options.get(key).map(String::as_str);
    let interval = cli::bounded(args.options.get("interval"), "interval", 30, 2)?;
    let mut result = match args.command.as_str() {
        "credential create" => {
            credentials::create(
                &client,
                option("output").unwrap(),
                if args.scopes.is_empty() {
                    None
                } else {
                    Some(&args.scopes)
                },
            )
            .await?
        }
        "credential rotate" => {
            credentials::rotate(path.as_deref().unwrap(), option("output").unwrap()).await?
        }
        "credential revoke" => {
            client
                .post(
                    "/credentials",
                    &serde_json::json!({"revoke":args.positionals[0]}),
                )
                .await?
        }
        "conversation mark-read"
        | "conversation mark-unread"
        | "conversation trash"
        | "conversation restore" => {
            client
                .post(
                    &format!(
                        "/conversations/{}/{}",
                        reads::component(&args.positionals[0]),
                        args.command.split_whitespace().nth(1).unwrap()
                    ),
                    &serde_json::json!({}),
                )
                .await?
        }
        "connection revoke-invitation" | "connection remove" => {
            client
                .post(
                    if args.command == "connection remove" {
                        "/connections/cli-remove"
                    } else {
                        "/connections/cli-revoke-invitation"
                    },
                    &serde_json::json!({"connectionId":args.positionals[0]}),
                )
                .await?
        }
        "inbox delete" | "message delete" => {
            client
                .post(
                    &format!(
                        "/inbox/{}/{}/permanent-delete",
                        reads::component(&args.positionals[0]),
                        reads::component(&args.positionals[1])
                    ),
                    &serde_json::json!({}),
                )
                .await?
        }
        "message submit" => {
            client
                .post(
                    &format!(
                        "/messages/{}/submit",
                        reads::component(&args.positionals[0])
                    ),
                    &serde_json::json!({}),
                )
                .await?
        }
        "send" | "reply" | "connection send" => messages::send(&client, &args).await?,
        "profile create" | "profile update" => {
            profiles::save(
                &client,
                option("file").unwrap(),
                args.command == "profile update",
            )
            .await?
        }
        "account custody managed" | "account custody owner-controlled" => {
            custody::run(&client, &args).await?
        }
        "account transfer status" | "account managed-transfer status" => {
            transfers::status(&client, args.command.contains("managed-transfer")).await?
        }
        "account transfer offer" | "account managed-transfer offer" => {
            transfers::offer(&client, &args, args.command.contains("managed-transfer")).await?
        }
        "account transfer select" | "account managed-transfer select" => {
            transfers::select(&client, &args, args.command.contains("managed-transfer")).await?
        }
        "account transfer export" | "account managed-transfer export" => {
            snapshots::export(&client, &args, args.command.contains("managed-transfer")).await?
        }
        "account transfer cancel" => transfers::cancel(&client, &args).await?,
        "account show" => client.account().await?,
        "profile show" => signed_reads::profile(&client).await?,
        "binding renew" => binding::renew(&client, &args).await?,
        "grant create" => grants::create(&client, &args).await?,
        "grant update" => grants::update(&client, &args).await?,
        "grant revoke" => grants::revoke(&client, &args).await?,
        "grant submit" => {
            grants::submit(&client, &private::read(&args.positionals[0], 262144)?).await?
        }
        "binding show" => signed_reads::binding(&client).await?,
        "grant show" => {
            signed_reads::grant(&client, &args.positionals[0], args.options.get("output")).await?
        }
        "doctor" => {
            doctor::doctor(
                &client,
                &args.scopes,
                inspect_account,
                args.options.get("action"),
            )
            .await?
        }
        "connection invite" | "connection accept" | "connection status" => {
            connections::run(&client, &args).await?
        }
        "connection list" => client.get("/connections/cli-list").await?,
        "connection invitations" => client.get("/connections/cli-invitations").await?,
        "inbox list" | "grant list" | "credential list" => {
            let kind = match args.command.as_str() {
                "inbox list" => "inbox",
                "grant list" => "grants",
                _ => "credentials",
            };
            reads::list_pages(kind, option("after"), args.pages, async |path| {
                client.get(path).await
            })
            .await?
        }
        "inbox show" => {
            client
                .get(&format!(
                    "/inbox/{}/{}",
                    reads::component(&args.positionals[0]),
                    reads::component(&args.positionals[1])
                ))
                .await?
        }
        "conversation thread" => {
            client
                .get(&format!(
                    "/threads/{}/{}",
                    reads::component(&args.positionals[0]),
                    reads::component(&args.positionals[1])
                ))
                .await?
        }
        "conversation list" | "conversation show" => {
            let suffix = args
                .positionals
                .first()
                .map(|s| format!("/{}", reads::component(s)))
                .unwrap_or_default();
            let mut pairs = Vec::new();
            if let Some(after) = option("after").filter(|s| !s.is_empty()) {
                pairs.push(("after", after));
            }
            if args.options.contains_key("trash") {
                pairs.push(("trash", "true"));
            }
            client
                .get(&format!("/conversations{suffix}?{}", reads::query(&pairs)))
                .await?
        }
        "message status" => {
            let seconds = args
                .options
                .get("wait")
                .map(|v| cli::bounded(Some(v), "wait", 300, 1))
                .transpose()?;
            poll::status(&client, &args.positionals[0], seconds, interval).await?
        }
        "inbox wait" => {
            poll::inbox(
                &client,
                option("from"),
                option("after"),
                cli::bounded(args.options.get("timeout"), "timeout", 300, 60)?,
                interval,
            )
            .await?
        }
        _ => unreachable!("parser accepts only implemented commands"),
    };
    result["cliContractVersion"] = Value::from(1);
    println!("{}", contract::redact(&result.to_string()));
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{}", contract::redact(&error.json().to_string()));
        std::process::exit(1);
    }
}
