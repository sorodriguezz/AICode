//! HTTP for mods: any URL, method, headers and body, sent from Rust — so a mod is not held to the
//! window's CSP or to CORS, gets the real status and headers, binary bodies, timings, and can cancel.
//! A request streams back as `http://head` (status, headers, time to first byte), `http://data`
//! (body chunks, base64) and `http://end` (total time and size, or the error).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::mods::{require, ModsState};

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(Default)]
pub struct HttpState {
    running: Mutex<HashMap<u32, (String, tauri::async_runtime::JoinHandle<()>)>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    url: String,
    method: Option<String>,
    /// Pairs, so a header can repeat (Set-Cookie, Accept…).
    headers: Option<Vec<(String, String)>>,
    body: Option<String>,
    /// `body` is bytes, base64-encoded.
    body_base64: Option<bool>,
    /// No limit when absent.
    timeout_ms: Option<u64>,
    /// Default true (up to 10 redirects).
    follow_redirects: Option<bool>,
    /// Accept invalid or self-signed TLS certificates (a local dev server).
    insecure: Option<bool>,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// Starts a request and returns its id at once; the response streams back as events.
#[tauri::command]
pub fn http_request(
    app: AppHandle,
    window: tauri::Window,
    mods: State<'_, ModsState>,
    state: State<'_, HttpState>,
    mod_id: String,
    request: HttpRequest,
) -> Result<u32, String> {
    require(&mods, &mod_id, "network")?;
    let method = reqwest::Method::from_bytes(request.method.as_deref().unwrap_or("GET").to_ascii_uppercase().as_bytes())
        .map_err(|e| format!("method: {e}"))?;
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("AICode/", env!("CARGO_PKG_VERSION")))
        .redirect(if request.follow_redirects.unwrap_or(true) { reqwest::redirect::Policy::limited(10) } else { reqwest::redirect::Policy::none() })
        .danger_accept_invalid_certs(request.insecure.unwrap_or(false));
    if let Some(ms) = request.timeout_ms.filter(|ms| *ms > 0) {
        builder = builder.timeout(Duration::from_millis(ms));
    }
    let client = builder.build().map_err(|e| e.to_string())?;
    let body = match request.body {
        Some(b) if request.body_base64.unwrap_or(false) => Some(b64().decode(b).map_err(|e| format!("body: {e}"))?),
        Some(b) => Some(b.into_bytes()),
        None => None,
    };
    let mut req = client.request(method, &request.url);
    for (k, v) in request.headers.unwrap_or_default() {
        req = req.header(k, v);
    }
    if let Some(body) = body {
        req = req.body(body);
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let label = window.label().to_string();
    let task_app = app.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let app = task_app;
        let start = Instant::now();
        let ms = |t: Instant| t.elapsed().as_secs_f64() * 1000.0;
        let end = |payload: serde_json::Value| {
            app.state::<HttpState>().running.lock().unwrap().remove(&id);
            let _ = app.emit_to(label.as_str(), "http://end", payload);
        };
        let mut resp = match req.send().await {
            Ok(r) => r,
            Err(e) => return end(json!({ "id": id, "error": describe(&e), "totalMs": ms(start) })),
        };
        let headers: Vec<(String, String)> =
            resp.headers().iter().map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect();
        let status = resp.status();
        let _ = app.emit_to(
            label.as_str(),
            "http://head",
            json!({
                "id": id,
                "status": status.as_u16(),
                "statusText": status.canonical_reason().unwrap_or(""),
                "headers": headers,
                "url": resp.url().as_str(),
                "version": format!("{:?}", resp.version()),
                "ttfbMs": ms(start),
            }),
        );
        let mut size: u64 = 0;
        loop {
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    size += bytes.len() as u64;
                    let _ = app.emit_to(label.as_str(), "http://data", json!({ "id": id, "data": b64().encode(&bytes) }));
                }
                Ok(None) => break,
                Err(e) => return end(json!({ "id": id, "error": describe(&e), "totalMs": ms(start), "size": size })),
            }
        }
        end(json!({ "id": id, "totalMs": ms(start), "size": size }));
    });
    state.running.lock().unwrap().insert(id, (window.label().to_string(), handle));
    Ok(id)
}

/// Stops a request; it ends with `{ cancelled: true }`.
#[tauri::command]
pub fn http_cancel(app: AppHandle, state: State<'_, HttpState>, id: u32) -> Result<(), String> {
    if let Some((label, handle)) = state.running.lock().unwrap().remove(&id) {
        handle.abort();
        let _ = app.emit_to(label.as_str(), "http://end", json!({ "id": id, "error": "cancelled", "cancelled": true }));
    }
    Ok(())
}

fn describe(e: &reqwest::Error) -> String {
    let what = if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "could not connect"
    } else if e.is_redirect() {
        "too many redirects"
    } else if e.is_body() || e.is_decode() {
        "the response body failed"
    } else {
        "request failed"
    };
    // The source chain says why (DNS, refused, TLS…).
    let mut detail = String::new();
    let mut src = std::error::Error::source(e);
    while let Some(s) = src {
        detail = s.to_string();
        src = s.source();
    }
    if detail.is_empty() { format!("{what}: {e}") } else { format!("{what}: {detail}") }
}
