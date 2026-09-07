import type { AgentContextBlock, AgentMessage, DebateSheet } from "./types";

/** A deliberately conservative tokenizer approximation that works for every
 * OpenAI-compatible backend without needing its model-specific vocabulary. */
export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

const WORD = /[a-z0-9]{3,}/g;
const COMMON = new Set([
  "about", "after", "again", "also", "argument", "because", "before", "being",
  "could", "debate", "from", "have", "into", "more", "should", "that", "their",
  "there", "these", "they", "this", "what", "when", "where", "which", "with", "would",
]);

function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(WORD) ?? []).filter((word) => !COMMON.has(word)));
}

function textOf(block: AgentContextBlock): string {
  return `${block.position} ${block.argument} ${block.answers.join(" ")} ${(block.context ?? []).join(" ")}`;
}

/** Select only imported blocks likely to matter to the current request. The
 * sort is deterministic so equivalent calls produce an identical cacheable
 * context segment. */
export function selectContext(
  blocks: AgentContextBlock[],
  query: string,
  position: string,
  budget: number,
): AgentContextBlock[] {
  const wanted = terms(query);
  const ranked = blocks
    .map((block, order) => {
      const have = terms(textOf(block));
      let score = 0;
      for (const word of wanted) if (have.has(word)) score += 2;
      if (position && block.position.toLowerCase() === position.toLowerCase()) score += 5;
      return { block, order, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.block.source.localeCompare(b.block.source) || a.order - b.order);

  const selected: AgentContextBlock[] = [];
  let used = 0;
  for (const { block } of ranked) {
    const fitted = fitBlock(block, budget - used);
    if (!fitted) continue;
    const cost = estimateTokens(JSON.stringify(fitted));
    selected.push(fitted);
    used += cost;
    if (used >= budget) break;
  }
  return selected;
}

function fitBlock(block: AgentContextBlock, budget: number): AgentContextBlock | null {
  if (budget < 40) return null;
  const concise: AgentContextBlock = {
    source: block.source,
    position: block.position.slice(0, 160),
    key: block.key,
    argument: block.argument.slice(0, 600),
    answers: block.answers.slice(0, 8).map((answer) => answer.slice(0, 320)),
  };
  const room = Math.max(0, (budget - estimateTokens(JSON.stringify(concise)) - 8) * 4);
  if (room && block.context?.length) {
    concise.context = [block.context.join("\n").slice(0, room)];
  }
  while (concise.context?.[0] && estimateTokens(JSON.stringify(concise)) > budget) {
    concise.context[0] = concise.context[0].slice(0, -Math.max(16, Math.ceil(concise.context[0].length / 8)));
  }
  return estimateTokens(JSON.stringify(concise)) <= budget ? concise : null;
}

/** Keep recent conversational state verbatim and retain old user directions
 * as a compact strategy brief. Assistant prose is the first thing discarded:
 * user decisions, not the model explaining them, direct later drafts. */
export function compactHistory(messages: AgentMessage[], budget: number): AgentMessage[] {
  const recent: AgentMessage[] = [];
  let used = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const capped = { ...messages[i], content: messages[i].content.slice(-Math.max(160, budget * 3)) };
    const cost = estimateTokens(capped.content) + 6;
    if (recent.length > 0 && used + cost > Math.floor(budget * 0.72)) break;
    recent.unshift(capped);
    used += cost;
    cut = i;
  }
  if (cut === 0) return recent;

  const directions = messages
    .slice(0, cut)
    .filter((message) => message.role === "user")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join(" • ");
  if (!directions) return recent;
  const maxChars = Math.max(160, Math.floor(budget * 0.28) * 4);
  return [{
    id: "compacted-strategy",
    role: "user",
    content: `Earlier debate directions: ${directions.slice(-maxChars)}`,
    createdAt: messages[0]?.createdAt ?? "",
  }, ...recent];
}

export function compactDebate(sheets: DebateSheet[], budget: number): DebateSheet[] {
  const out: DebateSheet[] = [];
  let used = 0;
  for (const sheet of sheets) {
    const argumentsOnly = flatten(sheet.arguments).map((argument) => ({ ...argument, children: [] }));
    const kept = [];
    for (const argument of argumentsOnly) {
      const cost = estimateTokens(argument.text) + 8;
      if (used + cost > budget) break;
      kept.push(argument);
      used += cost;
    }
    if (kept.length) out.push({ title: sheet.title, arguments: kept });
    if (used >= budget) break;
  }
  return out;
}

function flatten(arguments_: DebateSheet["arguments"]): DebateSheet["arguments"] {
  return arguments_.flatMap((argument) => [argument, ...flatten(argument.children)]);
}
