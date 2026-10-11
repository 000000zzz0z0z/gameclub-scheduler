// ゲームクラブとの通信と、時刻・スケジュール計算などの「純粋な」処理。
// ストレージには触らないので、単体でテストできます。
import { randomUUID } from "node:crypto";

export const GC = "https://gameclub.jp";
// 正直に自分のツール名を名乗ります(ブラウザのふりはしません)
export const UA = "GCScheduler/1.0 (personal listing scheduler)";

const JST = 9 * 3600e3;
const pad = (n) => String(n).padStart(2, "0");

export function jstParts(ms = Date.now()) {
  const d = new Date(ms + JST);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() };
}
export function dayKey(ms = Date.now()) {
  const p = jstParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`;
}
export function minuteOfDay(ms = Date.now()) {
  const p = jstParts(ms);
  return p.h * 60 + p.mi;
}
export function hm(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}
export function isHM(s) {
  const v = hm(s);
  return Number.isFinite(v) && v >= 0 && v <= 1440;
}

// 1日の出品時刻(0時からの分)を計算
export function computeSlots(schedule, limit) {
  let slots = [];
  if (schedule.mode === "manual") {
    slots = (schedule.manual || []).map(hm).filter((n) => Number.isFinite(n) && n >= 0 && n < 1440);
  } else {
    const n = Math.max(1, Math.min(limit, schedule.count | 0));
    const s = hm(schedule.start);
    const e = hm(schedule.end);
    const span = e - s;
    if (!(span > 0)) return [];
    const step = span / n;
    for (let i = 0; i < n; i++) slots.push(Math.round(s + i * step));
    slots = slots.filter((x) => x < 1440);
  }
  return [...new Set(slots)].sort((a, b) => a - b).slice(0, limit);
}

// DevTools の Payload →「View source」で表示される生データを読み取る
export function parseMultipart(raw) {
  const text = String(raw || "").replace(/\r\n/g, "\n");
  const first = text.split("\n").find((l) => l.startsWith("--"));
  if (!first) throw new Error("区切り線(------WebKitFormBoundary…で始まる行)が見つかりません。Payloadの「View source」の内容を丸ごと貼り付けてください。");
  const boundary = first.trim().replace(/--$/, "");
  const parts = text.split(boundary).slice(1);
  const fields = [];
  for (let part of parts) {
    if (part.startsWith("--")) break;
    part = part.replace(/^\n/, "");
    const idx = part.indexOf("\n\n");
    if (idx < 0) continue;
    const head = part.slice(0, idx);
    const body = part.slice(idx + 2).replace(/\n$/, "");
    const name = (head.match(/name="([^"]*)"/) || [])[1];
    if (name == null) continue;
    const fn = head.match(/filename="([^"]*)"/);
    if (fn) {
      const ct = (head.match(/Content-Type:\s*(.+)/i) || [])[1];
      fields.push({ name, value: "", file: true, filename: fn[1], ctype: (ct || "application/octet-stream").trim() });
    } else {
      fields.push({ name, value: body });
    }
  }
  if (!fields.length) throw new Error("項目を1つも読み取れませんでした。貼り付けた内容を確認してください。");
  if (!fields.some((f) => f.name === "name")) throw new Error("商品名(name)の項目が見つかりません。出品(add?draft=…)の通信のPayloadか確認してください。");
  return fields;
}

export function buildMultipart(fields) {
  const b = "----GCSchedulerBoundary" + randomUUID().replace(/-/g, "");
  let out = "";
  for (const f of fields) {
    out += `--${b}\r\n`;
    if (f.file) {
      out += `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename || ""}"\r\nContent-Type: ${f.ctype || "application/octet-stream"}\r\n\r\n\r\n`;
    } else {
      out += `Content-Disposition: form-data; name="${f.name}"\r\n\r\n${String(f.value ?? "").replace(/\r?\n/g, "\r\n")}\r\n`;
    }
  }
  out += `--${b}--\r\n`;
  return { body: new TextEncoder().encode(out), contentType: `multipart/form-data; boundary=${b}` };
}

// 出品期限(limit_day / limit_time)を出品時刻から自動計算。limitHours=0 なら下書きの値のまま
export function prepareFields(fields, now, limitHours) {
  if (!limitHours) return fields;
  const p = jstParts(now + limitHours * 3600e3);
  return fields.map((f) => {
    if (f.name === "limit_day") return { ...f, value: `${p.y}-${pad(p.mo)}-${pad(p.d)}` };
    if (f.name === "limit_time") return { ...f, value: String(p.h) };
    return f;
  });
}

function cleanSession(s) {
  return String(s || "").trim().replace(/^PHPSESSID=/i, "").replace(/;.*$/, "").trim();
}

async function gcFetch(path, session, opts = {}) {
  return fetch(GC + path, {
    ...opts,
    redirect: "manual",
    headers: { "User-Agent": UA, "Accept-Language": "ja", Cookie: `PHPSESSID=${cleanSession(session)}`, ...(opts.headers || {}) },
  });
}

async function readRes(res) {
  const text = await res.text().catch(() => "");
  const location = res.headers.get("location") || "";
  const cf =
    !!res.headers.get("cf-mitigated") || /Just a moment|cf-chl|challenge-platform|Attention Required/i.test(text);
  let kind = "ok";
  if (cf && [403, 429, 503].includes(res.status)) kind = "blocked";
  else if (res.status >= 300 && res.status < 400) kind = /login/i.test(location) ? "session" : "redirect";
  return { kind, status: res.status, text, location };
}

const plain = (html) =>
  String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function summarizeErrors(j) {
  if (j.errors && typeof j.errors === "object") return Object.values(j.errors).flat().join(" / ");
  if (j.message) return String(j.message);
  if (j.error) return String(j.error);
  return JSON.stringify(j).slice(0, 300);
}

export async function publishDraft(draft, session, { limitHours = 24, now = Date.now() } = {}) {
  const fields = prepareFields(draft.fields, now, limitHours);
  const { body, contentType } = buildMultipart(fields);
  const path = `/mypage/products/add?draft=${encodeURIComponent(draft.draftId)}`;
  let res;
  try {
    res = await gcFetch(path, session, {
      method: "POST",
      body,
      headers: {
        "Content-Type": contentType,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Origin: GC,
        Referer: GC + path,
      },
    });
  } catch (e) {
    return { ok: false, kind: "network", message: `通信できませんでした(${e.message})` };
  }
  const r = await readRes(res);
  if (r.kind === "blocked") return { ok: false, kind: "blocked", status: r.status, message: "Cloudflareにアクセスを拒否されました。サーバーからの自動出品はできない可能性があります。" };
  if (r.kind === "session") return { ok: false, kind: "session", status: r.status, message: "ログイン状態が切れています。設定からPHPSESSIDを貼り直してください。" };
  let json = null;
  try { json = JSON.parse(r.text); } catch {}
  if (res.status === 200 && json && typeof json.location === "string" && /complete=1/.test(json.location)) {
    const m = json.location.match(/\/([A-Za-z0-9_-]+)\/(\d+)\?complete/);
    return { ok: true, status: 200, listingId: m ? m[2] : null, url: json.location.replace(/\?complete=1.*$/, "") };
  }
  if (json && typeof json.location === "string" && /login/i.test(json.location)) {
    return { ok: false, kind: "session", status: r.status, message: "ログイン状態が切れています。設定からPHPSESSIDを貼り直してください。" };
  }
  const message = json ? summarizeErrors(json) : plain(r.text).slice(0, 300) || `想定外の応答です(ステータス${r.status})`;
  return { ok: false, kind: res.status === 422 ? "invalid" : "unknown", status: r.status, message };
}

// 出品せずに、ログイン状態とアクセス可否だけを確かめる
export async function testConnection(session) {
  let res;
  try {
    res = await gcFetch("/mypage", session, { headers: { Accept: "text/html" } });
  } catch (e) {
    return { ok: false, kind: "network", message: `通信できませんでした(${e.message})` };
  }
  const r = await readRes(res);
  const title = (r.text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || "";
  if (r.kind === "blocked") return { ok: false, kind: "blocked", status: r.status, message: "Cloudflareにアクセスを拒否されました。サーバーからの自動出品はできない可能性が高いです。" };
  if (r.kind === "session") return { ok: false, kind: "session", status: r.status, message: "ログインしていない状態として扱われました。PHPSESSIDを確認してください。" };
  if (r.kind === "redirect") return { ok: false, kind: "unknown", status: r.status, message: `別のページへ転送されました: ${r.location}` };
  if (res.status !== 200) return { ok: false, kind: "unknown", status: r.status, message: `想定外の応答です(ステータス${r.status})` };
  const loggedIn = /ログアウト|logout/i.test(r.text);
  return loggedIn
    ? { ok: true, status: 200, message: `接続できました。ログイン状態も有効です(ページ名: ${title || "不明"})` }
    : { ok: false, kind: "session", status: 200, message: `ページは開けましたが、ログイン状態を確認できませんでした(ページ名: ${title || "不明"})` };
}

export async function checkSold(url, session, keywords) {
  const path = url.replace(GC, "");
  const res = await gcFetch(path, session, { headers: { Accept: "text/html" } });
  const r = await readRes(res);
  if (r.kind !== "ok" || res.status !== 200) return null;
  const text = plain(r.text);
  return keywords.some((k) => k && text.includes(k));
}
