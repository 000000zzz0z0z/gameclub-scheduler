import { timingSafeEqual, randomUUID } from "node:crypto";
import { load, save, publishNext, nextDraftIndex } from "../lib/core.mjs";
import { computeSlots, dayKey, parseMultipart, testConnection, isHM } from "../lib/gc.mjs";

export const config = { path: "/api/*" };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

function authorized(req) {
  const expected = process.env.ADMIN_PASSWORD || "";
  let given = req.headers.get("x-admin-key") || "";
  try { given = decodeURIComponent(given); } catch {}
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return expected && a.length === b.length && timingSafeEqual(a, b);
}

const clamp = (v, lo, hi, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
};

function mergeSettings(cur, body) {
  const s = structuredClone(cur);
  if ("paused" in body) s.paused = !!body.paused;
  if ("dailyLimit" in body) s.dailyLimit = clamp(body.dailyLimit, 1, 15, cur.dailyLimit);
  if ("graceMin" in body) s.graceMin = clamp(body.graceMin, 5, 90, cur.graceMin);
  if ("limitHours" in body) s.limitHours = clamp(body.limitHours, 0, 720, cur.limitHours);
  if (body.schedule) {
    const sc = body.schedule;
    if (sc.mode && !["interval", "manual"].includes(sc.mode)) throw new Error("スケジュールの方式が正しくありません。");
    if (sc.start && !isHM(sc.start)) throw new Error("開始時刻は 9:00 のような形式で入力してください。");
    if (sc.end && !isHM(sc.end)) throw new Error("終了時刻は 24:00 のような形式で入力してください。");
    if (sc.manual) {
      const bad = sc.manual.filter((t) => !isHM(t) || t === "24:00");
      if (bad.length) throw new Error(`時刻の形式が正しくありません: ${bad.join(", ")}`);
    }
    s.schedule = { ...s.schedule, ...sc };
    if ("count" in sc) s.schedule.count = clamp(sc.count, 1, 15, cur.schedule.count);
  }
  if ("discordWebhook" in body) {
    const w = String(body.discordWebhook || "").trim();
    if (w && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(w)) throw new Error("通知先はDiscordのWebhook URLを入力してください。");
    s.discordWebhook = w;
  }
  if (body.autoSold) {
    s.autoSold = {
      enabled: !!body.autoSold.enabled,
      keywords: Array.isArray(body.autoSold.keywords) ? body.autoSold.keywords.map((k) => String(k).trim()).filter(Boolean).slice(0, 10) : cur.autoSold.keywords,
    };
  }
  return s;
}

const draftSummary = (d) => {
  const get = (n) => d.fields.find((f) => f.name === n)?.value;
  return { key: d.key, label: d.label, draftId: d.draftId, repeat: d.repeat, enabled: d.enabled, publishedCount: d.publishedCount || 0, lastPublishedAt: d.lastPublishedAt || null, price: get("price") || null, title: (get("name") || "").slice(0, 80) };
};

export default async (req) => {
  if (!process.env.ADMIN_PASSWORD) return json({ error: "NetlifyでADMIN_PASSWORDが設定されていません。README の手順4を確認してください。" }, 500);
  if (!authorized(req)) return json({ error: "パスワードが違います。" }, 401);

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api/, "") || "/";
  const method = req.method;
  const body = ["POST", "PATCH", "PUT"].includes(method) ? await req.json().catch(() => ({})) : {};
  const seg = path.split("/").filter(Boolean);

  try {
    if (method === "GET" && path === "/state") {
      const [settings, secret, drafts, state] = await Promise.all([load("settings"), load("secret"), load("drafts"), load("state")]);
      const now = Date.now();
      const idx = nextDraftIndex(drafts, state.pointer);
      return json({
        now,
        settings,
        session: { set: !!secret.phpsessid, updatedAt: secret.updatedAt || null },
        drafts: drafts.map(draftSummary),
        nextDraftKey: idx >= 0 ? drafts[idx].key : null,
        slots: computeSlots(settings.schedule, settings.dailyLimit),
        today: state.days[dayKey(now)] || { count: 0, slots: {} },
        alert: state.alert,
        lastTick: state.lastTick,
      });
    }

    if (method === "GET" && path === "/logs") return json({ logs: await load("logs") });

    if (method === "POST" && path === "/settings") {
      const s = mergeSettings(await load("settings"), body);
      await save("settings", s);
      return json({ ok: true, settings: s });
    }

    if (method === "POST" && path === "/session") {
      const v = String(body.phpsessid || "").trim().replace(/^PHPSESSID=/i, "").replace(/;.*$/, "").trim();
      if (!/^[A-Za-z0-9,-]{10,128}$/.test(v)) throw new Error("PHPSESSIDの値の形式が正しくありません。値の部分だけを貼り付けてください。");
      await save("secret", { phpsessid: v, updatedAt: Date.now() });
      const state = await load("state");
      if (state.alert?.kind === "session") { state.alert = null; await save("state", state); }
      return json({ ok: true });
    }
    if (method === "DELETE" && path === "/session") {
      await save("secret", {});
      return json({ ok: true });
    }

    if (method === "POST" && path === "/test") {
      const secret = await load("secret");
      if (!secret.phpsessid) throw new Error("先に設定タブでPHPSESSIDを登録してください。");
      return json(await testConnection(secret.phpsessid));
    }

    if (method === "POST" && path === "/publish") {
      return json(await publishNext({ draftKey: body.key || null, manual: true }));
    }

    if (method === "POST" && path === "/alert/clear") {
      const state = await load("state");
      state.alert = null;
      await save("state", state);
      return json({ ok: true });
    }

    // 下書き
    if (seg[0] === "drafts") {
      const drafts = await load("drafts");
      if (method === "POST" && seg.length === 1) {
        const draftId = String(body.draftId || "").trim();
        if (!/^\d+$/.test(draftId)) throw new Error("下書き番号は数字で入力してください(URLの draft= の後ろの数字です)。");
        const fields = parseMultipart(body.raw);
        const title = fields.find((f) => f.name === "name")?.value || "";
        const d = { key: randomUUID().slice(0, 8), label: String(body.label || "").trim() || title.slice(0, 40) || `下書き${draftId}`, draftId, fields, repeat: body.repeat !== false, enabled: true, publishedCount: 0, createdAt: Date.now() };
        drafts.push(d);
        await save("drafts", drafts);
        return json({ ok: true, draft: draftSummary(d), fieldCount: fields.length });
      }
      if (method === "POST" && seg[1] === "order") {
        const order = Array.isArray(body.keys) ? body.keys : [];
        const state = await load("state");
        const nextKey = drafts[nextDraftIndex(drafts, state.pointer)]?.key;
        const sorted = [...drafts].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
        const ni = sorted.findIndex((d) => d.key === nextKey);
        state.pointer = ni >= 0 ? ni : 0;
        await Promise.all([save("drafts", sorted), save("state", state)]);
        return json({ ok: true });
      }
      if (method === "POST" && seg[2] === "next") {
        const i = drafts.findIndex((d) => d.key === seg[1]);
        if (i < 0) throw new Error("下書きが見つかりません。");
        const state = await load("state");
        state.pointer = i;
        await save("state", state);
        return json({ ok: true });
      }
      const d = drafts.find((x) => x.key === seg[1]);
      if (!d) throw new Error("下書きが見つかりません。");
      if (method === "PATCH") {
        if ("label" in body) d.label = String(body.label).trim() || d.label;
        if ("enabled" in body) d.enabled = !!body.enabled;
        if ("repeat" in body) d.repeat = !!body.repeat;
        if ("draftId" in body) {
          if (!/^\d+$/.test(String(body.draftId))) throw new Error("下書き番号は数字で入力してください。");
          d.draftId = String(body.draftId);
        }
        if (body.raw) d.fields = parseMultipart(body.raw);
        await save("drafts", drafts);
        return json({ ok: true, draft: draftSummary(d) });
      }
      if (method === "DELETE") {
        const state = await load("state");
        const i = drafts.indexOf(d);
        drafts.splice(i, 1);
        if (state.pointer > i) state.pointer--;
        if (state.pointer >= drafts.length) state.pointer = 0;
        await Promise.all([save("drafts", drafts), save("state", state)]);
        return json({ ok: true });
      }
    }

    // 記録(売れた印)
    if (seg[0] === "logs" && seg[1] && method === "PATCH") {
      const logs = await load("logs");
      const l = logs.find((x) => x.id === seg[1]);
      if (!l) throw new Error("記録が見つかりません。");
      l.sold = !!body.sold;
      l.soldAt = l.sold ? Number(body.soldAt) || Date.now() : null;
      l.soldBy = l.sold ? "manual" : null;
      await save("logs", logs);
      return json({ ok: true });
    }

    return json({ error: "見つかりません。" }, 404);
  } catch (e) {
    return json({ error: e.message || String(e) }, 400);
  }
};

