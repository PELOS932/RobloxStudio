// Auto-compact: "compact when the conversation reaches N tokens", turned into Claude Code's knobs.
//
// Claude Code compacts when the context passes a threshold = (window - reserve) * percent, where
// `window` is CLAUDE_CODE_AUTO_COMPACT_WINDOW (capped at the model's real window), `reserve` is
// kept for the reply and `percent` is CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (80 by default).
// DISABLE_AUTO_COMPACT=1 turns it off. Environment variables work on every recent CLI, unlike
// the newer --autocompact flag.

/** "auto" = Claude Code's default, "off" = never, a number = compact at about this many tokens. */
export type AutoCompact = "auto" | "off" | number;

export const COMPACT_PRESETS = [60_000, 100_000, 150_000, 200_000, 300_000, 500_000];
export const COMPACT_MIN = 40_000;
export const COMPACT_MAX = 950_000;
/** Claude Code's default threshold on 1M-token models (980k effective window × 80%). */
export const COMPACT_DEFAULT_1M = 784_000;
const RESERVE = 20_000;
const WINDOW_MIN = 100_000;
const WINDOW_MAX = 1_000_000;

export function clampCompact(tokens: number): number {
  if (!Number.isFinite(tokens)) return 200_000;
  return Math.round(Math.min(COMPACT_MAX, Math.max(COMPACT_MIN, tokens)) / 1000) * 1000;
}

/** The smallest window that keeps Claude Code's usual 80% rule, and the percent that lands on `tokens`. */
export function compactPlan(tokens: number): { window: number; percent: number; threshold: number } {
  const t = clampCompact(tokens);
  const window = Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, Math.ceil((t / 0.8 + RESERVE) / 1000) * 1000));
  const percent = Math.min(100, Math.round((t / (window - RESERVE)) * 100_000) / 1000);
  return { window, percent, threshold: Math.round(((window - RESERVE) * percent) / 100) };
}

/** Environment changes for a setting (null = remove an inherited value). */
export function compactEnv(a: AutoCompact): Record<string, string | null> {
  if (a === "auto") return {};
  if (a === "off") return { DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_AUTO_COMPACT_WINDOW: null, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: null };
  const { window, percent } = compactPlan(a);
  return { DISABLE_AUTO_COMPACT: null, CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window), CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(percent) };
}

export function parseAutoCompact(v: unknown): AutoCompact | undefined {
  if (v === "auto" || v === "off") return v;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? clampCompact(n) : undefined;
}

/** Where compaction will kick in for a setting, before Claude Code reports the real number. */
export function expectedThreshold(a: AutoCompact): number | null {
  if (a === "off") return null;
  if (a === "auto") return COMPACT_DEFAULT_1M;
  return compactPlan(a).threshold;
}
