# Flow

## Agent answers

Flow keeps generated answers on the sheet rather than opening a chat. Put the
cursor on an argument and press `g`; the answer streams into the next speech as
a shadow argument. Press `Tab` to add it to the shared CRDT document, or `Esc`
to dismiss it.

The desktop app includes **Codex subscription** and **Claude subscription** in
the model picker. They use the local `codex` and `claude` logins, so no API key
is needed. Run `codex login` or `claude login` once in Terminal; the Claude
option becomes available after Claude Code is installed.

Configure additional AI routing in `~/.flow/config.json`:

```json
{
  "ai": {
    "provider": "ollama",
    "router": "http://localhost:11434/v1/chat/completions",
    "api": "openai-chat-completions",
    "model": "qwen3:8b",
    "contextTokens": 12000,
    "outputTokens": 700
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

`⌘J` opens the agent rail; `⇧⌘J` expands it over the flow, and its left edge
drags to any width in between. Drag it far enough — or zoom in far enough that
the sheet list and the rail have taken the window between them — and the flow
steps out rather than shrinking into columns too narrow to hold a word; the rail
takes the width it gives back. The drag snaps across that boundary, holding at
the widest rail that still leaves a readable flow. The rail holds as many **threads** as you want to
keep: prep on the politics DA and a question about the 1AR on topicality are two
lines of work, and each thread carries its own history, its own standing
direction for later `g` drafts, and its own context. Threads run side by side —
one can be working while you read another — and `+ new` starts one, a
double-click renames it, `×` deletes it. They persist with the round, sync to
peers, and are written into the saved sheet files.

Each turn shows what the agent actually did: every tool call is listed in the
turn that made it, with the arguments sent and what came back, and it stays in
the thread afterwards. An interrupted or failed turn is written down too, tool
calls and all — those edits already reached the document, and a transcript that
hid them would misreport the round. `stop` interrupts a running turn.

The rail can import a CardMirror folder or one `.cmir` file; flow recall
continues to use short card tags, while the agent can retrieve the corresponding
citations and evidence bodies. Only relevant blocks are included in a request.

`contextTokens` caps the entire working prompt. Flow divides it between the open thread's recent
messages and standing directions, a compact debate snapshot, and retrieved CardMirror
material. Older assistant prose is dropped first and older user directions are
folded into a small strategy brief. Stable instructions and prior chat are kept
at the front of each request to preserve as much provider KV-cache reuse as an
OpenAI-compatible endpoint allows. `outputTokens` caps each generated reply.

The strategy agent can traverse and edit the debate itself using
`list_positions`, `read_position`, `read_argument`, and `edit_argument`.
For example: “Follow the responses on Politics and tighten the impact argument.”
Edits save directly through the shared document and require the exact text read
beforehand, preventing stale rewrites. Tool activity is retained in the run
transcript. Chat requires a model/router supporting OpenAI-compatible function
calling; tool-enabled chat returns its reply after the tool steps complete.

Configure multiple models/endpoints with named profiles in `~/.flow/config.json`:

```json
{
  "ai": {
    "default": "local",
    "profiles": {
      "local": {
        "provider": "ollama",
        "router": "http://localhost:11434/v1/chat/completions",
        "api": "openai-chat-completions",
        "model": "qwen3:8b"
      },
      "remote": {
        "provider": "your-provider",
        "router": "https://your-provider.example/v1/chat/completions",
        "api": "openai-chat-completions",
        "model": "your-model",
        "apiKey": "your-key",
        "contextTokens": 16000,
        "outputTokens": 1500
      }
    }
  }
}
```

Choose a profile beside send, at the foot of the agent rail (⌘J). The choice
applies to subsequent chat and draft requests for this app session; running
requests retain their original profile. `ai.default` controls the selection at launch. Each profile
has independent credentials, endpoint, model, and token limits. Existing single
`ai` configurations still work. Supported wire protocols are `openai-chat-completions` and `openai-responses`.

For Responses API profiles, set `"api": "openai-responses"` and point `router`
to the full Responses endpoint, for example `https://api.openai.com/v1/responses`.
Keep your model, API key, and token limits in that profile. Both chat tools and
argument drafts support Responses, including streamed text. `outputTokens` maps
to `max_output_tokens`. Requests use `store: false` and replay reasoning and
function-call items within a tool run. Chat Completions profiles still work.
