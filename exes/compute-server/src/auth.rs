//! Bearer token authentication.

use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::Next;
use axum::response::Response;

use crate::api::{ApiError, AppState};

/// Compares two tokens without leaking the position of the first mismatch.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut difference = 0u8;
    for (left, right) in a.iter().zip(b) {
        difference |= left ^ right;
    }
    difference == 0
}

/// Extracts credentials only from the Authorization header.
pub fn presented_token(request: &Request) -> Option<String> {
    if let Some(value) = request.headers().get(AUTHORIZATION) {
        let value = value.to_str().ok()?;
        let token = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))?;
        return Some(token.trim().to_string());
    }
    None
}

/// Middleware that rejects requests without a valid token.
pub async fn require_token(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token =
        presented_token(&request).ok_or_else(|| ApiError::unauthorized("missing bearer token"))?;
    let owner = state
        .sessions
        .owner(&token)
        .ok_or_else(|| ApiError::unauthorized("invalid or revoked client token"))?;
    let mut request = request;
    request.extensions_mut().insert(Owner(owner));
    Ok(next.run(request).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_comparison() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
    }

    #[test]
    fn rejects_query_credentials() {
        let request = Request::builder()
            .uri("/api/v1/jobs/1/events?token=a%20b")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(presented_token(&request).as_deref(), None);
        let request = Request::builder()
            .uri("/api/v1/jobs/1?token=x")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(presented_token(&request), None);
        let request = Request::builder()
            .uri("/api/v1/jobs/1")
            .header(AUTHORIZATION, "Bearer secret")
            .body(axum::body::Body::empty())
            .unwrap();
        assert_eq!(presented_token(&request).as_deref(), Some("secret"));
    }
}

#[derive(Clone)]
pub struct Owner(pub String);

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Session {
    token: String,
    client_id: String,
}

pub struct Sessions {
    path: std::path::PathBuf,
    records: std::sync::Mutex<Vec<Session>>,
}

impl Sessions {
    pub fn load(dir: &std::path::Path) -> std::io::Result<Self> {
        let path = dir.join("sessions.json");
        let records = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error),
        };
        Ok(Self {
            path,
            records: std::sync::Mutex::new(records),
        })
    }

    pub fn owner(&self, token: &str) -> Option<String> {
        self.records
            .lock()
            .unwrap()
            .iter()
            .find(|session| constant_time_eq(token, &session.token))
            .map(|session| session.client_id.clone())
    }

    pub fn pair(&self) -> std::io::Result<(String, String)> {
        let mut records = self.records.lock().unwrap();
        let session = Session {
            token: format!("{}{}", crate::api::new_job_id(), crate::api::new_job_id()),
            client_id: crate::api::new_job_id(),
        };
        let mut updated = records.clone();
        updated.push(session.clone());
        crate::durable::write(&self.path, &updated)?;
        *records = updated;
        Ok((session.token, session.client_id))
    }

    pub fn revoke(&self, owner: &str) -> std::io::Result<()> {
        let mut records = self.records.lock().unwrap();
        let updated: Vec<_> = records
            .iter()
            .filter(|record| record.client_id != owner)
            .cloned()
            .collect();
        crate::durable::write(&self.path, &updated)?;
        *records = updated;
        Ok(())
    }
}
