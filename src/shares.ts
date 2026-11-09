// Shared links: a browser lent through a link to someone outside the company, for a task. Two kinds:
//   login: they sign in to their own account (GoDaddy, Namecheap…) and the agent carries on in that
//          browser once they press "I'm done".
//   lend:  they use one of our accounts: one site's sign-in is copied into the browser from an
//          agent's (or a shared computer's), and they never see its password.
// Each share is its own browser (share-<id>), empty but for what is copied in, limited to the pages
// it lists, recorded, and wiped when it ends. The gateway serves the link (gateway/share-core.ts).
import { botFor, newShareId, openable, replayToken, shareToken, validPattern, type ShareMode, type ShareStatus } from "../gateway/share-core.ts";

export const MAX_ACTIVE = 3;
export const DEFAULT_HOURS = 48;
export const MAX_HOURS = 7 * 24;
export const RECORDING_DAYS = 30;

export interface Share {
  id: string;
  bot: string;
  mode: ShareMode;
  title: string;
  allow: string[];
  start: string;
  /** The link's expiry, unix seconds. */
  exp: number;
  createdAt: number;
  createdBy: { kind: "agent" | "user"; id: string; name: string };
  /** For "lend": whose sign-in was copied in, and for which sites. */
  lendFrom?: { bot: string; label: string; copied: number };
  task?: string | null;
  status: ShareStatus;
  openedAt?: number;
  doneAt?: number;
  endedAt?: number;
  endReason?: string;
}

export interface ShareInput { mode: ShareMode; title: string; allow: string[]; start: string; hours: number; lend: string | null; task: string | null }

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\n,]+/) : []).map((x) => String(x).trim()).filter(Boolean);

/** What a share is asked for with, checked. `lend` names whose sign-in to copy (an agent, or a shared computer). */
export function parseShareInput(input: Record<string, unknown>): { ok: true; value: ShareInput } | { ok: false; error: string } {
  const allow = [...new Set(list(input.allow ?? input.allowed ?? input.urls))];
  if (!allow.length) return { ok: false, error: "allow is required: the addresses the person may open, e.g. [\"dcc.godaddy.com/control/*\", \"sso.godaddy.com\"]. Include the sign-in pages the site uses." };
  if (allow.length > 50) return { ok: false, error: "allow has too many addresses (50 at most)." };
  const badOne = allow.find((p) => !validPattern(p));
  if (badOne) return { ok: false, error: `"${badOne}" is not an address (a host like dcc.godaddy.com, optionally with a path; * as a wildcard).` };
  const startRaw = typeof input.start === "string" ? input.start.trim() : "";
  const start = startRaw ? (/^https?:\/\//i.test(startRaw) ? startRaw : `https://${startRaw}`) : allow.map(openable).find(Boolean) ?? "";
  if (!start) return { ok: false, error: "start is required when every allowed address has a wildcard: the page the person lands on." };
  try { new URL(start); } catch { return { ok: false, error: "start is not a web address." }; }
  const mode: ShareMode = input.mode === "lend" ? "lend" : "login";
  const hoursRaw = input.hours === undefined || input.hours === "" ? DEFAULT_HOURS : Number(input.hours);
  if (!Number.isFinite(hoursRaw) || hoursRaw <= 0) return { ok: false, error: "hours must be a number of hours." };
  const lend = typeof input.lend === "string" && input.lend.trim() ? input.lend.trim() : typeof input.lendFrom === "string" && input.lendFrom.trim() ? input.lendFrom.trim() : null;
  if (mode === "lend" && !lend) return { ok: false, error: "lend is required for mode \"lend\": whose sign-in to copy in (\"me\" for your own computer, or a shared computer's name)." };
  const title = (typeof input.title === "string" && input.title.trim() ? input.title.trim() : "Shared browser").slice(0, 120);
  const task = typeof input.task === "string" && input.task.trim() ? input.task.trim().slice(0, 40) : null;
  return { ok: true, value: { mode, title, allow, start, hours: Math.min(hoursRaw, MAX_HOURS), lend: mode === "lend" ? lend : null, task } };
}

export function newShare(v: ShareInput, randomBytes: Uint8Array, createdBy: Share["createdBy"], now = Date.now()): Share {
  const id = newShareId(randomBytes);
  return { id, bot: botFor(id), mode: v.mode, title: v.title, allow: v.allow, start: v.start, exp: Math.floor(now / 1000 + v.hours * 3600),
    createdAt: now, createdBy, task: v.task, status: "active" };
}

export const shareLink = (base: string, key: Buffer, s: Share) => `${base}/_computer/s/${shareToken(key, s.id, s.exp)}`;
/** The recording's replay, valid as long as the recording is kept. */
export const replayLink = (base: string, key: Buffer, s: Share) => `${base}/_computer/r/${replayToken(key, s.id, s.exp + RECORDING_DAYS * 86_400)}`;

/** A share as an agent or the page sees it: links only while they work. */
export function describe(s: Share, base: string, key: Buffer, recording?: { frames: number } | null) {
  const open = s.status !== "ended";
  return {
    id: s.id, computer: s.bot, title: s.title, mode: s.mode, status: s.status, allow: s.allow, start: s.start,
    expiresAt: new Date(s.exp * 1000).toISOString(), createdAt: new Date(s.createdAt).toISOString(), createdBy: s.createdBy.name,
    task: s.task ?? null, openedAt: s.openedAt ? new Date(s.openedAt).toISOString() : null, doneAt: s.doneAt ? new Date(s.doneAt).toISOString() : null,
    endedAt: s.endedAt ? new Date(s.endedAt).toISOString() : null, endReason: s.endReason ?? null,
    lendFrom: s.lendFrom ? { from: s.lendFrom.label, cookiesCopied: s.lendFrom.copied } : null,
    link: open ? shareLink(base, key, s) : null,
    recording: recording === undefined ? undefined : { frames: recording?.frames ?? 0, replay: replayLink(base, key, s) },
  };
}

/** Whether a call names this share: its id or its computer (share-<id>). */
export const names = (s: Share, ref: string) => ref === s.id || ref === s.bot;
