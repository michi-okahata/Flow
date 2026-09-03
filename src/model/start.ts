import type { Round } from "./round";

/**
 * What a fresh round begins as: one empty sheet, untitled.
 *
 * Not nothing. A round with no sheets has nowhere to put the first argument —
 * it is the state `:delete` refuses to leave you in, and the sheet, the status
 * line and the keymap all read the active sheet without asking whether there
 * is one. One empty sheet is the floor, and every other way a round arrives
 * (opened from a folder, adopted on join) brings its own.
 *
 * "untitled" because that is what an unnamed sheet is called everywhere else —
 * `:new` with no title, and the window itself before the round is saved.
 */
export function firstSheet(round: Round): void {
  round.addSheet("untitled");
}
