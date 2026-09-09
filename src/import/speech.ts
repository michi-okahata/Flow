import { invoke } from "@tauri-apps/api/core";
import type { Round } from "../model/round";
import type { Support } from "../model/types";

export interface SpeechLine {
  text: string;
  support: Support;
}

export interface SpeechPosition {
  title: string;
  lines: SpeechLine[];
}

/** A CardMirror speech document, reduced to exactly what appears on a flow. */
export interface SpeechDocument {
  path: string;
  /** Zero-based Flow column: 0 = 1AC, 1 = 1NC. */
  speech: number;
  speechLabel: "1AC" | "1NC";
  positions: SpeechPosition[];
}

export async function readSpeech(path: string): Promise<SpeechDocument> {
  return invoke<SpeechDocument>("cmir_read_speech", { path });
}

/**
 * Create only the positions the user approved. Every CardMirror card or
 * analytic becomes a root in the prepared speech's column; evidence bodies
 * have already been deliberately left behind by the native reader.
 */
export function createSpeechFlows(
  round: Round,
  document: SpeechDocument,
  selected: ReadonlySet<number>,
): string[] {
  const before = round.sheets();
  const emptyStarter =
    before.length === 1 &&
    before[0]?.title === "untitled" &&
    round.flow(before[0].id).roots().length === 0
      ? before[0].id
      : null;
  const created: string[] = [];
  document.positions.forEach((position, index) => {
    if (!selected.has(index)) return;
    const id = round.addSheet(position.title);
    const flow = round.flow(id);
    flow.batch(() => {
      for (const line of position.lines) {
        flow.add(
          { root: null },
          { text: line.text, speech: document.speech, mark: "none", support: line.support },
        );
      }
    });
    created.push(id);
  });
  if (created.length > 0 && emptyStarter) round.removeSheet(emptyStarter);
  return created;
}
