# Flow

## Agent answers

Flow keeps generated answers on the sheet rather than opening a chat. Put the
cursor on an argument and press `g`; the answer streams into the next speech as
a shadow argument. Press `Tab` to add it to the shared CRDT document, or `Esc`
to dismiss it.

Configure any OpenAI-compatible service in `~/.flow/config.json`:

```json
{
  "agent": {
    "provider": "openai-compatible",
    "endpoint": "http://localhost:11434/v1/chat/completions",
    "model": "qwen3:8b"
  }
}
```

An optional `apiKey` is sent as a bearer token. The provider boundary is an
adapter, so additional wire protocols do not affect the sheet or its CRDT tool
calls. Complete records of generated, accepted, dismissed, cancelled, and
failed runs are appended to `~/.flow/transcripts.jsonl` (browser preview uses
local storage).
