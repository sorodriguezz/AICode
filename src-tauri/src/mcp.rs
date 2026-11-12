//! AICode as an MCP server, so an agent outside the editor — CodeFlow's, a CLI's — can see and
//! change what is open in it, unsaved text included.
//!
//! Transport: MCP "Streamable HTTP" in its plain-JSON form (every POST answered with one JSON
//! response, no SSE stream), on `127.0.0.1` only, behind a bearer token that lives in
//! `AICode/state/mcp.json` so a client configured once keeps working across restarts.
//!
//! The server only carries messages. The tools are the `aicode.mcp-server` mod's: it tells the core
//! which tools exist ([`mcp_set_tools`]), each `tools/call` becomes an `mcp://call` event in the
//! window, and the mod answers with [`mcp_reply`]. A tool that needs the user (accepting an edit)
//! simply answers later.

use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::mods::{require, ModsState};
use crate::paths;

const SUPPORTED_VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DEFAULT_PORT: u16 = 47821;
/// How long a tool call may wait for the window (an edit waits for the user's answer).
const CALL_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Serialize, Deserialize, Clone)]
struct Saved {
    port: u16,
    token: String,
}

struct Running {
    server: Arc<tiny_http::Server>,
    port: u16,
    token: String,
    owner: String,
}

#[derive(Default)]
pub struct McpState {
    running: Mutex<Option<Running>>,
    tools: Mutex<Vec<Value>>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    next: AtomicU64,
}

fn saved() -> Saved {
    let path = paths::state().join("mcp.json");
    if let Some(s) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Saved>(&t).ok()) {
        return s;
    }
    let bytes: [u8; 24] = rand::rng().random();
    let token: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let s = Saved { port: DEFAULT_PORT, token };
    let _ = crate::fsops::write_atomic(&path, serde_json::to_string_pretty(&s).unwrap().as_bytes());
    s
}

pub fn status_value(app: &AppHandle) -> Option<Value> {
    let state = app.state::<McpState>();
    let running = state.running.lock().unwrap();
    running.as_ref().map(|r| {
        json!({
            "port": r.port,
            "url": format!("http://127.0.0.1:{}/mcp", r.port),
            "token": r.token,
            "owner": r.owner,
            "tools": state.tools.lock().unwrap().len(),
        })
    })
}

#[tauri::command]
pub fn mcp_status(app: AppHandle) -> Option<Value> {
    status_value(&app)
}

#[tauri::command]
pub fn mcp_start(app: AppHandle, mods: State<'_, ModsState>, mcp: State<'_, McpState>, mod_id: String) -> Result<Value, String> {
    require(&mods, &mod_id, "mcp-server")?;
    if mcp.running.lock().unwrap().is_some() {
        return Ok(status_value(&app).unwrap());
    }
    let mut cfg = saved();
    let server = match tiny_http::Server::http(("127.0.0.1", cfg.port)) {
        Ok(s) => s,
        Err(_) => {
            // The usual port is taken: take any, and remember it so the client config is still one
            // copy-paste away.
            let s = tiny_http::Server::http(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
            cfg.port = s.server_addr().to_ip().map(|a| a.port()).unwrap_or(0);
            let _ = crate::fsops::write_atomic(&paths::state().join("mcp.json"), serde_json::to_string_pretty(&cfg).unwrap().as_bytes());
            s
        }
    };
    let server = Arc::new(server);
    *mcp.running.lock().unwrap() = Some(Running { server: server.clone(), port: cfg.port, token: cfg.token.clone(), owner: mod_id });
    let token = cfg.token.clone();
    let handle_app = app.clone();
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            let app = handle_app.clone();
            let token = token.clone();
            std::thread::spawn(move || handle(app, request, &token));
        }
    });
    Ok(status_value(&app).unwrap_or(json!({ "port": cfg.port })))
}

#[tauri::command]
pub fn mcp_stop(mcp: State<'_, McpState>) {
    if let Some(r) = mcp.running.lock().unwrap().take() {
        r.server.unblock();
    }
    for (_, tx) in mcp.pending.lock().unwrap().drain() {
        let _ = tx.send(json!({ "isError": true, "content": [{ "type": "text", "text": "AICode's MCP server stopped" }] }));
    }
}

#[tauri::command]
pub fn mcp_set_tools(mcp: State<'_, McpState>, tools: Vec<Value>) {
    *mcp.tools.lock().unwrap() = tools;
}

#[tauri::command]
pub fn mcp_reply(mcp: State<'_, McpState>, call_id: u64, result: Value) {
    if let Some(tx) = mcp.pending.lock().unwrap().remove(&call_id) {
        let _ = tx.send(result);
    }
}

fn respond(request: tiny_http::Request, status: u16, body: Option<Value>) {
    let text = body.map(|b| b.to_string()).unwrap_or_default();
    let mut response = tiny_http::Response::from_string(text).with_status_code(status);
    if let Ok(h) = tiny_http::Header::from_bytes("Content-Type", "application/json") {
        response.add_header(h);
    }
    let _ = request.respond(response);
}

fn header(request: &tiny_http::Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn handle(app: AppHandle, mut request: tiny_http::Request, token: &str) {
    // A web page in a browser on this machine must not be able to reach the editor: refuse anything
    // that carries a browser Origin (MCP's guidance against DNS rebinding), then the token.
    if let Some(origin) = header(&request, "Origin") {
        if origin != "null" && !origin.is_empty() {
            return respond(request, 403, Some(json!({ "error": "origin not allowed" })));
        }
    }
    let expected = format!("Bearer {token}");
    if header(&request, "Authorization").as_deref() != Some(expected.as_str()) {
        return respond(request, 401, Some(json!({ "error": "missing or wrong bearer token" })));
    }
    let path = request.url().split('?').next().unwrap_or("").to_string();
    if path != "/mcp" {
        return respond(request, 404, None);
    }
    match request.method() {
        tiny_http::Method::Post => {}
        tiny_http::Method::Delete => return respond(request, 200, None),
        _ => return respond(request, 405, None),
    }
    let mut body = String::new();
    if request.as_reader().take(16 * 1024 * 1024).read_to_string(&mut body).is_err() {
        return respond(request, 400, None);
    }
    let Ok(message) = serde_json::from_str::<Value>(&body) else {
        return respond(request, 400, Some(rpc_error(Value::Null, -32700, "parse error")));
    };
    let answer = match message {
        Value::Array(batch) => {
            let answers: Vec<Value> = batch.into_iter().filter_map(|m| dispatch(&app, m)).collect();
            (!answers.is_empty()).then(|| Value::Array(answers))
        }
        single => dispatch(&app, single),
    };
    match answer {
        Some(a) => respond(request, 200, Some(a)),
        None => respond(request, 202, None),
    }
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// One JSON-RPC message. Notifications (no id) get no answer.
fn dispatch(app: &AppHandle, message: Value) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let id = id?;
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(|v| v.as_str()).unwrap_or("");
            let version = SUPPORTED_VERSIONS.iter().find(|v| **v == asked).copied().unwrap_or(SUPPORTED_VERSIONS[1]);
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "aicode", "title": "AICode editor", "version": env!("CARGO_PKG_VERSION") },
                "instructions": "Tools to see and change what is open in the user's AICode editor, unsaved text included. Edits are proposals: the user accepts or rejects each one in the editor."
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": app.state::<McpState>().tools.lock().unwrap().clone() }),
        "tools/call" => call_tool(app, params),
        _ => return Some(rpc_error(id, -32601, &format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

fn call_tool(app: &AppHandle, params: Value) -> Value {
    let state = app.state::<McpState>();
    let call_id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = mpsc::channel();
    state.pending.lock().unwrap().insert(call_id, tx);
    let name = params.get("name").cloned().unwrap_or(Value::Null);
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    // The tools are about "the user's editor": the window in front answers.
    let Some(target) = crate::windows::front_label(app) else {
        state.pending.lock().unwrap().remove(&call_id);
        return tool_error("no AICode window is open");
    };
    if app.emit_to(target.as_str(), "mcp://call", json!({ "callId": call_id, "name": name, "arguments": arguments })).is_err() {
        state.pending.lock().unwrap().remove(&call_id);
        return tool_error("the editor window is not available");
    }
    match rx.recv_timeout(CALL_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            state.pending.lock().unwrap().remove(&call_id);
            tool_error("the editor did not answer in time")
        }
    }
}

fn tool_error(text: &str) -> Value {
    json!({ "isError": true, "content": [{ "type": "text", "text": text }] })
}
