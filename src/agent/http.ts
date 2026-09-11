import type { AiConfig } from "./types";

/**
 * One POST to the configured router.
 *
 * The failure is the reason this is shared. A router is a URL the user typed
 * into ~/.flow/config.json, and the most common way to get it wrong is the
 * path: `/chat/responses` where the provider serves `/responses`. That answers
 * `404` with an empty reason phrase and an empty body, which reaches the status
 * line as "404 :" — true, and useless. Naming the endpoint in the message is
 * what turns it into a sentence the user can act on without a debugger.
 */
export async function postToRouter(
  config: AiConfig,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(config.router, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (response.ok) return response;
  const detail = (await response.text().catch(() => "")).trim();
  throw new Error(
    [
      `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
      ` from ${config.router}`,
      detail ? `: ${detail.slice(0, 500)}` : "",
    ].join(""),
  );
}
