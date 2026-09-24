import type { Copied } from "../model/types";

/** Plain text for other apps and Flow's multiline paste: one argument per line. */
export function copiedText(blocks: Copied[]): string {
  const lines: string[] = [];
  const visit = (block: Copied) => {
    if (block.text.trim()) lines.push(block.text);
    block.children.forEach(visit);
  };
  blocks.forEach(visit);
  return lines.join("\n");
}

/** Write during the trusted key event; the fallback covers desktop webviews
 * that do not expose the modern Clipboard API. */
export function writeClipboard(text: string): void {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
  } else {
    legacyCopy(text);
  }
}

function legacyCopy(text: string): void {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  document.execCommand("copy");
  field.remove();
}
