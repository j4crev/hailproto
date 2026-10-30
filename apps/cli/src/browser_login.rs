use crate::{
    api::Client,
    cli::Args,
    codec,
    contract::{Error, UUID},
    credentials, crypto, private,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const DEFAULT: &[&str] = &[
    "account:read",
    "grants:read",
    "messages:read",
    "messages:write",
];
fn invalid() -> Error {
    Error::client(
        "Browser authorization state or response differs from the requested login, or expired",
    )
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
fn random() -> Result<String, Error> {
    Ok(URL_SAFE_NO_PAD.encode(crypto::random::<32>()?.as_ref()))
}
fn token(v: &Value, prefix: &str) -> bool {
    v.as_str()
        .and_then(|s| s.strip_prefix(prefix))
        .is_some_and(|s| {
            s.len() == 43
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
}
fn expiry(v: &Value) -> Result<i64, Error> {
    v.as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|v| v.timestamp_millis())
        .ok_or_else(invalid)
}
fn authorization(state: &Value, provider: &str, check_id: bool) -> Result<(), Error> {
    let url = reqwest::Url::parse(state["authorizationUrl"].as_str().ok_or_else(invalid)?)
        .map_err(|_| invalid())?;
    let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
    if check_id
        && !state["requestId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
        || url.origin().ascii_serialization() != provider
        || url.path() != "/auth/authorize"
        || params.get("request").map(|s| s.as_ref()) != state["requestId"].as_str()
        || params.get("state").map(|s| s.as_ref()) != state["state"].as_str()
        || url.fragment()
            != Some(format!("code={}", state["code"].as_str().ok_or_else(invalid)?).as_str())
    {
        return Err(invalid());
    }
    expiry(&state["expiresAt"])?;
    Ok(())
}
async fn request(client: &Client, path: &str, body: &Value) -> Result<Value, Error> {
    client
        .request_at(path, "/api/v1/auth/authorization", Some(body))
        .await
        .map_err(|e| {
            if e.code == "TRANSPORT_ERROR" {
                e
            } else {
                Error::client(&e.message)
            }
        })
}
async fn callback(
    listener: &tokio::net::TcpListener,
    state: &Value,
    path: &str,
) -> Result<(), Error> {
    let (stream, _) = listener.accept().await.map_err(|_| invalid())?;
    let mut stream = stream;
    let mut bytes = Vec::new();
    while bytes.len() < 8192 && !bytes.windows(4).any(|w| w == b"\r\n\r\n") {
        let mut chunk = [0; 1024];
        let n = stream.read(&mut chunk).await.map_err(|_| invalid())?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..n]);
    }
    let valid = (|| {
        let text = std::str::from_utf8(&bytes).ok()?;
        let line = text.lines().next()?;
        let mut parts = line.split_whitespace();
        if parts.next() != Some("GET") {
            return None;
        }
        let url = reqwest::Url::parse(&format!("http://127.0.0.1{}", parts.next()?)).ok()?;
        let pairs: Vec<_> = url.query_pairs().collect();
        let get = |key: &str| {
            pairs
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.as_ref())
        };
        (url.path() == "/callback"
            && get("state") == state["state"].as_str()
            && get("code") == state["code"].as_str()
            && pairs
                .iter()
                .all(|(k, _)| matches!(k.as_ref(), "state" | "code")))
        .then_some(())
    })()
    .is_some();
    if valid {
        let mut approved = state.clone();
        approved["approved"] = true.into();
        private::replace(path, &approved)?;
    }
    let (status, body) = if valid {
        (
            "200 OK",
            "Hail authorization complete. You can close this tab.",
        )
    } else {
        ("400 Bad Request", "Authorization refused")
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|_| invalid())?;
    if !valid {
        return Err(Error::client(
            "Loopback callback did not match the browser login",
        ));
    }
    Ok(())
}
pub async fn run(args: &Args) -> Result<Value, Error> {
    let opt = |k: &str| args.options.get(k).map(String::as_str).unwrap_or("");
    let provider = opt("provider");
    let path = opt("state");
    let output = opt("credentials");
    private::distinct(&[path, output])?;
    let client = Client::public(provider)?;
    let scopes = credentials::scopes(&if args.scopes.is_empty() {
        json!(DEFAULT)
    } else {
        json!(args.scopes)
    })?;
    if scopes.iter().any(|s| !DEFAULT.contains(&s.as_str())) {
        return Err(Error::client(
            "Browser login requested a scope outside the CLI baseline",
        ));
    }
    let mut state = private::optional_json(path)?;
    if let Some(s) = &state {
        let created = s["createdAt"].as_i64().ok_or_else(invalid)?;
        if s["type"] != "hailp.browser-login"
            || s["version"].as_f64() != Some(1.0)
            || s["provider"] != provider
            || s["scopes"] != json!(scopes)
            || created > now() + 30
            || now().saturating_sub(created) >= 300
            || !token(&s["state"], "")
            || !token(&s["code"], "hailc_")
            || !token(&s["verifier"], "")
            || !token(&s["token"], "hailp_")
        {
            return Err(invalid());
        }
        if s.get("requestId").is_some() {
            authorization(s, provider, true)?;
        } else if s["approved"] == true {
            return Err(invalid());
        }
    }
    let port = if let Some(s) = &state {
        let url = reqwest::Url::parse(s["redirectUri"].as_str().ok_or_else(invalid)?)
            .map_err(|_| invalid())?;
        if url.scheme() != "http"
            || url.host_str() != Some("127.0.0.1")
            || url.path() != "/callback"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.port().is_some_and(|p| p >= 1024)
        {
            return Err(invalid());
        }
        url.port().unwrap()
    } else {
        0
    };
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
        .await
        .map_err(|_| Error::client("Cannot bind browser callback port"))?;
    if state.is_none() {
        if private::optional_json(output)?.is_some() {
            return Err(invalid());
        }
        let value = json!({"type":"hailp.browser-login","version":1,"provider":provider,"scopes":scopes,"state":random()?,"code":format!("hailc_{}",random()?),"verifier":random()?,"token":credentials::token()?,"redirectUri":format!("http://127.0.0.1:{}/callback",listener.local_addr().map_err(|_|invalid())?.port()),"createdAt":now()});
        private::create(path, value.to_string().as_bytes())?;
        state = Some(value);
    }
    let mut state = state.unwrap();
    if state.get("requestId").is_none() {
        let prepared=request(&client,"/prepare",&json!({"clientId":"hailp-cli-v1","redirectUri":state["redirectUri"],"state":state["state"],"code":state["code"],"codeChallenge":codec::digest(state["verifier"].as_str().unwrap().as_bytes()),"scopes":scopes})).await?;
        for field in ["requestId", "authorizationUrl", "expiresAt"] {
            if !prepared[field].is_string() {
                return Err(invalid());
            }
            state[field] = prepared[field].clone();
        }
        authorization(&state, provider, false)?;
        private::replace(path, &state)?;
    }
    if state["approved"] != true {
        #[cfg(target_os = "macos")]
        let program = "open";
        #[cfg(not(target_os = "macos"))]
        let program = "xdg-open";
        let mut command = tokio::process::Command::new(program);
        command
            .arg(state["authorizationUrl"].as_str().ok_or_else(invalid)?)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let browser = async {
            let status = command
                .status()
                .await
                .map_err(|_| Error::client("Could not open the system browser"))?;
            if !status.success() {
                return Err(Error::client("Could not open the system browser"));
            }
            Ok(())
        };
        let millis = (expiry(&state["expiresAt"])? - now() * 1000).clamp(0, 300000) as u64;
        let approval = async {
            tokio::time::timeout(
                std::time::Duration::from_millis(millis),
                callback(&listener, &state, path),
            )
            .await
            .map_err(|_| Error::client("Browser authorization expired or was cancelled"))?
        };
        tokio::try_join!(browser, approval)?;
        state["approved"] = true.into();
        private::replace(path, &state)?;
    }
    let credential=request(&client,"/token",&json!({"clientId":"hailp-cli-v1","redirectUri":state["redirectUri"],"code":state["code"],"verifier":state["verifier"],"token":state["token"]})).await?;
    if credential["type"] != "hailp.api-credential"
        || credential["version"].as_f64() != Some(1.0)
        || credential["provider"] != provider
        || credential["token"] != state["token"]
        || !credential["accountId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
        || !credential["credentialId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
        || credentials::scopes(&credential["scopes"])? != scopes
    {
        return Err(invalid());
    }
    expiry(&credential["expiresAt"])?;
    private::save_identical(output, &credential)?;
    Ok(
        json!({"credentialId":credential["credentialId"],"credentialFile":output,"accountId":credential["accountId"],"scopes":scopes,"expiresAt":credential["expiresAt"]}),
    )
}
