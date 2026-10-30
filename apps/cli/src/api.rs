use crate::contract::{DID, Error, TOKEN, UUID};
use reqwest::{Url, header::HeaderMap, redirect::Policy};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::Read,
    time::{Duration, SystemTime},
};

const MAX_RESPONSE: u64 = 524_288;
pub const SCOPES: &[&str] = &[
    "account:read",
    "grants:read",
    "grants:write",
    "credentials:write",
    "messages:read",
    "messages:write",
    "account:write",
];
const MANAGED_PROFILE: &str = "hail-managed-custody-v1";

pub struct Credential {
    provider: String,
    account_id: String,
    token: String,
}

impl Credential {
    pub fn load(
        path: &str,
        provider: Option<&String>,
        account_id: Option<&String>,
    ) -> Result<Self, Error> {
        if !std::fs::metadata(path)
            .map_err(|_| Error::client("Cannot inspect private credential file"))?
            .is_file()
        {
            return Err(Error::client(
                "Client files must be bounded private mode-0600 regular files",
            ));
        }
        let file =
            File::open(path).map_err(|_| Error::client("Cannot open private credential file"))?;
        let info = file
            .metadata()
            .map_err(|_| Error::client("Cannot inspect private credential file"))?;
        #[cfg(unix)]
        let private = {
            use std::os::unix::fs::PermissionsExt;
            info.permissions().mode() & 0o077 == 0
        };
        // Do not silently bypass credential privacy checks on unsupported platforms.
        #[cfg(not(unix))]
        let private = false;
        if !info.is_file() || !(1..=16_384).contains(&info.len()) || !private {
            return Err(Error::client(
                "Client files must be bounded private mode-0600 regular files",
            ));
        }
        let mut bytes = Vec::new();
        file.take(16_385)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::client("Cannot read private credential file"))?;
        if bytes.len() > 16_384 {
            return Err(Error::client("Credential file exceeded its limit"));
        }
        let record: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Error::client("Invalid hailp credential file"))?;
        Self::from_record(record, provider, account_id)
    }

    pub fn from_record(
        record: Value,
        provider: Option<&String>,
        account_id: Option<&String>,
    ) -> Result<Self, Error> {
        let invalid = || Error::client("Invalid hailp credential file");
        let p = record["provider"].as_str().ok_or_else(invalid)?;
        let id = record["accountId"].as_str().ok_or_else(invalid)?;
        let token = record["token"].as_str().ok_or_else(invalid)?;
        if record["type"] != "hailp.api-credential"
            || record["version"].as_f64() != Some(1.0)
            || !UUID.is_match(id)
            || token.len() != 49
            || !TOKEN.is_match(token)
        {
            return Err(invalid());
        }
        canonical_origin(p).map_err(|_| {
            Error::client("Credential provider must be a canonical HTTPS DNS origin")
        })?;
        if provider.is_some_and(|v| v != p) || account_id.is_some_and(|v| v != id) {
            return Err(Error::new(
                "SELECTION_MISMATCH",
                "Selected provider/account does not match the private credential; select a matching credential file",
            ));
        }
        Ok(Self {
            provider: p.into(),
            account_id: id.into(),
            token: token.into(),
        })
    }
}

pub fn canonical_origin(provider: &str) -> Result<(), Error> {
    let invalid = || Error::usage("Provider must be a canonical HTTPS DNS origin");
    let url = Url::parse(provider).map_err(|_| invalid())?;
    if url.scheme() != "https"
        || url.origin().ascii_serialization() != provider
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.host_str().is_some_and(|h| {
            !h.is_empty()
                && h.parse::<std::net::IpAddr>().is_err()
                && h.bytes()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'.' || c == b'-')
        })
    {
        return Err(invalid());
    }
    Ok(())
}

pub struct Client {
    credential: Credential,
    http: reqwest::Client,
    origin: String,
}

impl Client {
    pub fn new(credential: Credential) -> Result<Self, Error> {
        let http = Self::builder().build().map_err(|_| Error::transport())?;
        Ok(Self {
            origin: credential.provider.clone(),
            credential,
            http,
        })
    }

    fn builder() -> reqwest::ClientBuilder {
        reqwest::Client::builder()
            .redirect(Policy::custom(|attempt| attempt.error("Redirect refused")))
            .timeout(Duration::from_secs(20))
    }

    pub fn signup(provider: &str, token: &str) -> Result<Self, Error> {
        canonical_origin(provider).map_err(|_| Error::client("Invalid signup origin or token"))?;
        if token.len() != 49 || !TOKEN.is_match(token) {
            return Err(Error::client("Invalid signup origin or token"));
        }
        Self::new(Credential {
            provider: provider.into(),
            account_id: String::new(),
            token: token.into(),
        })
    }

    pub fn public(provider: &str) -> Result<Self, Error> {
        canonical_origin(provider)?;
        Self::new(Credential {
            provider: provider.into(),
            account_id: String::new(),
            token: String::new(),
        })
    }

    pub async fn get(&self, path: &str) -> Result<Value, Error> {
        self.request_at(path, "/api/v1/account", None).await
    }

    pub async fn capabilities(&self) -> Result<Value, Error> {
        self.request_at("/capabilities", "/api/v1", None).await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<Value, Error> {
        self.request_at(path, "/api/v1/account", Some(body)).await
    }
    pub async fn request_at(
        &self,
        path: &str,
        namespace: &str,
        body: Option<&Value>,
    ) -> Result<Value, Error> {
        let maximum = if namespace == "/api/v1/auth/authorization" {
            65536
        } else {
            MAX_RESPONSE
        };
        let url = format!("{}{namespace}{path}", self.origin);
        let request = if let Some(body) = body {
            self.http
                .post(url)
                .header("Content-Type", "application/json")
                .body(body.to_string())
        } else {
            self.http.get(url)
        };
        self.send(request, maximum).await
    }
    pub async fn post_limit(&self, path: &str, body: &Value, maximum: u64) -> Result<Value, Error> {
        let request = self
            .http
            .post(format!("{}/api/v1/account{path}", self.origin))
            .header("Content-Type", "application/json")
            .body(body.to_string());
        self.send(request, maximum).await
    }
    pub async fn put(&self, path: &str, bytes: &[u8]) -> Result<Value, Error> {
        let request = self
            .http
            .put(format!("{}/api/v1/account{path}", self.origin))
            .header("Content-Type", "application/cose; cose-type=\"cose-sign1\"")
            .body(bytes.to_vec());
        self.send(request, MAX_RESPONSE).await
    }
    async fn send(
        &self,
        mut request: reqwest::RequestBuilder,
        maximum: u64,
    ) -> Result<Value, Error> {
        if !self.credential.token.is_empty() {
            request = request.bearer_auth(&self.credential.token);
        }
        let mut response = request
            .header("Accept", "application/json")
            .header("Accept-Encoding", "identity")
            .header("Cache-Control", "no-store")
            .send()
            .await
            .map_err(|_| Error::transport())?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(http_error(status, response.headers()));
        }
        let headers = response.headers();
        let length = headers.get("Content-Length");
        if headers.get("Content-Type").and_then(|v| v.to_str().ok()) != Some("application/json")
            || headers.contains_key("Content-Encoding")
            || headers.contains_key("Location")
            || length.is_some_and(|v| {
                v.to_str()
                    .ok()
                    .and_then(|s| {
                        if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
                            None
                        } else {
                            s.parse::<u64>().ok()
                        }
                    })
                    .is_none_or(|n| n > maximum)
            })
        {
            return Err(Error::response(
                "Provider API returned an invalid response representation",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::transport())? {
            if bytes.len() + chunk.len() > maximum as usize {
                return Err(Error::response("Provider API response exceeded its limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        let result: Value = serde_json::from_slice(&bytes)
            .map_err(|_| Error::response("Provider API returned invalid JSON"))?;
        if !result.is_object() {
            return Err(Error::response("Provider API returned invalid JSON"));
        }
        Ok(result)
    }

    pub async fn account(&self) -> Result<Value, Error> {
        account_response(self.get("").await?, &self.credential)
    }
}

fn http_error(status: u16, headers: &HeaderMap) -> Error {
    let advice = match status {
        401 => "Select a valid credential or explicitly log in; expired/revoked access is terminal",
        403 => "The selected credential lacks authority; do not escalate scopes",
        404 => "The resource is unavailable to this account",
        409 => "Retain the original artifacts; check account fences and conflicting state",
        429 | 503 => "Retain artifacts and retry the same request after the indicated delay",
        _ => "Check the documented request contract",
    };
    let code = headers.get("Hail-Error-Code").and_then(|v| v.to_str().ok());
    let code = match (status, code) {
        (401, Some("CREDENTIAL_EXPIRED" | "CREDENTIAL_REVOKED"))
        | (403, Some("MISSING_SCOPE" | "PASSKEY_REQUIRED"))
        | (410, Some("APPROVAL_EXPIRED")) => code.unwrap().to_owned(),
        _ => format!("HTTP_{status}"),
    };
    let retry_after = headers
        .get("Retry-After")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) {
                Some(s.parse::<u64>().unwrap_or(u64::MAX).min(300))
            } else {
                httpdate::parse_http_date(s)
                    .ok()?
                    .duration_since(SystemTime::now())
                    .ok()
                    .map(|d| d.as_secs() + u64::from(d.subsec_nanos() > 0))
            }
        })
        .map(|s| s.min(300));
    Error {
        code,
        message: format!("Provider API returned HTTP {status}. {advice}"),
        status: Some(status),
        retry_after,
    }
}

fn account_response(result: Value, credential: &Credential) -> Result<Value, Error> {
    let invalid =
        || Error::response("Provider account does not match the credential or API contract");
    let public_key = |value: Option<&Value>| {
        value.is_some_and(|v| {
            v.is_null()
                || v.as_str().is_some_and(|s| {
                    s.len() <= 256
                        && s.strip_prefix("did:key:z").is_some_and(|key| {
                            !key.is_empty()
                                && key.bytes().all(|c| {
                                    b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
                                        .contains(&c)
                                })
                        })
                })
        })
    };
    let allowed = |key: &str, values: &[&str], nullable: bool| {
        result.get(key).is_some_and(|v| {
            nullable && v.is_null() || v.as_str().is_some_and(|s| values.contains(&s))
        })
    };
    let managed = result["custodyProfile"] == "managed";
    let mode = result["monitorVerificationMode"].as_str();
    if result["type"] != "hailp.account"
        || result["version"].as_f64() != Some(1.0)
        || result["provider"] != credential.provider
        || result["accountId"] != credential.account_id
        || !result["did"].as_str().is_some_and(|s| DID.is_match(s))
        || !result["address"]
            .as_str()
            .is_some_and(|s| s.encode_utf16().count() <= 254)
        || !allowed("migrationState", &["fenced", "exported", "retired"], true)
        || !allowed(
            "custodyProfile",
            &["owner-controlled", "managed", "custodial-poc", "unknown"],
            false,
        )
        || !allowed(
            "monitorVerificationMode",
            &[
                "independent",
                "poc-local",
                "strict-public-v1",
                "reduced-assurance-alpha-v1",
            ],
            true,
        )
        || managed
            && matches!(
                mode,
                Some("strict-public-v1" | "reduced-assurance-alpha-v1")
            )
            && result["managedProfileVersion"] != MANAGED_PROFILE
        || !managed
            && (mode == Some("reduced-assurance-alpha-v1")
                || !result["managedProfileVersion"].is_null())
        || !result["managedProfileVersion"].is_null()
            && result["managedProfileVersion"] != MANAGED_PROFILE
        || !public_key(result.get("identityPublicKey"))
        || !public_key(result.get("ownerRecoveryPublicKey"))
        || !result["scopes"].as_array().is_some_and(|scopes| {
            scopes
                .iter()
                .all(|v| v.as_str().is_some_and(|s| SCOPES.contains(&s)))
        })
    {
        return Err(invalid());
    }
    let metadata = if let Some(value) = result.get("credential") {
        if !value["credentialId"]
            .as_str()
            .is_some_and(|s| UUID.is_match(s))
            || !value["expiresAt"]
                .as_str()
                .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        {
            return Err(Error::response(
                "Provider returned invalid current credential metadata",
            ));
        }
        json!({"credentialId": value["credentialId"], "expiresAt": value["expiresAt"]})
    } else {
        Value::Null
    };
    let mut output =
        json!({"providerOperator": result["providerOperator"] == true, "credential": metadata});
    for key in [
        "provider",
        "accountId",
        "did",
        "address",
        "migrationState",
        "custodyProfile",
        "scopes",
        "monitorVerificationMode",
        "identityPublicKey",
        "ownerRecoveryPublicKey",
        "managedProfileVersion",
    ] {
        output[key] = result[key].clone();
    }
    Ok(output)
}
