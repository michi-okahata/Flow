import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The disk, as the sheet sees it: a folder dialog and four calls across to the
 * Rust side (see `src-tauri/src/files.rs`).
 *
 * Thin on purpose — everything about *what* a sheet is stays in format.ts, and
 * everything about when to write one stays in useLibrary.ts. This layer only
 * knows that files exist.
 */

/** One file in a round's directory, as read off disk. */
export interface SheetFile {
  /** The bare file name. The only handle the Rust side accepts — see `resolve`. */
  name: string;
  text: string;
}

/**
 * Whether this build can reach a filesystem at all — i.e. whether it is the
 * desktop app rather than a browser tab. Same question `canHost` asks of the
 * network, and the same answer in a tab: no.
 */
export function canUseFiles(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Ask for a directory. Null when the dialog was dismissed. */
export async function pickDirectory(): Promise<string | null> {
  return (await invoke<string | null>("files_pick_directory")) ?? null;
}

/** Ask for one file, filtered to CardMirror's extension. Null when the dialog
    was dismissed — the filter is a courtesy, and what came back is still the
    reader's to refuse (see `cmir_read_file`). */
export async function pickFile(): Promise<string | null> {
  return (await invoke<string | null>("files_pick_file")) ?? null;
}

/** Every sheet file in `directory`, read in one call — a round is a handful of
    small files, and seven round trips to list and then fetch them is six more
    than it needs. */
export async function readDirectory(directory: string): Promise<SheetFile[]> {
  return invoke<SheetFile[]>("files_read_dir", { dir: directory });
}

export async function writeFile(
  directory: string,
  name: string,
  text: string,
): Promise<void> {
  await invoke("files_write", { dir: directory, name, text });
}

export async function removeFile(directory: string, name: string): Promise<void> {
  await invoke("files_remove", { dir: directory, name });
}

/**
 * The last segment of a path, for the status line: the full path is what you
 * need in a tooltip and never what you want taking up a status line.
 */
export function folderName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/**
 * Name the window after the round, so that ⌘Tab, the Window menu and Mission
 * Control say *which* flow this is rather than only that Flow is running —
 * which is the whole of what makes a window a document on a Mac.
 *
 * Not in the title bar itself: `hiddenTitle` keeps that clear, because a sheet
 * wants the room. In a browser tab, where there is no window to name, this is
 * the tab.
 */
export async function setWindowTitle(title: string): Promise<void> {
  if (!canUseFiles()) {
    document.title = title;
    return;
  }
  await getCurrentWindow().setTitle(title);
}

/**
 * Run `whenClosing` when the window is put away — ⌘W, or the red button.
 *
 * Not a last chance to save: macOS hides the window rather than closing it
 * (see `src-tauri/src/lib.rs`), so everything is still here. It is the moment
 * the round stops being *looked at*, which is a better one to land a queued
 * write than most of a second into a window the system may already have
 * stopped running timers for.
 *
 * Nothing in a browser tab, which has no window to put away, and nothing on
 * the platforms where closing the window closes the app.
 *
 * Returns the way to stop listening.
 */
export function onWindowClosing(whenClosing: () => void): () => void {
  if (!canUseFiles()) return () => {};
  // `listen` resolves a turn later, by which time the effect that asked for it
  // may already have been torn down — hence the flag, rather than an unlisten
  // that arrives after nobody wants it and never runs.
  let stop: (() => void) | null = null;
  let done = false;
  void listen("flow://closing", () => whenClosing()).then((unlisten) => {
    if (done) unlisten();
    else stop = unlisten;
  });
  return () => {
    done = true;
    stop?.();
  };
}
