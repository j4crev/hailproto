use regex::Regex;
use serde_json::{Value, json};
use std::sync::LazyLock;

pub static UUID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$").unwrap());
pub static ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").unwrap()
});
pub static DID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^did:plc:[a-z2-7]{24}$").unwrap());
pub static TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"hailp_[A-Za-z0-9_-]{43}").unwrap());

pub fn redact(text: &str) -> String {
    TOKEN.replace_all(text, "[REDACTED]").into_owned()
}

#[derive(Debug)]
pub struct Error {
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
    pub retry_after: Option<u64>,
}

impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            status: None,
            retry_after: None,
        }
    }
    pub fn client(message: &str) -> Self {
        Self::new("CLIENT_ERROR", message)
    }
    pub fn usage(message: &str) -> Self {
        Self::new("USAGE_ERROR", message)
    }
    pub fn response(message: &str) -> Self {
        Self::new("RESPONSE_ERROR", message)
    }
    pub fn transport() -> Self {
        Self::new(
            "TRANSPORT_ERROR",
            "Provider API transport failed; check connectivity/HTTPS trust and retain exact retry artifacts",
        )
    }
    pub fn json(&self) -> Value {
        let mut error = json!({"code": self.code, "message": self.message});
        if let Some(status) = self.status {
            error["httpStatus"] = status.into();
            error["retryable"] = matches!(status, 429 | 503).into();
            if let Some(seconds) = self.retry_after {
                error["retryAfterSeconds"] = seconds.into();
            }
        }
        json!({"cliContractVersion": 1, "error": error})
    }
}
