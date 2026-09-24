import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  canRemember,
  readMemorized,
  type Block,
  type ImportedFile,
} from "../memory/store";
import { indexOf, recall as recallIn, type Recall } from "../memory/recall";
import { blocksOf, countOf, filesIn, scan, scanFile } from "../memory/cmir";
import { folderName, pickDirectory, pickFile } from "../files/disk";

/**
 * The blocks the user has to hand. Memorized answers are written through to
 * `~/.flow`; imported evidence is workspace context and lives only in memory
 * until the app closes.
 *
 * Read once, at launch. Every cursor movement asks this whether the argument it
 * landed on is one there are answers for, and nothing about moving the cursor
 * should reach the disk — so the store is the copy of record and this is the
 * copy that is used, with writes going to both.
 *
 * Two pieces of state rather than one list filtered two ways: the memorized half
 * is re-read every time the memory sheet writes, while the imported half is the
 * current workspace and changes only when somebody imports or clears it.
 */

export interface Memory {
  /** The ones you memorized — what the memory sheet shows and writes back. */
  memorized: Block[];
  /** Session-only CardMirror/Word blocks available to the agent's retriever. */
  imported: Block[];
  /** Return full evidence already held in the current workspace. */
  contextFor: (blocks: Block[]) => Promise<Block[]>;
  /**
   * What answers this argument in this position — see `recall`. The position is
   * a preference and not a filter.
   */
  recall: (argument: string, position: string) => Recall;
  /**
   * Read a folder of CardMirror or Word files and file every block in it. Asks where.
   * Replaces whatever was read out of that folder last time.
   */
  importFrom: () => void;
  /**
   * Read one CardMirror or Word file in as blocks. Asks which. Replaces whatever was
   * read out of that file last time, and nothing else — so one file out of an
   * imported folder can be refreshed on its own, and a file picked by mistake
   * costs `:forget`-ing it alone rather than the folder it came with.
   */
  importFile: () => void;
  /** Drop every imported block. What you memorized stays. */
  forget: () => void;
  /**
   * Read the memorized half of `~/.flow` again, after the memory sheet has been
   * editing the store behind this list's back (see useMemoryRound.ts). Only
   * that half: nothing there touches the imported one.
   */
  refresh: () => void;
  /** Report a failure from something else writing to the store — see `flush`. */
  report: (reason: unknown) => void;
  /**
   * What went wrong last, if anything. A browser tab, which has no home
   * directory to keep a `.flow` in, reports itself here the first time you
   * use an import command, rather than failing silently.
   */
  error: string | null;
  /**
   * What last worked and was worth saying: how much an import read in, what a
   * `:forget` dropped. Separate from `error` because the status line draws that
   * one as a failure.
   */
  note: string | null;
}

export function useMemory(): Memory {
  const [memorized, setMemorized] = useState<Block[]>([]);
  const [imported, setImported] = useState<Block[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!canRemember()) return;
    readMemorized().then(setMemorized, (reason) => setError(String(reason)));
  }, []);

  useEffect(() => {
    if (!canRemember()) return;
    // Dropped if the component goes before the reads land — this runs twice
    // under StrictMode, and the throwaway pass must not set state.
    let live = true;
    readMemorized().then(
      (mine) => {
        if (!live) return;
        setMemorized(mine);
      },
      (reason) => live && setError(String(reason)),
    );
    return () => {
      live = false;
    };
  }, []);

  const theirsRef = useRef(imported);
  theirsRef.current = imported;

  /**
   * Read a folder in. This is a deliberate act with a dialog in front of it,
   * so it reads the selected files before
   * replacing that folder's previous contents in the current workspace.
   */
  const importFrom = useCallback(async () => {
    if (!canRemember()) {
      setError("importing needs the desktop app");
      return;
    }
    try {
      const picked = await pickDirectory();
      if (!picked) return;
      // The folder as the filesystem spells it, not as the dialog handed it
      // over — see `cmir_read_dir`. What the blocks are filed under has to be
      // the same string next time or the next import will double them.
      const scanned = await scan(picked);
      const files = filesIn(scanned);
      const prefix = scanned.dir.replace(/[\\/]+$/, "") + separatorFor(scanned.dir);
      const incoming = blocksFrom(files);
      setImported((current) => [
        ...current.filter((block) => !block.source.startsWith(prefix)),
        ...incoming,
      ]);
      setError(null);
      setNote(read(scanned.dir, countOf(files), files.length, scanned));
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  /**
   * The single-file shape of `importFrom`, and not optimistic for the same
   * reason: a dialog in front of it, the disk on the far side of it. The file
   * replaces its earlier workspace copy, including when it now has no blocks.
   */
  const importFile = useCallback(async () => {
    if (!canRemember()) {
      setError("importing needs the desktop app");
      return;
    }
    try {
      const picked = await pickFile();
      if (!picked) return;
      // The file as the filesystem spells it, which is what `cmir_read_file`
      // canonicalises and what its blocks are filed under — so reading the
      // same file twice is one file, and reading its folder later sweeps it up.
      const file = await scanFile(picked);
      const blocks = blocksOf(file);
      setImported((current) => [
        ...current.filter((block) => block.source !== file.path),
        ...blocks.map((block) => ({ ...block, source: file.path })),
      ]);
      setError(null);
      setNote(readOne(file.path, blocks.length));
    } catch (reason) {
      setError(String(reason));
    }
  }, []);

  const forget = useCallback(async () => {
    const dropped = theirsRef.current.length;
    setImported([]);
    setError(null);
    setNote(dropped === 1 ? "1 imported block dropped" : dropped + " imported blocks dropped");
  }, []);

  // Built once per change to a list rather than per keystroke — see `Index`.
  const mine = useMemo(() => indexOf(memorized), [memorized]);
  const theirs = useMemo(() => indexOf(imported), [imported]);

  const recall = useCallback(
    (argument: string, position: string) => recallIn(argument, mine, theirs, position),
    [mine, theirs],
  );
  const contextFor = useCallback(async (blocks: Block[]) => blocks, []);

  // One object, held between renders: the keymap takes this whole thing as part
  // of its context, and a fresh one every render would have it dropping and
  // re-attaching its window listener for nothing.
  const report = useCallback((reason: unknown) => setError(String(reason)), []);

  return useMemo(
    () => ({
      memorized,
      imported,
      contextFor,
      recall,
      importFrom: () => void importFrom(),
      importFile: () => void importFile(),
      forget: () => void forget(),
      refresh,
      report,
      error,
      note,
    }),
    [memorized, imported, contextFor, recall, importFrom, importFile, forget, refresh, report, error, note],
  );
}

/**
 * What an import came to, in a line. A folder only half walked, or a file that
 * wouldn't open, is a block that isn't there and no other sign of it.
 */
function read(
  dir: string,
  blocks: number,
  files: number,
  scanned: { failed: number; truncated: boolean },
): string {
  const said =
    blocks === 0
      ? "no blocks in " + dir
      : blocks + (blocks === 1 ? " block" : " blocks") +
        " from " + files + (files === 1 ? " file" : " files");
  const also: string[] = [];
  if (scanned.failed > 0) also.push(scanned.failed + " unreadable");
  if (scanned.truncated) also.push("folder too large to read whole");
  return also.length > 0 ? said + " (" + also.join(", ") + ")" : said;
}

/**
 * The same for one picked file. By its name rather than its path — a single
 * file is the one thing the user just had in their hand, and the full path is
 * what a tooltip is for.
 */
function readOne(path: string, blocks: number): string {
  const name = folderName(path);
  return blocks === 0
    ? "no blocks in " + name
    : blocks + (blocks === 1 ? " block from " : " blocks from ") + name;
}

/** Flatten scanned files into the in-memory shape used by retrieval. */
function blocksFrom(files: ImportedFile[]): Block[] {
  return files.flatMap((file) =>
    file.blocks.map((block) => ({ ...block, source: file.source })),
  );
}

/** Match a canonical folder without also matching a similarly named sibling. */
function separatorFor(path: string): "/" | "\\" {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}
