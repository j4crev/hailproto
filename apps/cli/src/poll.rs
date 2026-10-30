use crate::{
    api::Client,
    contract::{DID, Error, ID},
    reads::cursor,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::time::{Instant, sleep, timeout_at};

fn retry_delay(error: &Error, interval: u64) -> Option<Duration> {
    matches!(error.status, Some(429 | 503))
        .then(|| Duration::from_secs(interval.max(error.retry_after.unwrap_or(interval))))
}

fn validate_status(result: &Value, id: &str) -> Result<(), Error> {
    let revision = result["revision"].as_f64();
    if result["messageId"] != id
        || !result["state"].as_str().is_some_and(|s| {
            [
                "indeterminate",
                "accepted",
                "on-hold",
                "delivered",
                "failed",
                "cancelled",
            ]
            .contains(&s)
        })
        || if result["state"] == "indeterminate" {
            result.get("revision") != Some(&Value::Null)
        } else {
            !revision
                .is_some_and(|n| (1.0..=9_007_199_254_740_991.0).contains(&n) && n.fract() == 0.0)
        }
    {
        return Err(Error::response("Provider returned invalid message status"));
    }
    Ok(())
}

pub async fn status(
    client: &Client,
    id: &str,
    seconds: Option<u64>,
    interval: u64,
) -> Result<Value, Error> {
    if !ID.is_match(id) {
        return Err(Error::usage("Invalid message ID or wait bounds"));
    }
    let path = format!("/messages/{id}");
    let Some(seconds) = seconds else {
        let result = client.get(&path).await?;
        validate_status(&result, id)?;
        return Ok(result);
    };
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut last = None;
    let mut failure = None;
    while Instant::now() < deadline {
        let mut delay = Duration::from_secs(interval);
        match timeout_at(deadline, client.get(&path)).await {
            Err(_) => {
                failure = Some(Error::transport());
                break;
            }
            Ok(Ok(mut result)) => {
                validate_status(&result, id)?;
                if matches!(
                    result["state"].as_str(),
                    Some("delivered" | "failed" | "cancelled")
                ) {
                    result["wait"] = json!({"completed":true,"timedOut":false});
                    return Ok(result);
                }
                last = Some(result);
            }
            Ok(Err(error)) => {
                delay = match retry_delay(&error, interval) {
                    Some(delay) => delay,
                    None => return Err(error),
                };
                failure = Some(error);
            }
        }
        if timeout_at(deadline, sleep(delay)).await.is_err() {
            break;
        }
    }
    if let Some(mut result) = last {
        result["wait"] = json!({"completed":false,"timedOut":true});
        Ok(result)
    } else {
        Err(failure.take().unwrap_or_else(|| {
            Error::new(
                "TRANSPORT_ERROR",
                "Status wait deadline elapsed before any status was observed",
            )
        }))
    }
}

#[cfg(unix)]
pub async fn inbox(
    client: &Client,
    from: Option<&str>,
    after: Option<&str>,
    seconds: u64,
    interval: u64,
) -> Result<Value, Error> {
    use tokio::signal::unix::{SignalKind, signal};
    if from.is_some_and(|s| !DID.is_match(s)) || after.is_some_and(|s| !cursor("inbox", s)) {
        return Err(Error::usage("Invalid inbox wait selection or bounds"));
    }
    let mut sigint = signal(SignalKind::interrupt())
        .map_err(|_| Error::client("Cannot install inbox interrupt handler"))?;
    let mut sigterm = signal(SignalKind::terminate())
        .map_err(|_| Error::client("Cannot install inbox interrupt handler"))?;
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut continuation = after.map(str::to_owned);
    let mut interrupted = false;
    let polling = async {
        loop {
            let mut query = Vec::new();
            if let Some(from) = from {
                query.push(("from", from));
            }
            if let Some(ref value) = continuation {
                query.push(("after", value.as_str()));
            }
            let path = format!("/inbox/updates?{}", crate::reads::query(&query));
            let mut delay = Duration::from_secs(interval);
            match client.get(&path).await {
                Ok(mut result) => {
                    let valid = result["messages"].as_array().is_some_and(|rows| {
                        rows.len() <= 50
                            && rows.iter().all(|r| {
                                r["messageId"].as_str().is_some_and(|s| ID.is_match(s))
                                    && r["sender"].as_str().is_some_and(|s| {
                                        DID.is_match(s) && from.is_none_or(|f| f == s)
                                    })
                            })
                    });
                    if !valid
                        || !result["cursor"]
                            .as_str()
                            .is_some_and(|s| cursor("inbox", s))
                        || !result["hasMore"].is_boolean()
                    {
                        return Err(Error::response("Invalid inbox update page"));
                    }
                    continuation = result["cursor"].as_str().map(str::to_owned);
                    if !result["messages"].as_array().unwrap().is_empty() {
                        result["contentTrust"] = "untrusted".into();
                        result["wait"] =
                            json!({"completed":true,"timedOut":false,"interrupted":false});
                        return Ok(result);
                    }
                }
                Err(error) => {
                    delay = match retry_delay(&error, interval) {
                        Some(d) => d,
                        None => return Err(error),
                    };
                }
            }
            sleep(delay).await;
        }
    };
    // Dropping the losing future cancels both response streaming and retry sleeps.
    tokio::select! {
        biased;
        _ = sigint.recv() => { interrupted = true; }
        _ = sigterm.recv() => { interrupted = true; }
        _ = tokio::time::sleep_until(deadline) => {}
        result = polling => return result,
    }
    Ok(json!({"messages":[],"cursor":continuation,"hasMore":false,
        "wait":{"completed":false,"timedOut":Instant::now() >= deadline,"interrupted":interrupted}}))
}

#[cfg(not(unix))]
pub async fn inbox(
    _: &Client,
    _: Option<&str>,
    _: Option<&str>,
    _: u64,
    _: u64,
) -> Result<Value, Error> {
    Err(Error::client(
        "Inbox interruption is currently supported only on Unix",
    ))
}
