// Shared links: a browser lent to someone outside the company through a link (no Paperclip login).
// Used by the gateway (which serves the link) and the plugin (which creates it), so both sign and
// read links the same way. Plain Node APIs only: the plugin's tests import it under Node.
import { createHmac, timingSafeEqual } from "node:crypto";

export type ShareMode = "login" | "lend";
/** active: the person drives. done: they finished; a "login" share stays open to watch the agent. ended: closed. */
export type ShareStatus = "active" | "done" | "ended";

/** What the gateway knows of a share; the plugin pushes it, the gateway adds opened/done. */
export interface ShareMeta {
  id: string;
  /** The computer's id for the share's own browser: share-<id>. */
  bot: string;
  /** Unix seconds. */
  exp: number;
  mode: ShareMode;
  title: string;
  /** The addresses the person may open (computer's page policy), shown on the link's page. */
  allow: string[];
  start: string;
  status: ShareStatus;
  createdAt: number;
  openedAt?: number;
  doneAt?: number;
  endedAt?: number;
}

export const SHARE_ID = /^[a-z2-7]{12}$/;
export const shareKey = (token: string) => createHmac("sha256", token).update("agent-computer share links").digest();
export const botFor = (id: string) => `share-${id}`;

const mac = (key: Buffer, what: string) => createHmac("sha256", key).update(what).digest("hex").slice(0, 32);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The link's token: `<id>.<exp>.<signature>`. Reusable until it expires (or the share ends). */
export function shareToken(key: Buffer, id: string, exp: number): string {
  return `${id}.${exp}.${mac(key, `share.${id}.${exp}`)}`;
}

/** A replay token for a share's recording, for whoever the plugin gives it to. */
export function replayToken(key: Buffer, id: string, exp: number): string {
  return `${id}.${exp}.${mac(key, `replay.${id}.${exp}`)}`;
}

function read(key: Buffer, kind: "share" | "replay", raw: string, now: number): { id: string; exp: number } | null {
  const m = /^([a-z2-7]{12})\.(\d{10})\.([a-f0-9]{32})$/.exec(raw);
  if (!m) return null;
  const exp = Number(m[2]);
  if (exp < now || !same(m[3], mac(key, `${kind}.${m[1]}.${exp}`))) return null;
  return { id: m[1], exp };
}

export const readShareToken = (key: Buffer, raw: string, now = Date.now() / 1000) => read(key, "share", raw, now);
export const readReplayToken = (key: Buffer, raw: string, now = Date.now() / 1000) => read(key, "replay", raw, now);

/** A new share id: 12 base32 letters (60 bits), so a link cannot be guessed. */
export function newShareId(bytes: Uint8Array): string {
  const abc = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  for (let i = 0; i < 12; i++) out += abc[bytes[i] % 32];
  return out;
}

/** An allowed address as people write it: a host (wildcards allowed) and an optional path. */
export function validPattern(raw: string): boolean {
  const v = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/[?#].*$/, "");
  const host = v.split("/")[0].replace(/:\d+$/, "");
  return Boolean(host) && /^[a-z0-9*.-]+$/i.test(host) && host.includes(".") && v.length <= 300 && !/\s/.test(v);
}

/** The address a pattern opens, when it names one page (no wildcard): for links and the start page. */
export function openable(pattern: string): string | null {
  const v = pattern.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  if (!validPattern(v) || v.includes("*")) return null;
  return `https://${v}`;
}
