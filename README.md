# Flow

## Agent answers

Flow keeps generated answers on the sheet rather than opening a chat. Put the
cursor on an argument and press `g`; the answer streams into the next speech as
a shadow argument. Press `Tab` to add it to the shared CRDT document, or `Esc`
to dismiss it.

Configure AI routing in `~/.flow/config.json`:

```json
{
  "ai": {
    "provider": "ollama",
    "router": "http://localhost:11434/v1/chat/completions",
    "api": "openai-chat-completions",
    "model": "qwen3:8b"
  }
}
```

`provider` names who runs the model, `router` is the endpoint receiving the
request, and `api` selects its wire protocol. An optional `apiKey` is sent as a
bearer token. This separation lets a provider be reached directly or through a
router without coupling either one to the sheet. Complete records of generated,
accepted, dismissed, cancelled, and
failed runs are appended to `~/.flow/transcripts.jsonl` (browser preview uses
local storage).
