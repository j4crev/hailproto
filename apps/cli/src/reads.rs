use crate::contract::{DID, Error, ID, UUID};
use serde_json::{Value, json};
use std::collections::HashSet;

pub fn cursor(kind: &str, value: &str) -> bool {
    match kind {
        "inbox" => {
            !value.is_empty()
                && value.len() <= 1024
                && value
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        }
        "grants" => ID.is_match(value),
        "credentials" => UUID.is_match(value),
        _ => false,
    }
}

pub async fn list_pages(
    kind: &str,
    after: Option<&str>,
    pages: usize,
    mut get: impl AsyncFnMut(&str) -> Result<Value, Error>,
) -> Result<Value, Error> {
    if !(1..=100).contains(&pages) || after.is_some_and(|s| !cursor(kind, s)) {
        return Err(Error::usage("Invalid page count or continuation cursor"));
    }
    let field = if kind == "inbox" { "messages" } else { kind };
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut continuation = after.map(str::to_owned);
    if let Some(value) = after {
        seen.insert(value.to_owned());
    }
    let mut first = json!({});
    let mut size = 0;
    for page in 0..pages {
        // Validated cursors contain only URL-unreserved ASCII bytes.
        let path = format!(
            "/{kind}{}",
            continuation
                .as_ref()
                .map_or(String::new(), |c| format!("?after={c}"))
        );
        let result = get(&path).await?;
        size += result.to_string().len();
        let rows = result[field].as_array().ok_or_else(|| {
            Error::response("Provider returned an invalid or oversized list page")
        })?;
        if size > 8 * 1024 * 1024
            || rows.len() > 50
            || rows.iter().any(|row| {
                !row.is_object()
                    || match kind {
                        "credentials" => !row["credentialId"]
                            .as_str()
                            .is_some_and(|s| UUID.is_match(s)),
                        "grants" => !row["grantId"].as_str().is_some_and(|s| ID.is_match(s)),
                        _ => {
                            !row["messageId"].as_str().is_some_and(|s| ID.is_match(s))
                                || !row["sender"].as_str().is_some_and(|s| DID.is_match(s))
                        }
                    }
            })
            || result.get("next").is_none()
            || !result["next"].is_null()
                && (rows.is_empty() || !result["next"].as_str().is_some_and(|s| cursor(kind, s)))
        {
            return Err(Error::response(
                "Provider returned an invalid or oversized list page",
            ));
        }
        items.extend(rows.iter().cloned());
        continuation = result["next"].as_str().map(str::to_owned);
        if page == 0 {
            first = result;
        }
        match &continuation {
            None => break,
            Some(next) if !seen.insert(next.clone()) => {
                return Err(Error::response(
                    "Provider returned a repeated continuation cursor",
                ));
            }
            _ => {}
        }
    }
    first[field] = items.into();
    first["next"] = continuation.map_or(Value::Null, Value::String);
    Ok(first)
}

// Match encodeURIComponent for sender/message path segments.
pub fn component(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(char::from(byte));
        } else {
            use std::fmt::Write;
            write!(result, "%{byte:02X}").unwrap();
        }
    }
    result
}

pub fn query(pairs: &[(&str, &str)]) -> String {
    let mut url = reqwest::Url::parse("https://query.invalid").unwrap();
    url.query_pairs_mut().extend_pairs(pairs.iter().copied());
    url.query().unwrap_or("").to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    const A: &str = "019a0000-0000-7000-8000-000000000001";
    const B: &str = "019a0000-0000-7000-8000-000000000002";

    #[tokio::test]
    async fn merges_pages_and_preserves_metadata_and_resume_cursor() {
        let mut paths = Vec::new();
        let result = list_pages("grants", None, 2, async |path| {
            paths.push(path.to_owned());
            Ok(if paths.len() == 1 {
                json!({"grants":[{"grantId":A}],"next":A,"metadata":"kept"})
            } else {
                json!({"grants":[{"grantId":B}],"next":B})
            })
        })
        .await
        .unwrap();
        assert_eq!(paths, ["/grants", &format!("/grants?after={A}")]);
        assert_eq!(
            result,
            json!({"grants":[{"grantId":A},{"grantId":B}],"next":B,"metadata":"kept"})
        );
    }

    #[tokio::test]
    async fn rejects_bad_cursors_cycles_rows_and_size() {
        assert_eq!(
            list_pages("inbox", Some("bad&cursor"), 1, async |_| panic!(
                "must not request"
            ))
            .await
            .unwrap_err()
            .code,
            "USAGE_ERROR"
        );
        assert_eq!(
            list_pages("grants", None, 2, async |_| Ok(
                json!({"grants":[{"grantId":A}],"next":A})
            ))
            .await
            .unwrap_err()
            .code,
            "RESPONSE_ERROR"
        );
        for page in [
            json!({"grants":[],"next":A}),
            json!({"grants":[]}),
            json!({"grants":[{"grantId":"invalid"}],"next":null}),
            json!({"grants":vec![json!({"grantId":A});51],"next":null}),
            json!({"grants":[{"grantId":A,"text":"a".repeat(8*1024*1024)}],"next":null}),
        ] {
            assert_eq!(
                list_pages("grants", None, 1, async |_| Ok(page.clone()))
                    .await
                    .unwrap_err()
                    .code,
                "RESPONSE_ERROR"
            );
        }
        assert!(
            list_pages("credentials", None, 1, async |_| Ok(
                json!({"credentials":[{"credentialId":A}],"next":null})
            ))
            .await
            .is_ok()
        );
        assert!(list_pages("inbox", None, 1, async |_| Ok(json!({"messages":[{"messageId":A,"sender":format!("did:plc:{}","a".repeat(24))}],"next":"opaque_cursor"}))).await.is_ok());
    }
}
