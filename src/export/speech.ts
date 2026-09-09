import { invoke } from "@tauri-apps/api/core";
import type { Round, SheetInfo } from "../model/round";
import type { Argument, Speech } from "../model/types";
import { argumentKey } from "../memory/recall";

export interface ExportLine {
  text: string;
  support: "card" | "analytic";
}

export interface ExportBlock {
  parent: string;
  key: string;
  lines: ExportLine[];
}

export interface ExportPosition {
  id: string;
  title: string;
  blocks: ExportBlock[];
  lines: number;
  cards: number;
}

function groupsFor(roots: Argument[], title: string, speech: number): ExportBlock[] {
  const groups = new Map<string, ExportBlock>();
  const visit = (argument: Argument, parent: Argument | null) => {
    if (argument.speech === speech && argument.text.trim()) {
      const groupId = parent?.id ?? "@roots";
      let group = groups.get(groupId);
      if (!group) {
        group = {
          parent: parent ? `AT: ${parent.text.trim()}` : title,
          key: argumentKey(parent?.text ?? title),
          lines: [],
        };
        groups.set(groupId, group);
      }
      group.lines.push({ text: argument.text.trim(), support: argument.support });
    }
    for (const child of argument.children) visit(child, argument);
  };
  for (const root of roots) visit(root, null);
  return [...groups.values()].filter((group) => group.lines.length > 0);
}

export function speechPositions(
  round: Round,
  sheets: SheetInfo[],
  speech: number,
): ExportPosition[] {
  return sheets.map((sheet) => {
    const blocks = groupsFor(round.flow(sheet.id).roots(), sheet.title, speech);
    const lines = blocks.reduce((sum, block) => sum + block.lines.length, 0);
    const cards = blocks.reduce(
      (sum, block) => sum + block.lines.filter((line) => line.support === "card").length,
      0,
    );
    return { ...sheet, blocks, lines, cards };
  });
}

export async function writeSpeech(
  destination: string,
  speech: Speech,
  positions: ExportPosition[],
): Promise<void> {
  await invoke("store_export_speech", {
    destination,
    speechLabel: speech.label,
    positions: positions.map(({ title, blocks }) => ({ title, blocks })),
  });
}
