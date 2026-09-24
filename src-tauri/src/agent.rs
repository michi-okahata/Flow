use serde::Deserialize;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliRequest {
    provider: String,
    model: String,
    prompt: String,
}

#[tauri::command]
pub async fn agent_cli_complete(request: AgentCliRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || run(request))
        .await
        .map_err(|error| format!("agent process failed: {error}"))?
}

#[tauri::command]
pub async fn agent_codex_rate_limits() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(read_codex_rate_limits)
        .await
        .map_err(|error| format!("usage process failed: {error}"))?
}

fn read_codex_rate_limits() -> Result<serde_json::Value, String> {
    let mut child = Command::new("codex")
        .args(["app-server", "--stdio"])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
        .spawn().map_err(|error| format!("could not start Codex App Server: {error}"))?;
    let mut input = child.stdin.take().ok_or("Codex App Server stdin was unavailable")?;
    let output = child.stdout.take().ok_or("Codex App Server stdout was unavailable")?;
    let mut lines = BufReader::new(output).lines();
    writeln!(input, "{}", serde_json::json!({
        "method": "initialize", "id": 1,
        "params": { "clientInfo": { "name": "flow", "title": "Flow", "version": "0.1.0" } }
    })).map_err(|error| error.to_string())?;
    input.flush().map_err(|error| error.to_string())?;
    loop {
        let line = lines.next().ok_or("Codex App Server closed during initialization")?
            .map_err(|error| error.to_string())?;
        let message: serde_json::Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        if message.get("id").and_then(|id| id.as_i64()) == Some(1) { break; }
    }
    writeln!(input, "{}", serde_json::json!({ "method": "initialized", "params": {} }))
        .map_err(|error| error.to_string())?;
    writeln!(input, "{}", serde_json::json!({ "method": "account/rateLimits/read", "id": 2, "params": {} }))
        .map_err(|error| error.to_string())?;
    input.flush().map_err(|error| error.to_string())?;
    loop {
        let line = lines.next().ok_or("Codex App Server closed before returning usage")?
            .map_err(|error| error.to_string())?;
        let message: serde_json::Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        if message.get("id").and_then(|id| id.as_i64()) == Some(2) {
            let _ = child.kill();
            if let Some(error) = message.get("error") { return Err(error.to_string()); }
            return message.get("result").cloned().ok_or("Codex returned no usage result".into());
        }
    }
}

fn run(request: AgentCliRequest) -> Result<String, String> {
    let mut command = match request.provider.as_str() {
        "codex" => {
            let mut command = Command::new("codex");
            command.args([
                "exec", "-", "--ephemeral", "--ignore-user-config", "--ignore-rules",
                "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never",
            ]);
            if !request.model.trim().is_empty() && request.model != "default" {
                command.args(["--model", request.model.as_str()]);
            }
            command
        }
        "claude" => {
            let mut command = Command::new("claude");
            command.args(["-p", "--output-format", "text", "--tools", ""]);
            if !request.model.trim().is_empty() && request.model != "default" {
                command.args(["--model", request.model.as_str()]);
            }
            command
        }
        other => return Err(format!("unknown local agent: {other}")),
    };
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| match request.provider.as_str() {
        "claude" => format!("Claude Code is not installed. Install it, run `claude login`, then try again: {error}"),
        _ => format!("Codex CLI is not installed. Install it, run `codex login`, then try again: {error}"),
    })?;
    child.stdin.as_mut().ok_or("agent stdin was unavailable")?
        .write_all(request.prompt.as_bytes()).map_err(|error| error.to_string())?;
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() { format!("{} exited with {}", request.provider, output.status) } else { detail });
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() { Err(format!("{} returned no reply", request.provider)) } else { Ok(text) }
}
