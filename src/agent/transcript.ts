import { invoke } from "@tauri-apps/api/core";
import type { Transcript } from "./types";

const BROWSER_KEY = "flow.agent.transcripts";

/** Persist every run; browser preview falls back to local storage. */
export async function saveTranscript(transcript: Transcript): Promise<void> {
  try {
    await invoke("store_transcript", { transcript });
    return;
  } catch {
    let prior: Transcript[] = [];
    try {
      const read = JSON.parse(localStorage.getItem(BROWSER_KEY) ?? "[]");
      if (Array.isArray(read)) prior = read as Transcript[];
    } catch {
      // A damaged preview cache should not prevent this transcript being kept.
    }
    localStorage.setItem(BROWSER_KEY, JSON.stringify([...prior, transcript]));
  }
}
