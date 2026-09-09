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

The `agent` rail opens a debate-wide strategy chat. Its messages persist with the
round, sync to peers, and guide later `g` drafts on every sheet. The rail can
import a CardMirror folder or one `.cmir` file; flow recall continues to use
short card tags, while the agent can retrieve the corresponding citations and
evidence bodies. Only relevant blocks are included in a request.

`contextTokens` caps the entire working prompt. Flow divides it between recent
chat/standing directions, a compact debate snapshot, and retrieved CardMirror
material. Older assistant prose is dropped first and older user directions are
folded into a small strategy brief. Stable instructions and prior chat are kept
at the front of each request to preserve as much provider KV-cache reuse as an
OpenAI-compatible endpoint allows. `outputTokens` caps each generated reply.

In the agent rail, **Position tree** lets you switch positions, search argument
text, and expand response chains. Select an argument to locate it on the sheet,
or choose **edit** to revise it and **Save argument** to commit the change.
Edits refuse to overwrite text changed elsewhere while the editor was open.
The **Strategy** tab keeps the debate-wide conversation and evidence imports.

The strategy agent can also traverse and edit the debate itself using
`list_positions`, `read_position`, `read_argument`, and `edit_argument`.
For example: “Follow the responses on Politics and tighten the impact argument.”
Edits save directly through the shared document and require the exact text read
beforehand, preventing stale rewrites. Tool activity is retained in the run
transcript. Chat requires a model/router supporting OpenAI-compatible function
calling; tool-enabled chat returns its reply after the tool steps complete.
