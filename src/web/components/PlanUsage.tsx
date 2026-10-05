import { useState } from "react";
import { api } from "../lib/api.ts";
import { Icon } from "../lib/icons.tsx";
import { toast, useStore } from "../store.ts";
import { useNow } from "./ToolCall.tsx";
import type { PlanUsage, UsageWindow } from "../../shared/protocol.ts";

// Claude subscription usage, as Claude Code reports it with every request (the same numbers
// as its /usage screen). Nothing here reads credentials.

const WINDOWS: Record<string, [short: string, long: string]> = {
  five_hour: ["Session", "Current session (5 hours)"],
  seven_day: ["Week", "This week · all models"],
  seven_day_opus: ["Week · Opus", "This week · Opus"],
  seven_day_sonnet: ["Week · Sonnet", "This week · Sonnet"],
};
const ORDER = Object.keys(WINDOWS);

const NOTICE: Record<string, string> = {
  five_hour: "5-hour session",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
};

const humanize = (key: string) => key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
export const windowLabel = (key: string, long = false) => WINDOWS[key]?.[long ? 1 : 0] ?? humanize(key);

/** Claude Code reports 0..1; tolerate a percentage just in case. */
export const pct = (w: UsageWindow) => Math.max(0, Math.min(100, w.utilization > 1.5 ? w.utilization : w.utilization * 100));
const pctLabel = (p: number) => (p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`);
const level = (p: number) => (p >= 90 ? "danger" : p >= 75 ? "warn" : "");

export function fmtUntil(ms: number): string {
  if (ms <= 0) return "now";
  const m = Math.ceil(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const fmtAgo = (ms: number) => (ms < 60_000 ? "just now" : `${fmtUntil(ms)} ago`);
const fmtWhen = (t: number) => new Date(t).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

function sortedWindows(limits: PlanUsage) {
  return Object.entries(limits.windows).sort(([a], [b]) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
}

/** Send Claude Code one tiny request so it reports current usage. */
function useCheckNow() {
  const [busy, setBusy] = useState(false);
  const check = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { limits } = await api<{ limits: PlanUsage | null }>("/claude/limits", { method: "POST" });
      if (limits) useStore.setState({ limits });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  return [busy, check] as const;
}

function Meter({ name, w, now, long }: { name: string; w: UsageWindow; now: number; long?: boolean }) {
  const reset = w.resetsAt !== undefined && w.resetsAt <= now;
  const p = reset ? 0 : pct(w);
  return (
    <div className={`plan-meter ${level(p)}`}>
      <div className="plan-meter-row">
        <span className="plan-meter-name">{windowLabel(name, long)}</span>
        <span className="plan-meter-pct">{reset ? "–" : pctLabel(p)}</span>
      </div>
      <div className="plan-bar" role="meter" aria-label={windowLabel(name, true)} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p)}>
        <i style={{ width: `${p}%` }} />
      </div>
      {w.resetsAt !== undefined && (
        <div className="plan-meter-reset" title={new Date(w.resetsAt).toLocaleString()}>
          {reset ? "reset · updates with your next message" : long ? `Resets ${fmtWhen(w.resetsAt)} · in ${fmtUntil(w.resetsAt - now)}` : `resets in ${fmtUntil(w.resetsAt - now)}`}
        </div>
      )}
    </div>
  );
}

/** Compact meters for the sidebar footer. */
export function PlanMeters() {
  const limits = useStore((s) => s.limits);
  const claude = useStore((s) => s.claude);
  const live = useStore((s) => Object.keys(s.running).length > 0);
  const now = useNow(true);
  const [busy, check] = useCheckNow();
  const subscription = claude.cli === "ok" && claude.loggedIn !== false && !/api.?key|console/i.test(claude.authMethod ?? "");

  if (!limits) {
    if (!subscription) return null;
    return (
      <div className="plan-usage empty">
        <div className="plan-head">
          <span>plan usage</span>
          <button className="plan-check" disabled={busy} onClick={() => void check()} title="Send one tiny Haiku request so Claude Code reports your usage">
            {busy ? "checking…" : "check"}
          </button>
        </div>
        <div className="plan-meter-reset">Shows up with your first message.</div>
      </div>
    );
  }

  const windows = sortedWindows(limits);
  const status = limits.status === "rejected" ? "limit reached" : limits.status === "allowed_warning" ? "near limit" : null;
  return (
    <div className={`plan-usage ${limits.status === "rejected" ? "is-rejected" : limits.status === "allowed_warning" ? "is-warning" : ""}`}>
      <div className="plan-head">
        <span>plan usage</span>
        {status ? (
          <span className="plan-status">{status}</span>
        ) : live ? (
          <span className="plan-live" title="Updates with every request Claude makes">
            <i /> live
          </span>
        ) : (
          <span className="plan-ago" title={`Updated ${new Date(limits.updatedAt).toLocaleString()}`}>{fmtAgo(now - limits.updatedAt)}</span>
        )}
        <button className={`icon-btn plan-refresh ${busy ? "spin" : ""}`} disabled={busy} onClick={() => void check()} title="Refresh now (sends one tiny Haiku request)">
          <Icon name="refresh" size={12} />
        </button>
      </div>
      {windows.slice(0, 3).map(([name, w]) => (
        <Meter key={name} name={name} w={w} now={now} />
      ))}
    </div>
  );
}

/** Detailed card for Settings → Claude account. */
export function PlanUsageCard() {
  const limits = useStore((s) => s.limits);
  const now = useNow(true);
  const [busy, check] = useCheckNow();
  const overage = limits?.overage;
  const overageText = !overage?.status
    ? null
    : overage.inUse
      ? "Extra usage is being used right now."
      : overage.status === "rejected"
        ? `Extra usage is off${overage.disabledReason ? ` (${overage.disabledReason.replace(/_/g, " ")})` : ""}: requests stop at the limit until it resets.`
        : `Extra usage: ${overage.status.replace(/_/g, " ")}.`;

  return (
    <div className="card">
      <h3>
        <Icon name="gauge" /> Plan usage
        <span style={{ flex: 1 }} />
        <button className="btn small" disabled={busy} onClick={() => void check()}>
          <Icon name="refresh" size={13} /> {busy ? "Checking…" : "Check now"}
        </button>
      </h3>
      {limits ? (
        <>
          <div className="plan-usage plan-usage-lg">
            {sortedWindows(limits).map(([name, w]) => (
              <Meter key={name} name={name} w={w} now={now} long />
            ))}
          </div>
          <p className="muted">
            {limits.status === "rejected"
              ? `Limit reached${limits.limitType ? ` (${windowLabel(limits.limitType, true).toLowerCase()})` : ""}. `
              : limits.status === "allowed_warning"
                ? "You're close to a limit. "
                : ""}
            {overageText} Updated {fmtAgo(now - limits.updatedAt)}.
          </p>
        </>
      ) : (
        <p className="muted">No usage reported yet. It appears after your first message, or press Check now.</p>
      )}
      <p className="muted plan-note">
        These are the numbers Claude Code reports with every request, the same ones as its <span className="kbd">/usage</span> screen. They refresh live while Claude works. Check now sends one tiny Haiku request.
      </p>
    </div>
  );
}

/** One line above the composer when a limit is close or reached. */
export function LimitNotice() {
  const limits = useStore((s) => s.limits);
  const now = useNow(!!limits && limits.status !== "allowed");
  if (!limits || limits.status === "allowed") return null;
  const key = limits.limitType ?? sortedWindows(limits)[0]?.[0];
  const w = key ? limits.windows[key] : undefined;
  const resetsAt = w?.resetsAt ?? limits.resetsAt;
  if (resetsAt !== undefined && resetsAt <= now) return null;
  const name = key ? NOTICE[key] ?? humanize(key).toLowerCase() : "usage";
  const when = resetsAt !== undefined ? ` Resets in ${fmtUntil(resetsAt - now)}.` : "";
  return (
    <div className={`limit-notice ${limits.status === "rejected" ? "danger" : "warn"}`} role="status">
      <Icon name="alert" size={13} />
      {limits.status === "rejected"
        ? <span>You've hit your {name} limit, so Claude can't reply until it resets.{when}</span>
        : <span>You've used {w ? pctLabel(pct(w)) : "most"} of your {name} limit.{when}</span>}
    </div>
  );
}

/** Session usage next to the Claude status in the top bar. */
export function SessionBadge() {
  const w = useStore((s) => s.limits?.windows.five_hour);
  const now = useNow(!!w);
  if (!w || (w.resetsAt !== undefined && w.resetsAt <= now)) return null;
  const p = pct(w);
  return <span className={`status-usage ${level(p)}`} title="Claude plan usage in the current 5-hour session">{pctLabel(p)}</span>;
}
