use serde::Deserialize;
use std::io::Write;
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
