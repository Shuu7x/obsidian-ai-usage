// Kimi provider: plan limits from GET <base>/usages with the kimi CLI's access token, email from /me.
// SECURITY: credentials are read-only (never refreshed/rewritten), the token is sent only to the kimi base URL,
// and nothing returned or cached ever contains it.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { requestUrl } from "obsidian";
import { Limit } from "../model";
import { effectivePct, hhmm, isoToSec, toEpochSec, windowLabel } from "../format";

// ---------- pure ----------

const toInt = (v: unknown): number => {
  const n = typeof v === "string" ? parseInt(v, 10) : typeof v === "number" ? v : NaN;
  return isFinite(n) ? n : 0;
};
const KIMI_UNIT_MIN: Record<string, number> = { TIME_UNIT_MINUTE: 1, TIME_UNIT_HOUR: 60, TIME_UNIT_DAY: 1440, TIME_UNIT_WEEK: 10080 };

/** GET /coding/v1/usages -> limits. `usage` is the weekly window; `limits[]` entries win on label clash. */
export function parseKimiUsage(json: unknown, nowSec: number): Limit[] {
  const j = json as any;
  if (!j || typeof j !== "object") return [];
  const mk = (detail: any, mins: number): Limit | null => {
    if (!detail || typeof detail !== "object") return null;
    const used = toInt(detail.used), limit = toInt(detail.limit);
    const resetsAt = isoToSec(detail.resetTime);
    const pct = limit > 0 ? (used / limit) * 100 : 0;
    return { agent: "kimi", label: `kimi ${windowLabel(mins)}`, pct: effectivePct(pct, resetsAt, nowSec), resetsAt, windowMinutes: mins };
  };
  const out = new Map<string, Limit>();
  for (const l of Array.isArray(j.limits) ? j.limits : []) {
    const mins = toInt(l?.window?.duration) * (KIMI_UNIT_MIN[String(l?.window?.timeUnit)] ?? 1);
    const lim = mk(l?.detail, mins);
    if (lim && mins > 0) out.set(lim.label, lim);
  }
  const weekly = mk(j.usage, 10080);
  if (weekly && !out.has(weekly.label)) out.set(weekly.label, weekly);
  return [...out.values()];
}

/** Email-like field from a credentials or profile object: email, user.email, account.email. Key names only. */
export function emailFromObj(json: unknown): string | null {
  const j = json as any;
  if (!j || typeof j !== "object") return null;
  for (const v of [j.email, j.user?.email, j.account?.email, j.profile?.email]) if (typeof v === "string" && v.includes("@")) return v.trim();
  return null;
}
/** /me response: email, else a display name. */
export function kimiIdentity(json: unknown): string | null {
  const e = emailFromObj(json);
  if (e) return e;
  const j = json as any;
  for (const v of [j?.name, j?.username, j?.nickname]) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

// ---------- credentials (pure) ----------

export interface CredFile { name: string; mtimeSec: number; json: unknown }
export type KimiCred = { token: string; expiresAt: number | null; expiryField: string; file: string } | { reason: string };

const TOKEN_KEYS = ["access_token", "accessToken", "token"];
const EXPIRY_KEYS = ["expires_at", "expiresAt", "expiry", "expires", "expiration"];

/** Find a token object at top level or one level down (e.g. nested under a provider key). */
function findTokenObj(j: any): { obj: any; path: string } | null {
  if (!j || typeof j !== "object") return null;
  if (TOKEN_KEYS.some((k) => typeof j[k] === "string" && j[k])) return { obj: j, path: "" };
  for (const [k, v] of Object.entries(j)) {
    if (v && typeof v === "object" && !Array.isArray(v) && TOKEN_KEYS.some((t) => typeof (v as any)[t] === "string" && (v as any)[t])) return { obj: v, path: k };
  }
  return null;
}

/** Pick the credential with the latest expiry. Messages never include values. */
export function pickKimiCred(files: CredFile[], searchedDir: string): KimiCred {
  if (!files.length) return { reason: `no credentials in ${searchedDir}` };
  let best: KimiCred | null = null;
  const problems: string[] = [];
  for (const f of files) {
    const j = f.json as any;
    if (!j || typeof j !== "object") { problems.push(`${f.name}: not a JSON object`); continue; }
    const hit = findTokenObj(j);
    if (!hit) { problems.push(`${f.name}: no access token (keys: ${Object.keys(j).join(", ") || "none"})`); continue; }
    const o = hit.obj;
    const token = TOKEN_KEYS.map((k) => o[k]).find((v) => typeof v === "string" && v) as string;
    let expiresAt: number | null = null, expiryField = "none";
    for (const k of EXPIRY_KEYS) { const e = toEpochSec(o[k]); if (e !== null) { expiresAt = e; expiryField = k; break; } }
    if (expiresAt === null && typeof o.expires_in === "number" && o.expires_in > 0 && f.mtimeSec > 0) { expiresAt = f.mtimeSec + o.expires_in; expiryField = "expires_in+mtime"; }
    const prefix = hit.path ? `${hit.path}.` : "";
    const cand = { token, expiresAt, expiryField: prefix + expiryField, file: f.name };
    if (!best || "reason" in best || (expiresAt ?? 0) > (best.expiresAt ?? 0)) best = cand;
  }
  return best ?? { reason: problems.join("; ") };
}

/** Last successful kimi fetch, persisted in plugin data. Numbers and email only, never a token. */
export interface KimiCache { limits: Limit[]; email: string | null; fetchedAt: number }
/** Fresh result replaces the cache; otherwise reuse the cache with passed windows shown as 0%. */
export function resolveKimi(fresh: { limits: Limit[]; email: string | null } | null, cache: KimiCache | null | undefined, nowSec: number): { cache: KimiCache; stale: boolean } | null {
  if (fresh) return { cache: { limits: fresh.limits, email: fresh.email, fetchedAt: nowSec }, stale: false };
  if (!cache || !Array.isArray(cache.limits)) return null;
  const limits = cache.limits.map((l) => ({ ...l, pct: effectivePct(l.pct, l.resetsAt, nowSec) }));
  return { cache: { ...cache, limits }, stale: true };
}


// ---------- IO ----------

const KIMI_DIR = path.join(os.homedir(), ".kimi-code", "credentials");

function readKimiCredFiles(): CredFile[] {
  let paths: string[] = [];
  try {
    const st = fs.statSync(KIMI_DIR);
    paths = st.isDirectory() ? fs.readdirSync(KIMI_DIR).filter((f) => f.endsWith(".json")).map((f) => path.join(KIMI_DIR, f)) : [KIMI_DIR];
  } catch { return []; }
  const out: CredFile[] = [];
  for (const p of paths) {
    try {
      const json = JSON.parse(fs.readFileSync(p, "utf8"));
      out.push({ name: path.basename(p), mtimeSec: Math.floor(fs.statSync(p).mtimeMs / 1000), json });
    } catch { out.push({ name: path.basename(p), mtimeSec: 0, json: null }); }
  }
  return out;
}

export type KimiResult = { limits: Limit[]; email: string | null } | { problem: string };

// ponytail: /me is called at most once per plugin load; undefined = not yet asked
let kimiEmailCache: string | null | undefined;

/** Every failure returns a human reason without secrets. "no credentials" means kimi is not set up at all. */
export async function readLimits(nowSec: number): Promise<KimiResult> {
  const files = readKimiCredFiles();
  const cred = pickKimiCred(files, KIMI_DIR.replace(os.homedir(), "~"));
  if ("reason" in cred) return { problem: cred.reason };
  if (kimiEmailCache === undefined) { const e = files.map((f) => emailFromObj(f.json)).find(Boolean); if (e) kimiEmailCache = e; }
  if (cred.expiresAt !== null && cred.expiresAt <= nowSec) return { problem: `token from last kimi run expired ${hhmm(new Date(cred.expiresAt * 1000))} (${cred.expiryField}); run kimi, then refresh` };
  const base = (process.env.KIMI_CODE_BASE_URL || "https://api.kimi.com/coding/v1").replace(/\/$/, "");
  // requestUrl bypasses renderer CORS (app://obsidian.md); global fetch is blocked for this endpoint.
  const headers = { Authorization: `Bearer ${cred.token}`, Accept: "application/json" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("timeout after 8s")), 8000); });
  try {
    const res = await Promise.race([requestUrl({ url: `${base}/usages`, headers, throw: false }), timeout]);
    if (res.status === 401 || res.status === 403) return { problem: `HTTP ${res.status} from usages; run kimi to refresh login` };
    if (res.status < 200 || res.status >= 300) return { problem: `HTTP ${res.status} from usages` };
    let json: unknown;
    try { json = res.json; } catch { json = JSON.parse(res.text); }
    if (kimiEmailCache === undefined) {
      // token just proved valid: ask /me once for the account email (or display name)
      try { const me = await Promise.race([requestUrl({ url: `${base}/me`, headers, throw: false }), timeout]); kimiEmailCache = me.status >= 200 && me.status < 300 ? kimiIdentity(me.json) : null; } catch { kimiEmailCache = null; }
    }
    return { limits: parseKimiUsage(json, nowSec), email: kimiEmailCache ?? null };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return { problem: msg.startsWith("timeout") ? msg : `network error: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}
