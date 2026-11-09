/*
 * Debug log. Lines always go to an in-memory ring buffer so "Save
 * diagnostics…" in the tray menu can write them out without a terminal; with
 * WEBTRAY_DEBUG=1 they are also printed.
 */
const lines: string[] = [];
const MAX = 400;

function record(line: string) {
  lines.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (lines.length > MAX) lines.splice(0, lines.length - MAX);
}

export function debug(msg: string): void {
  record(msg);
  if (process.env.WEBTRAY_DEBUG) console.log(`[webtray] ${msg}`);
}

export function recentLog(): string[] {
  return lines.slice();
}

// Warnings (blocked permissions, failed notifications…) belong in the log too.
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  record('WARN ' + args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  warn(...args);
};
