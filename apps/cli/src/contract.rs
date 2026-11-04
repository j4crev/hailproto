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
    LazyLock::new(|| Regex::new(r"racr_[A-Za-z0-9_-]{43}").unwrap());

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
    pub fn render(&self, bold: bool) -> String {
        let safe = |text: &str| {
            redact(text)
                .chars()
                .map(|c| {
                    if c.is_control() {
                        c.escape_default().to_string()
                    } else {
                        c.to_string()
                    }
                })
                .collect::<String>()
        };
        let title = if bold { "\x1b[1mError\x1b[0m" } else { "Error" };
        let mut text = format!("{title}  {}\n  {}", safe(&self.code), safe(&self.message));
        if let Some(status) = self.status {
            text.push_str(&format!(
                "\n\n  HTTP status  {status}\n  Retryable    {}",
                matches!(status, 429 | 503)
            ));
            if let Some(seconds) = self.retry_after {
                text.push_str(&format!("\n  Retry after  {seconds}s"));
            }
        }
        text
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
        json!({"cliContractVersion": 2, "error": error})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readable_errors_preserve_metadata_and_escape_untrusted_text() {
        let mut error = Error::new(
            "HTTP_429",
            format!("Wait\n\x1b[31m racr_{}", "a".repeat(43)),
        );
        error.status = Some(429);
        error.retry_after = Some(12);
        let text = error.render(false);
        assert!(text.starts_with("Error  HTTP_429\n"));
        assert!(text.contains("HTTP status  429"));
        assert!(text.contains("Retryable    true"));
        assert!(text.contains("Retry after  12s"));
        assert!(text.contains("Wait\\n\\u{1b}[31m [REDACTED]"));
        assert!(!text.contains('\x1b'));
        assert!(error.render(true).starts_with("\x1b[1mError\x1b[0m"));
        assert_eq!(error.json()["error"]["retryAfterSeconds"], 12);
    }
}
