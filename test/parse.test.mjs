// Runs against the esbuild-bundled pure module (see package.json "test").
import test from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One flat namespace over every pure module. Provider IO names (readLimits, usageAccounts) collide and are
// dropped by `export *`, which is fine: tests only touch pure functions. Obsidian is stubbed: nothing here touches it.
const dir = mkdtempSync(join(tmpdir(), "aiu-"));
const stub = join(dir, "obsidian.mjs");
writeFileSync(stub, "export const requestUrl = () => { throw new Error('stub'); };\n");
const out = join(dir, "pure.mjs");
const MODULES = ["model", "format", "chart", "usage", "providers/claude", "providers/codex", "providers/kimi", "providers/opencode"];
buildSync({
  stdin: { contents: MODULES.map((m) => `export * from "./src/${m}";`).join("\n"), resolveDir: process.cwd(), loader: "ts" },
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent", alias: { obsidian: stub },
});
const D = await import(out);

const NOW = 1_800_000_000; // epoch s
const day = (period, agents) => ({ period, totalTokens: agents.reduce((s, a) => s + a.totalTokens, 0), totalCost: agents.reduce((s, a) => s + a.totalCost, 0), agents });
const ag = (agent, totalTokens, totalCost = 0, models = []) => ({ agent, totalTokens, totalCost, models });

test("limit whose reset already passed shows 0%", () => {
  assert.equal(D.effectivePct(75, NOW - 10, NOW), 0);
  assert.equal(D.effectivePct(75, NOW + 10, NOW), 75);
  assert.equal(D.effectivePct(130, null, NOW), 100);
  const claude = D.parseClaudeLimits({ rate_limits: { five_hour: { used_percentage: 40, resets_at: NOW - 1 }, seven_day: { used_percentage: 55, resets_at: NOW + 100 } } }, NOW);
  assert.deepEqual(claude.map((l) => [l.label, l.pct]), [["claude 5h", 0], ["claude 7d", 55]]);
  assert.deepEqual(D.parseClaudeLimits({}, NOW), []);
});

test("codex window labels and null secondary", () => {
  assert.equal(D.windowLabel(10080), "7d");
  assert.equal(D.windowLabel(300), "5h");
  assert.equal(D.windowLabel(1440), "1d");
  const line = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_at: NOW + 60 }, secondary: null } } });
  const lims = D.parseCodexLine(line, NOW);
  assert.deepEqual(lims.map((l) => [l.label, l.pct]), [["codex 5h", 12.5]]);
  assert.equal(D.parseCodexLine("not json", NOW).length, 0);
  const text = 'x\n{"token_count":1,"rate_limits":{}}\n{"other":1}\n{"rate_limits":2,"token_count":3}\n';
  assert.equal(D.lastRateLimitLine(text), '{"rate_limits":2,"token_count":3}');
  assert.equal(D.lastRateLimitLine("nope"), null);
});

test("ccusage parse + agent filter recomputes totals", () => {
  const days = D.parseCcusage({ daily: [
    { period: "2026-10-02", totalTokens: 30, totalCost: 3, agents: [{ agent: "claude", totalTokens: 10, totalCost: 1, modelBreakdowns: [{ modelName: "m", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4, cost: 1 }] }, { agent: "codex", totalTokens: 20, totalCost: 2 }] },
    { period: "2026-10-01", totalTokens: 5, totalCost: 0.5, agents: [{ agent: "codex", totalTokens: 5, totalCost: 0.5 }] },
  ] });
  assert.deepEqual(days.map((d) => d.period), ["2026-10-01", "2026-10-02"]);
  assert.equal(days[1].agents[0].models[0].cacheReadTokens, 3);
  assert.deepEqual(D.agentsOf(days), ["claude", "codex"]);
  const only = D.filterByAgent(days, "claude");
  assert.equal(only.length, 1);
  assert.equal(only[0].totalTokens, 10);
  assert.equal(only[0].totalCost, 1);
  assert.equal(D.filterByAgent(days, null), days);
  assert.deepEqual(D.parseCcusage(null), []);
});

test("number formats", () => {
  assert.equal(D.formatTokens(12_300_000), "12.3M");
  assert.equal(D.formatTokens(845_000), "845K");
  assert.equal(D.formatTokens(1_000), "1K");
  assert.equal(D.formatTokens(999), "999");
  assert.equal(D.formatTokens(2_500_000_000), "2.5B");
  assert.equal(D.formatCost(1.2345), "$1.23");
  assert.equal(D.formatCost(123.4), "$123");
  assert.equal(D.formatMetric(5, "cost"), "$5.00");
});

test("missing days are filled with zeros, series and kpis align", () => {
  const today = new Date(2026, 9, 17);
  const days = [day("2026-10-17", [ag("claude", 10, 1)]), day("2026-10-15", [ag("codex", 5, 0.5)]), day("2026-09-30", [ag("claude", 100, 9)])];
  const last = D.lastDays(days, 3, today);
  assert.deepEqual(last.map((d) => [d.period, d.totalTokens]), [["2026-10-15", 5], ["2026-10-16", 0], ["2026-10-17", 10]]);
  assert.deepEqual(D.seriesByAgent(last, ["claude", "codex"], "tokens"), { claude: [0, 0, 10], codex: [5, 0, 0] });
  assert.deepEqual(D.seriesByAgent(last, ["codex"], "cost"), { codex: [0.5, 0, 0] });
  const k = D.kpis(days, today);
  assert.deepEqual(k.today, { tokens: 10, cost: 1 });
  assert.deepEqual(k.last7, { tokens: 15, cost: 1.5 });
  assert.deepEqual(k.last30, { tokens: 115, cost: 10.5 }); // 09-30 is within 30 days of 10-17
  assert.deepEqual(k.month, { tokens: 15, cost: 1.5 });     // calendar month excludes 09-30
});

test("model totals and per-model series", () => {
  const mo = (modelName, inputTokens, outputTokens, cost = 0) => ({ modelName, inputTokens, outputTokens, cacheReadTokens: 1, cacheCreationTokens: 2, cost });
  const days = [
    day("2026-10-16", [ag("claude", 0, 0, [mo("opus", 10, 5, 2), mo("haiku", 1, 1, 0.1)]), ag("codex", 0, 0, [mo("gpt", 30, 0)])]),
    day("2026-10-17", [ag("claude", 0, 0, [mo("opus", 1, 1, 1), { ...mo("zero", 0, 0), cacheReadTokens: 0, cacheCreationTokens: 0 }])]),
  ];
  assert.deepEqual(D.modelTotals(days, "tokens"), [
    { model: "gpt", agent: "codex", value: 33 }, { model: "opus", agent: "claude", value: 23 }, { model: "haiku", agent: "claude", value: 5 },
  ]);
  assert.deepEqual(D.modelTotals(days, "cost").map((t) => [t.model, t.value]), [["opus", 3], ["haiku", 0.1]]); // codex cost 0 dropped
  assert.deepEqual(D.seriesByModel(days, "tokens", 2), { gpt: [33, 0], opus: [18, 5], other: [5, 0] });
  assert.deepEqual(D.seriesByModel(days, "tokens"), { gpt: [33, 0], opus: [18, 5], haiku: [5, 0] }); // no "other" when nothing is left over
});

test("reset labels and live countdown", () => {
  const now = new Date(2026, 9, 17, 12, 0, 0); // Sat
  const sec = Math.floor(now.getTime() / 1000);
  assert.equal(D.formatReset(sec + 8 * 3600 + 10 * 60, now), "resets 20:10");
  assert.equal(D.formatReset(sec + 21 * 3600, now), "resets Sun 09:00");
  assert.equal(D.formatReset(null, now), "no reset time");
  assert.equal(D.countdown(sec + 60 * 12, sec), "12m");
  assert.equal(D.countdown(sec + 3600 + 5 * 60, sec), "1h 05m");
  assert.equal(D.countdown(sec + 2 * 86400 + 3 * 3600, sec), "2d 3h");
  assert.equal(D.countdown(sec - 1, sec), "now");
});

test("kimi usages payload: string numbers, window units, weekly dedupe, expired reset", () => {
  const iso = (sec) => new Date(sec * 1000).toISOString();
  const payload = {
    usage: { used: "250", limit: "1000", resetTime: iso(NOW + 3600), name: "weekly" },
    limits: [
      { name: "five-hour", window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { used: 40, limit: "80", resetTime: iso(NOW + 600) } },
      { window: { duration: 1, timeUnit: "TIME_UNIT_WEEK" }, detail: { used: 900, limit: 1000, resetTime: iso(NOW + 7200) } },
      { window: { duration: 2, timeUnit: "TIME_UNIT_DAY" }, detail: { used: 10, limit: 100, resetTime: iso(NOW - 5) } },
    ],
  };
  const lims = D.parseKimiUsage(payload, NOW);
  assert.deepEqual(lims.map((l) => [l.label, l.pct, l.windowMinutes]), [["kimi 5h", 50, 300], ["kimi 7d", 90, 10080], ["kimi 2d", 0, 2880]]);
  assert.equal(lims[0].resetsAt, NOW + 600);
  assert.equal(lims.every((l) => l.agent === "kimi"), true);
  // usage only -> one weekly gauge; zero limit -> 0%
  assert.deepEqual(D.parseKimiUsage({ usage: { used: 5, limit: 0, resetTime: "bad" } }, NOW).map((l) => [l.label, l.pct, l.resetsAt]), [["kimi 7d", 0, null]]);
  assert.deepEqual(D.parseKimiUsage(null, NOW), []);
  assert.equal(D.windowLabel(90), "90m");
  assert.equal(D.windowLabel(1500), "25h");
});

test("kimi credential picking: shapes, expiry units, explicit reasons (no values leaked)", () => {
  const F = (name, json, mtimeSec = 0) => ({ name, mtimeSec, json });
  const dir = "~/.kimi-code/credentials";
  assert.deepEqual(D.pickKimiCred([], dir), { reason: `no credentials in ${dir}` });
  // flat OAuth file, expires_at seconds
  let c = D.pickKimiCred([F("a.json", { access_token: "T1", refresh_token: "R", expires_at: NOW + 60, expires_in: 900 })], dir);
  assert.deepEqual(c, { token: "T1", expiresAt: NOW + 60, expiryField: "expires_at", file: "a.json" });
  // ms + camelCase, and ISO string
  assert.equal(D.pickKimiCred([F("b.json", { accessToken: "T2", expiresAt: (NOW + 5) * 1000 })], dir).expiresAt, NOW + 5);
  assert.equal(D.pickKimiCred([F("c.json", { access_token: "T3", expires_at: new Date((NOW + 7) * 1000).toISOString() })], dir).expiresAt, NOW + 7);
  // expires_in only -> relative to file mtime
  c = D.pickKimiCred([F("d.json", { access_token: "T4", expires_in: 100 }, NOW)], dir);
  assert.equal(c.expiresAt, NOW + 100); assert.equal(c.expiryField, "expires_in+mtime");
  // nested under provider key
  c = D.pickKimiCred([F("e.json", { kimi: { access_token: "T5", expires_at: NOW + 9 }, other: 1 })], dir);
  assert.equal(c.token, "T5"); assert.equal(c.expiryField, "kimi.expires_at");
  // no expiry at all -> still usable, field "none"
  assert.deepEqual(D.pickKimiCred([F("f.json", { token: "T6" })], dir), { token: "T6", expiresAt: null, expiryField: "none", file: "f.json" });
  // several files: latest expiry wins; empty token file is skipped
  c = D.pickKimiCred([F("old.json", { access_token: "", expires_at: 0 }), F("new.json", { access_token: "T7", expires_at: NOW + 1 }), F("mid.json", { access_token: "T8", expires_at: NOW - 1 })], dir);
  assert.equal(c.file, "new.json");
  // no token field: reason lists key names only, never values
  const r = D.pickKimiCred([F("g.json", { id_token: "SECRETVALUE", expires_at: 1 }), F("h.json", null)], dir);
  assert.equal(r.reason, "g.json: no access token (keys: id_token, expires_at); h.json: not a JSON object");
  assert.equal(r.reason.includes("SECRETVALUE"), false);
  // email-like fields by key name; /me falls back to a display name
  assert.equal(D.emailFromObj({ access_token: "t", user: { email: "u@x.io" } }), "u@x.io");
  assert.equal(D.emailFromObj({ account: { email: "a@x.io" } }), "a@x.io");
  assert.equal(D.emailFromObj({ access_token: "t" }), null);
  assert.equal(D.kimiIdentity({ user_id: "1", email: "me@kimi.io", nickname: "n" }), "me@kimi.io");
  assert.equal(D.kimiIdentity({ user_id: "1", nickname: "nick" }), "nick");
  assert.equal(D.kimiIdentity({ user_id: "1" }), null);
  assert.equal(D.toEpochSec("1800000000"), 1800000000);
  assert.equal(D.toEpochSec("garbage"), null);
});

test("multi-account claude: labels, missing dir/file handling", () => {
  const rl = (h5, d7) => ({ rate_limits: { five_hour: { used_percentage: h5, resets_at: NOW + 100 }, seven_day: { used_percentage: d7, resets_at: NOW + 1000 } } });
  const r = D.claudeAccounts([
    { name: "claude 1", dirExists: true, json: rl(60, 30) },
    { name: "claude 2", dirExists: true, json: null },          // dir exists, no file yet
    { name: "claude 3", dirExists: false, json: null },         // dir missing -> silent
    { name: "claude 4", dirExists: true, json: rl(10, 45) },
    { name: "claude 5", dirExists: true, json: { nope: 1 } },   // file without rate_limits -> no data
  ], NOW);
  assert.deepEqual(r.limits.map((l) => [l.label, l.pct, l.account, l.agent]), [
    ["claude 1 5h", 60, "claude 1", "claude"], ["claude 1 7d", 30, "claude 1", "claude"],
    ["claude 4 5h", 10, "claude 4", "claude"], ["claude 4 7d", 45, "claude 4", "claude"],
  ]);
  assert.deepEqual(r.noData, ["claude 2", "claude 5"]);
  // email: only oauthAccount.emailAddress, must look like an email
  assert.equal(D.emailFromClaudeJson({ oauthAccount: { emailAddress: " a@b.co ", fullName: "x" }, other: 1 }), "a@b.co");
  assert.equal(D.emailFromClaudeJson({ oauthAccount: { emailAddress: "nope" } }), null);
  assert.equal(D.emailFromClaudeJson({ emailAddress: "top@level.io" }), null);
  assert.equal(D.emailFromClaudeJson(null), null);
  // single legacy call keeps the plain "claude" label
  assert.equal(D.parseClaudeLimits(rl(1, 2), NOW)[0].label, "claude 5h");
});

test("multi-account codex: limits per home, fake-JWT email, codex daily merge", () => {
  const line = (pct) => JSON.stringify({ payload: { type: "token_count", rate_limits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: NOW + 50 }, secondary: null } } });
  const r = D.codexAccounts([
    { name: "codex 1", homeExists: true, line: line(12) },
    { name: "codex 2", homeExists: true, line: null },      // home exists, no session yet
    { name: "codex 3", homeExists: false, line: null },     // missing -> silent
  ], NOW);
  assert.deepEqual(r.limits.map((l) => [l.label, l.pct, l.account]), [["codex 1 7d", 12, "codex 1"]]);
  assert.deepEqual(r.noData, ["codex 2"]);
  assert.equal(D.parseCodexLine(line(1), NOW)[0].label, "codex 7d");
  // JWT: payload only, base64url, no padding; token value never echoed
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64u({ alg: "none" })}.${b64u({ email: "me@example.com", sub: "x" })}.sig`;
  assert.equal(D.emailFromJwt(jwt), "me@example.com");
  assert.equal(D.emailFromJwt(`${b64u({})}.${b64u({ "https://api.openai.com/profile": { email: "p@x.io" } })}.s`), "p@x.io");
  assert.equal(D.emailFromJwt(`${b64u({})}.${b64u({ sub: "nomail" })}.s`), null);
  assert.equal(D.emailFromJwt("garbage"), null);
  assert.equal(D.emailFromJwt(undefined), null);
  // codex daily -> single codex agent with model rows (cost 0 per model, cost on the agent)
  const extra = D.parseCodexDaily({ daily: [{ date: "2026-10-02", totalTokens: 7, costUSD: 0.7, models: { "gpt-x": { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 0 } } }, { date: "2026-10-03", totalTokens: 5, costUSD: 0.5, models: {} }], totals: {} });
  assert.deepEqual(extra.map((d) => [d.period, d.agents[0].agent, d.agents[0].models[0]?.modelName, d.totalCost]), [["2026-10-02", "codex", "gpt-x", 0.7], ["2026-10-03", "codex", undefined, 0.5]]);
  assert.deepEqual(D.parseCodexDaily(null), []);
  // merge: same agent same day summed, new day created, other agents untouched, input not mutated
  const base = [day("2026-10-02", [ag("claude", 10, 1), ag("codex", 20, 2)])];
  const merged = D.mergeUsage(base, extra);
  assert.deepEqual(merged.map((d) => [d.period, d.totalTokens, d.totalCost, d.agents.map((a) => [a.agent, a.totalTokens]).sort()]), [
    ["2026-10-02", 37, 3.7, [["claude", 10], ["codex", 27]]],
    ["2026-10-03", 5, 0.5, [["codex", 5]]],
  ]);
  assert.equal(merged[0].agents.find((a) => a.agent === "codex").models.length, 1);
  assert.equal(base[0].agents[1].totalTokens, 20);
});

test("opencode daily: one opencode agent, per-model cost kept, bad rows dropped", () => {
  const oc = D.parseOpencodeDaily({ daily: [{ date: "2026-09-23", totalTokens: 9, totalCost: 0.9, modelBreakdowns: [{ modelName: "custom", inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 0, cost: 0 }, { modelName: "m2", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, cost: 0.9 }] }, { date: "bogus", totalTokens: 1 }] });
  assert.deepEqual(oc.map((d) => [d.period, d.totalCost, d.agents[0].agent, d.agents[0].models.map((m) => [m.modelName, m.cost])]), [["2026-09-23", 0.9, "opencode", [["custom", 0], ["m2", 0.9]]]]);
  assert.deepEqual(D.parseOpencodeDaily(null), []);
});

test("kimi cache: fresh fetch replaces, stale reuse zeroes passed windows, no cache -> null", () => {
  const lim = (label, pct, resetsAt) => ({ agent: "kimi", label, pct, resetsAt, windowMinutes: 300 });
  const fresh = { limits: [lim("kimi 5h", 40, NOW + 100)], email: "k@x.io" };
  const r1 = D.resolveKimi(fresh, { limits: [lim("kimi 5h", 99, NOW + 1)], email: "old@x.io", fetchedAt: NOW - 999 }, NOW);
  assert.deepEqual(r1, { cache: { limits: fresh.limits, email: "k@x.io", fetchedAt: NOW }, stale: false });
  const cache = { limits: [lim("kimi 5h", 70, NOW - 1), lim("kimi 7d", 55, NOW + 500)], email: "k@x.io", fetchedAt: NOW - 600 };
  const r2 = D.resolveKimi(null, cache, NOW);
  assert.equal(r2.stale, true);
  assert.equal(r2.cache.fetchedAt, NOW - 600);
  assert.deepEqual(r2.cache.limits.map((l) => [l.label, l.pct]), [["kimi 5h", 0], ["kimi 7d", 55]]);
  assert.equal(cache.limits[0].pct, 70); // input not mutated
  assert.equal(D.resolveKimi(null, null, NOW), null);
  assert.equal(D.resolveKimi(null, { bogus: true }, NOW), null);
});

test("per-account usage: session mapping, period filter, totals", () => {
  const today = new Date(2026, 9, 17);
  const accountOf = D.sessionAccountMap([{ name: "claude 1", ids: ["s1", " s2 "] }, { name: "claude 2", ids: ["s3", "s1"] }], "claude 1");
  assert.equal(accountOf("s1"), "claude 1"); // first list wins on duplicates
  assert.equal(accountOf("s2"), "claude 1");
  assert.equal(accountOf("s3"), "claude 2");
  assert.equal(accountOf("unknown"), "claude 1");
  // date-bounded session report -> totals per account (ids mapped, unknown -> fallback)
  const tot = D.sessionTotals({ sessions: [
    { sessionId: "s3", totalTokens: 100, totalCost: 1 }, { sessionId: "zzz", totalTokens: 50, totalCost: 0.5 }, { sessionId: "s1", totalTokens: 7, totalCost: 0.1 },
  ] }, accountOf);
  assert.deepEqual(tot.sort((a, b) => a.account.localeCompare(b.account)), [{ account: "claude 1", tokens: 57, cost: 0.6 }, { account: "claude 2", tokens: 100, cost: 1 }]);
  assert.deepEqual(D.sessionTotals(null, accountOf), []);
  const codex = D.agentAsAccount([day("2026-10-17", [ag("codex", 30, 3), ag("kimi", 0, 0)]), day("2026-10-16", [ag("codex", 5, 0.5)])], "codex", "codex 1");
  assert.deepEqual(codex.map((r) => [r.period, r.account, r.tokens]), [["2026-10-17", "codex 1", 30], ["2026-10-16", "codex 1", 5]]);
  assert.deepEqual(D.agentAsAccount([day("2026-10-17", [ag("kimi", 0, 0)])], "kimi", "kimi"), []); // zero rows dropped
  const periodRows = [
    { period: "today", account: "claude 2", agent: "claude", tokens: 100, cost: 1 },
    { period: "last7", account: "claude 2", agent: "claude", tokens: 100, cost: 1 }, { period: "last7", account: "claude 1", agent: "claude", tokens: 50, cost: 0.5 },
  ];
  assert.deepEqual(D.accountTotals(codex, periodRows, "today", today, "tokens", null), [{ account: "claude 2", agent: "claude", value: 100 }, { account: "codex 1", agent: "codex", value: 30 }]);
  assert.deepEqual(D.accountTotals(codex, periodRows, "last7", today, "cost", "codex"), [{ account: "codex 1", agent: "codex", value: 3.5 }]);
  assert.deepEqual(D.accountTotals(codex, periodRows, "last7", today, "tokens", "claude").map((a) => [a.account, a.value]), [["claude 2", 100], ["claude 1", 50]]);
  assert.deepEqual(D.periodBounds("today", today), { since: "2026-10-17", until: "2026-10-17" });
  assert.deepEqual(D.periodBounds("last7", today), { since: "2026-10-11", until: "2026-10-17" });
  assert.deepEqual(D.periodBounds("month", today), { since: "2026-10-01", until: "2026-10-17" });
  assert.equal(D.periodFilter("month", today)("2026-09-30"), false);
  assert.equal(D.periodFilter("month", today)("2026-10-01"), true);
});

test("breakdown rows sum to the card total for every period and metric", () => {
  const today = new Date(2026, 9, 17);
  const days = [
    day("2026-10-17", [ag("claude", 100, 10), ag("codex", 30, 3)]),
    day("2026-10-12", [ag("claude", 40, 4), ag("codex", 5, 0.5), ag("kimi", 1, 0.1)]),
    day("2026-10-01", [ag("claude", 200, 20)]),
    day("2026-09-20", [ag("claude", 999, 99), ag("codex", 999, 99)]),
  ];
  // daily rows for codex/kimi; claude as period rows, as the date-bounded session reports would return them
  const daily = [...D.agentAsAccount(days, "codex", "codex 1"), ...D.agentAsAccount(days, "kimi", "kimi")];
  const periodRows = D.KPI_PERIODS.flatMap((period) => {
    const inP = D.periodFilter(period, today);
    const t = days.filter((d) => inP(d.period)).flatMap((d) => d.agents.filter((a) => a.agent === "claude"));
    return [{ period, account: "claude 1", agent: "claude", tokens: t.reduce((s, a) => s + a.totalTokens, 0), cost: t.reduce((s, a) => s + a.totalCost, 0) }];
  });
  const k = D.kpis(days, today);
  for (const period of D.KPI_PERIODS) for (const metric of ["tokens", "cost"]) {
    const sum = D.accountTotals(daily, periodRows, period, today, metric, null).reduce((s, a) => s + a.value, 0);
    assert.ok(Math.abs(sum - k[period][metric]) < 1e-9, `${period}/${metric}: ${sum} != ${k[period][metric]}`);
  }
  // and with the agent filter, the sum equals the filtered card total
  const onlyClaude = D.filterByAgent(days, "claude");
  assert.equal(D.accountTotals(daily, periodRows, "last30", today, "tokens", "claude").reduce((s, a) => s + a.value, 0), D.kpis(onlyClaude, today).last30.tokens);
});

test("review fixes: one date snapshot, surfaced report failures, colors for period-only agents", async () => {
  // (1) the report bounds a period was fetched with cover exactly the days the card/breakdown filter accepts,
  //     for the SAME snapshot date — so deriving both from one asOf keeps them consistent across midnight.
  for (const asOf of [new Date(2026, 9, 17), new Date(2026, 9, 18, 0, 5)]) {
    for (const period of D.KPI_PERIODS) {
      const { since, until } = D.periodBounds(period, asOf);
      const inP = D.periodFilter(period, asOf);
      const dayBefore = D.lastDays([], 2, new Date(since + "T12:00"))[0].period;
      assert.equal(inP(since), true, `${period} since`); assert.equal(inP(until), true, `${period} until`);
      assert.equal(inP(dayBefore), false, `${period} day before since`);
    }
  }
  // (2) a failing per-period report is reported, not swallowed; other periods still return rows
  const run = async (args) => { if (args.includes("20261011")) throw new Error("boom"); return { sessions: [{ sessionId: "x", totalTokens: 5, totalCost: 0.5 }] }; };
  const r = await D.usageByPeriod(run, [], new Date(2026, 9, 17));
  assert.deepEqual(r.failed, ["last7"]);
  assert.deepEqual(r.rows.map((x) => x.period).sort(), ["last30", "month", "today"]);
  assert.equal(r.rows[0].account, "claude 1");
  // (3) agents for the color map come from daily AND period rows
  const daily = [{ period: "2026-10-17", account: "codex 1", agent: "codex", tokens: 1, cost: 0 }];
  const periodRows = [{ period: "today", account: "claude 1", agent: "claude", tokens: 1, cost: 0 }];
  assert.deepEqual(D.accountAgents(daily, periodRows), ["claude", "codex"]);
  assert.equal(D.colorMap(D.accountAgents(daily, periodRows)).claude, "#f59e0b");
});

test("colors and chart points", () => {
  assert.equal(D.gaugeColor(49), "#22c55e");
  assert.equal(D.gaugeColor(50), "#f59e0b");
  assert.equal(D.gaugeColor(80), "#ef4444");
  assert.deepEqual(D.colorMap(["claude", "foo", "bar", "codex"]), { claude: "#f59e0b", foo: "#a855f7", bar: "#ef4444", codex: "#3b82f6" });
  assert.equal(D.linePoints([0, 5, 10], 10, 0, 100, 0, 50), "0.0,50.0 50.0,25.0 100.0,0.0");
  assert.equal(D.linePoints([0, 0], 0, 0, 100, 0, 50), "0.0,50.0 100.0,50.0");
});
