// 保存データ(Netlify Blobs)と、自動出品の判断ロジック
import { getStore } from "@netlify/blobs";
import { randomUUID } from "node:crypto";
import { computeSlots, dayKey, minuteOfDay, publishDraft, checkSold } from "./gc.mjs";

export const DEFAULT_SETTINGS = {
  paused: true, // 最初は止まった状態で始めます
  dailyLimit: 15,
  graceMin: 25, // 予定時刻を過ぎてから何分以内なら出品するか
  limitHours: 24, // 出品期限 = 出品時刻 + この時間(0なら下書きの値のまま)
  schedule: { mode: "interval", start: "00:00", end: "24:00", count: 15, manual: [] },
  discordWebhook: "",
  autoSold: { enabled: false, keywords: ["SOLD OUT", "売り切れ", "取引中"] },
};
const DEFAULT_STATE = { pointer: 0, days: {}, alert: null, lastTick: null };
const MAX_LOGS = 3000;

const store = () => getStore({ name: "gc-scheduler", consistency: "strong" });

export async function load(key) {
  const v = await store().get(key, { type: "json" });
  if (key === "settings") return { ...DEFAULT_SETTINGS, ...(v || {}), schedule: { ...DEFAULT_SETTINGS.schedule, ...(v?.schedule || {}) }, autoSold: { ...DEFAULT_SETTINGS.autoSold, ...(v?.autoSold || {}) } };
  if (key === "state") return { ...DEFAULT_STATE, ...(v || {}) };
  if (key === "drafts" || key === "logs") return v || [];
  if (key === "secret") return v || {};
  return v;
}
export const save = (key, val) => store().setJSON(key, val);

export async function notify(settings, content) {
  if (!settings.discordWebhook) return;
  try {
    await fetch(settings.discordWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: content.slice(0, 1900) }) });
  } catch {}
}

export function nextDraftIndex(drafts, pointer) {
  const n = drafts.length;
  for (let i = 0; i < n; i++) {
    const idx = (pointer + i) % n;
    if (drafts[idx].enabled) return idx;
  }
  return -1;
}

const STOP_KINDS = ["session", "blocked"];

export async function publishNext({ now = Date.now(), draftKey = null, slot = null, manual = false } = {}) {
  const [settings, secret, drafts, state, logs] = await Promise.all([load("settings"), load("secret"), load("drafts"), load("state"), load("logs")]);
  const dk = dayKey(now);
  const day = (state.days[dk] ||= { count: 0, slots: {} });

  const finish = async (result, draft) => {
    if (slot != null) {
      const prev = day.slots[slot] || { attempts: 0 };
      const attempts = prev.attempts + 1;
      const giveUp = result.ok || attempts >= 2 || ["limit", "empty", "nosession", ...STOP_KINDS].includes(result.kind);
      day.slots[slot] = { status: result.ok ? "done" : giveUp ? "failed" : "retry", attempts, at: now, message: result.ok ? undefined : result.message };
    }
    if (draft || !result.ok) {
      logs.unshift({
        id: randomUUID(),
        at: now,
        draftKey: draft?.key || null,
        label: draft?.label || "(下書きなし)",
        ok: !!result.ok,
        kind: result.kind || null,
        message: result.ok ? null : result.message,
        listingId: result.listingId || null,
        url: result.url || null,
        manual,
        sold: false,
      });
      if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
    }
    await Promise.all([save("state", state), save("drafts", drafts), save("logs", logs)]);
    return { ...result, label: draft?.label };
  };

  if (!secret.phpsessid) return finish({ ok: false, kind: "nosession", message: "ログイン情報(PHPSESSID)が未登録です。" });
  if (day.count >= settings.dailyLimit) return finish({ ok: false, kind: "limit", message: `今日の上限(${settings.dailyLimit}回)に達しています。` });

  let idx;
  if (draftKey) idx = drafts.findIndex((d) => d.key === draftKey);
  else idx = nextDraftIndex(drafts, state.pointer);
  if (idx < 0) return finish({ ok: false, kind: "empty", message: "出品できる下書きがありません。下書きを追加するか、有効にしてください。" });
  const draft = drafts[idx];

  const result = await publishDraft(draft, secret.phpsessid, { limitHours: settings.limitHours, now });
  if (result.ok) {
    day.count++;
    draft.publishedCount = (draft.publishedCount || 0) + 1;
    draft.lastPublishedAt = now;
    if (!draft.repeat) draft.enabled = false;
    if (!draftKey) state.pointer = (idx + 1) % drafts.length;
    if (state.alert && STOP_KINDS.includes(state.alert.kind)) state.alert = null;
  } else if (STOP_KINDS.includes(result.kind)) {
    state.alert = { kind: result.kind, message: result.message, at: now };
    await notify(settings, `⚠️ ゲームクラブ自動出品: ${result.message}`);
  } else {
    await notify(settings, `⚠️ 出品に失敗しました(${draft.label}): ${result.message}`);
  }
  return finish(result, draft);
}

// 5分おきに呼ばれる
export async function tick(now = Date.now()) {
  const settings = await load("settings");
  const state = await load("state");
  state.lastTick = now;

  // 古い日付の記録を整理(14日分だけ残す)
  const keys = Object.keys(state.days).sort();
  while (keys.length > 14) delete state.days[keys.shift()];

  if (settings.paused) {
    await save("state", state);
    return { skipped: "paused" };
  }

  const slots = computeSlots(settings.schedule, settings.dailyLimit);
  const dk = dayKey(now);
  const m = minuteOfDay(now);
  const day = (state.days[dk] ||= { count: 0, slots: {} });
  let due = null;
  for (const s of slots) {
    if (s > m) break;
    const st = day.slots[s];
    if (st && st.status !== "retry") continue;
    if (m - s > settings.graceMin) {
      day.slots[s] = { status: "skipped", at: now, attempts: st?.attempts || 0, message: "予定時刻から時間が経ちすぎたため見送りました。" };
      continue;
    }
    due = s;
    break;
  }
  await save("state", state);

  const out = { due };
  if (due != null) out.publish = await publishNext({ now, slot: due });
  if (settings.autoSold.enabled) out.soldChecks = await runSoldChecks(now, settings);
  return out;
}

async function runSoldChecks(now, settings) {
  const secret = await load("secret");
  if (!secret.phpsessid) return 0;
  const logs = await load("logs");
  const targets = logs
    .filter((l) => l.ok && l.url && !l.sold && now - l.at < 7 * 86400e3 && (!l.lastCheckedAt || now - l.lastCheckedAt > 3 * 3600e3))
    .slice(0, 4);
  for (const l of targets) {
    try {
      const sold = await checkSold(l.url, secret.phpsessid, settings.autoSold.keywords);
      l.lastCheckedAt = now;
      if (sold) {
        l.sold = true;
        l.soldAt = now;
        l.soldBy = "auto";
      }
    } catch {
      l.lastCheckedAt = now;
    }
  }
  if (targets.length) await save("logs", logs);
  return targets.length;
}
