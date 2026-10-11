"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const KEY = "gc_admin_key";
let state = null, logs = null, tab = "home", pw = sessionStorage.getItem(KEY) || "";

function hm2str(m) { return `${Math.floor(m / 60)}:${pad(m % 60)}`; }
function fmtTime(ms) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtDate(ms) { const d = new Date(ms), n = new Date(); const t = `${pad(d.getHours())}:${pad(d.getMinutes())}`; if (d.toDateString() === n.toDateString()) return `今日 ${t}`; return `${d.getMonth() + 1}/${d.getDate()} ${t}`; }
function ago(ms) { const s = (Date.now() - ms) / 1000; if (s < 90) return "さっき"; if (s < 3600) return `${Math.floor(s / 60)}分前`; if (s < 86400) return `${Math.floor(s / 3600)}時間前`; return `${Math.floor(s / 86400)}日前`; }

let toastT;
function toast(msg, bad) {
  const t = $("#toast"); t.textContent = msg; t.className = "toast show" + (bad ? " bad" : "");
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = "toast"), 2600);
}

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, { ...opts, headers: { "Content-Type": "application/json", "x-admin-key": encodeURIComponent(pw), ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { sessionStorage.removeItem(KEY); location.reload(); throw new Error("auth"); }
  if (!res.ok) throw new Error(data.error || `エラー(${res.status})`);
  return data;
}

// ---- ログイン ----
$("#loginBtn").onclick = tryLogin;
$("#pw").onkeydown = (e) => e.key === "Enter" && tryLogin();
async function tryLogin() {
  pw = $("#pw").value.trim();
  if (!pw) return;
  $("#loginMsg").textContent = "確認中…";
  try {
    const d = await fetch("/api/state", { headers: { "x-admin-key": encodeURIComponent(pw) } });
    if (d.status === 401) { $("#loginMsg").textContent = "パスワードが違います。"; return; }
    if (!d.ok) { $("#loginMsg").textContent = (await d.json()).error || "エラー"; return; }
    sessionStorage.setItem(KEY, pw); start();
  } catch { $("#loginMsg").textContent = "接続できませんでした。"; }
}
$("#logout").onclick = () => { sessionStorage.removeItem(KEY); location.reload(); };

function start() {
  $("#login").classList.add("hide");
  $("#app").classList.remove("hide");
  $$(".tabs button").forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  refresh();
  setInterval(() => { if (!document.hidden) refresh(true); }, 30000);
}
function switchTab(t) {
  tab = t;
  $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
  $$(".tab").forEach((el) => el.classList.add("hide"));
  $("#tab-" + t).classList.remove("hide");
  if (t === "analysis" && !logs) loadLogs().then(render);
  render();
}

async function refresh(quiet) {
  try {
    state = await api("/state");
    if (tab === "analysis" || tab === "home") { if (!logs || !quiet) logs = (await api("/logs")).logs; }
    render();
  } catch (e) { if (!quiet) toast(e.message, true); }
}
async function loadLogs() { logs = (await api("/logs")).logs; }

function render() {
  if (!state) return;
  const s = state.settings;
  $("#statusLine").innerHTML = s.paused
    ? `<span class="dot pause"></span>停止中`
    : `<span class="dot run"></span>稼働中 ・ 今日 ${state.today.count}/${s.dailyLimit} 回`;
  renderBanners();
  if (tab === "home") renderHome();
  if (tab === "drafts") renderDrafts();
  if (tab === "schedule") renderSchedule();
  if (tab === "analysis") renderAnalysis();
  if (tab === "settings") renderSettings();
}

function renderBanners() {
  const b = $("#banners"); b.innerHTML = "";
  const a = state.alert;
  if (a) {
    const cls = a.kind === "session" ? "warn" : "bad";
    b.innerHTML += `<div class="banner ${cls}"><div><b>${a.kind === "session" ? "ログイン状態が切れました" : "アクセスが拒否されました"}</b><br>${esc(a.message)}<br><span class="muted">${fmtDate(a.at)}</span></div><button class="btn gho sm x" onclick="clearAlert()">×</button></div>`;
  }
  if (!state.session.set) {
    b.innerHTML += `<div class="banner info">はじめに「設定」タブで、ゲームクラブのログイン情報(PHPSESSID)を登録してください。</div>`;
  }
  const t = state.lastTick;
  if (t && Date.now() - t > 20 * 60000 && !state.settings.paused) {
    b.innerHTML += `<div class="banner warn">自動実行が${ago(t)}から動いていないようです。Netlifyの Functions → tick のログを確認してください。</div>`;
  }
}
window.clearAlert = async () => { await api("/alert/clear", { method: "POST" }); refresh(); };

// ---- ホーム ----
function renderHome() {
  const s = state.settings, now = state.now;
  const curMin = new Date(now).getHours() * 60 + new Date(now).getMinutes();
  const slotHtml = state.slots.map((m) => {
    const st = state.today.slots[m];
    const cls = st?.status === "done" ? "done" : st?.status === "failed" ? "failed" : st?.status === "skipped" ? "skipped" : "";
    const isNext = !st && m > curMin && state.slots.filter((x) => !state.today.slots[x] && x > curMin)[0] === m;
    return `<span class="slot ${cls} ${isNext ? "now" : ""}" title="${st?.message ? esc(st.message) : ""}">${hm2str(m)}</span>`;
  }).join("");
  const nextDraft = state.drafts.find((d) => d.key === state.nextDraftKey);
  const recent = (logs || []).slice(0, 6);
  $("#tab-home").innerHTML = `
    <div class="card">
      <h2>稼働状態</h2>
      <label class="switch" style="margin-bottom:14px">
        <input type="checkbox" id="pauseToggle" ${!s.paused ? "checked" : ""}>
        <span class="track"></span>
        <span>${s.paused ? "停止中 — 自動出品はされません" : "稼働中 — 予定時刻に自動出品します"}</span>
      </label>
      <dl class="dl">
        <dt>今日の出品</dt><dd>${state.today.count} / ${s.dailyLimit} 回</dd>
        <dt>次に出す下書き</dt><dd>${nextDraft ? esc(nextDraft.label) : "<span class='muted'>なし</span>"}</dd>
        <dt>ログイン状態</dt><dd>${state.session.set ? "<span class='pill ok'>登録済み</span>" : "<span class='pill off'>未登録</span>"}</dd>
      </dl>
    </div>
    <div class="card">
      <h2>今日の予定 <span class="q">${state.slots.length}枠</span></h2>
      <div class="slots">${slotHtml || "<span class='muted'>時間設定タブで予定を作成してください。</span>"}</div>
    </div>
    <div class="card">
      <h2>手動で今すぐ出品</h2>
      <div class="muted" style="margin-bottom:10px">予定とは別に、次の下書きを1件すぐ出品します(上限にはカウントされます)。</div>
      <button class="btn p" id="pubNow" ${!state.session.set || !nextDraft ? "disabled" : ""}>次の1件を出品</button>
    </div>
    <div class="card">
      <h2>最近の記録</h2>
      <div id="homeLogs">${recent.length ? recent.map(logRow).join("") : "<div class='center'>まだ記録がありません</div>"}</div>
    </div>`;
  $("#pauseToggle").onchange = async (e) => {
    try { await api("/settings", { method: "POST", body: JSON.stringify({ paused: !e.target.checked }) }); toast(e.target.checked ? "稼働を開始しました" : "停止しました"); refresh(); }
    catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
  };
  $("#pubNow").onclick = async (e) => {
    e.target.disabled = true; e.target.textContent = "出品中…";
    try { const r = await api("/publish", { method: "POST", body: "{}" }); toast(r.ok ? `出品しました: ${r.label}` : `失敗: ${r.message}`, !r.ok); logs = null; refresh(); }
    catch (err) { toast(err.message, true); e.target.disabled = false; e.target.textContent = "次の1件を出品"; }
  };
}

function logRow(l) {
  return `<div class="log"><span class="ico ${l.ok ? "ok" : "ng"}"></span><span class="t">${fmtDate(l.at)}</span><span class="m">${esc(l.label)}${l.manual ? " <span class='pill'>手動</span>" : ""}${l.sold ? " <span class='pill ok'>売れた</span>" : ""}${l.ok ? "" : `<br><span class="muted">${esc(l.message || "")}</span>`}</span></div>`;
}

// ---- 下書き ----
function renderDrafts() {
  const list = state.drafts.map((d) => {
    const cls = "draft" + (d.enabled ? "" : " dis") + (d.key === state.nextDraftKey ? " next" : "");
    return `<div class="${cls}" data-key="${d.key}" draggable="false">
      <div class="top">
        <span class="grip" data-grip>⠿</span>
        <span class="nm">${esc(d.label)}</span>
        ${d.repeat ? '<span class="pill rep">繰り返し</span>' : '<span class="pill">1回のみ</span>'}
        ${d.enabled ? "" : '<span class="pill off">無効</span>'}
      </div>
      <div class="meta">下書き #${d.draftId}${d.price ? ` ・ ${Number(d.price).toLocaleString()}円` : ""} ・ 出品${d.publishedCount}回${d.lastPublishedAt ? ` ・ 最終 ${fmtDate(d.lastPublishedAt)}` : ""}${d.key === state.nextDraftKey ? " ・ <b style='color:var(--accent)'>次はこれ</b>" : ""}</div>
      <div class="acts">
        <button class="btn sm" data-act="toggle">${d.enabled ? "無効化" : "有効化"}</button>
        <button class="btn sm" data-act="repeat">${d.repeat ? "1回のみに" : "繰り返しに"}</button>
        <button class="btn sm" data-act="rename">名前変更</button>
        <button class="btn sm" data-act="first">次に出す</button>
        <button class="btn sm gho" data-act="del">削除</button>
      </div>
    </div>`;
  }).join("");
  $("#tab-drafts").innerHTML = `
    <div class="card">
      <h2>下書き一覧 <span class="q">上から順に出品されます</span></h2>
      ${state.drafts.length ? `<div id="draftList">${list}</div>` : "<div class='center'>まだ下書きが登録されていません。<br>下に貼り付けて追加してください。</div>"}
    </div>
    <div class="card">
      <h2>下書きを追加</h2>
      ${addFormHtml()}
    </div>`;
  bindAddForm();
  bindDraftActs();
  bindDrag();
}

function addFormHtml() {
  return `
    <div class="field"><label>表示名(自分用のメモ。空欄なら商品名が入ります)</label><input type="text" id="d_label" placeholder="例: 10年代アカウント A"></div>
    <div class="row">
      <div class="field"><label>下書き番号</label><input type="text" id="d_id" inputmode="numeric" placeholder="213159"></div>
      <div class="field"><label>出品後の扱い</label><select id="d_repeat"><option value="1">繰り返し出品する</option><option value="0">1回だけ出品する</option></select></div>
    </div>
    <div class="field"><label>出品データ(Payloadの「View source」の内容を丸ごと貼り付け)</label>
      <textarea id="d_raw" rows="5" placeholder="------WebKitFormBoundary...... で始まる内容"></textarea></div>
    <button class="btn p" id="d_add">追加する</button>
    <details class="help"><summary>データの取り方</summary><div>
      <ol>
        <li>ゲームクラブで対象の下書きを一度出品する(開発者ツールのNetworkを記録しながら)</li>
        <li>名前が <code>add?draft=番号</code> の通信をクリック</li>
        <li>「Payload」タブ → 上の「View source」ボタンを押す</li>
        <li>表示された内容を全部コピーして、上の欄に貼り付け</li>
      </ol>
      番号は、その通信のURL <code>draft=</code> の後ろの数字です。画像は下書きに保存済みのものが使われるので、貼り直し不要です。
    </div></details>`;
}
function bindAddForm() {
  const btn = $("#d_add"); if (!btn) return;
  btn.onclick = async () => {
    const draftId = $("#d_id").value.trim(), raw = $("#d_raw").value.trim();
    if (!draftId || !raw) return toast("下書き番号とデータを入力してください", true);
    btn.disabled = true; btn.textContent = "追加中…";
    try {
      const r = await api("/drafts", { method: "POST", body: JSON.stringify({ draftId, raw, label: $("#d_label").value, repeat: $("#d_repeat").value === "1" }) });
      toast(`追加しました(${r.fieldCount}項目を読み取り)`); refresh();
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = "追加する"; }
  };
}
function bindDraftActs() {
  $$("#draftList [data-act]").forEach((btn) => {
    btn.onclick = async () => {
      const key = btn.closest("[data-key]").dataset.key;
      const d = state.drafts.find((x) => x.key === key);
      const act = btn.dataset.act;
      try {
        if (act === "toggle") await api("/drafts/" + key, { method: "PATCH", body: JSON.stringify({ enabled: !d.enabled }) });
        else if (act === "repeat") await api("/drafts/" + key, { method: "PATCH", body: JSON.stringify({ repeat: !d.repeat }) });
        else if (act === "first") { await api(`/drafts/${key}/next`, { method: "POST", body: "{}" }); toast("次に出品します"); }
        else if (act === "rename") { const n = prompt("表示名", d.label); if (n == null) return; await api("/drafts/" + key, { method: "PATCH", body: JSON.stringify({ label: n }) }); }
        else if (act === "del") { if (!confirm(`「${d.label}」を削除しますか?`)) return; await api("/drafts/" + key, { method: "DELETE" }); }
        refresh();
      } catch (e) { toast(e.message, true); }
    };
  });
}
function bindDrag() {
  const list = $("#draftList"); if (!list) return;
  let dragging = null;
  $$("[data-grip]", list).forEach((g) => {
    const card = g.closest("[data-key]");
    const down = (e) => {
      e.preventDefault(); dragging = card; card.style.opacity = ".5";
      const move = (ev) => {
        const y = ev.touches ? ev.touches[0].clientY : ev.clientY;
        const after = [...list.querySelectorAll("[data-key]:not([style*='0.5'])")].find((el) => y < el.getBoundingClientRect().top + el.offsetHeight / 2);
        if (after) list.insertBefore(dragging, after); else list.appendChild(dragging);
      };
      const up = async () => {
        document.removeEventListener("mousemove", move); document.removeEventListener("touchmove", move);
        document.removeEventListener("mouseup", up); document.removeEventListener("touchend", up);
        dragging.style.opacity = ""; dragging = null;
        const keys = $$("[data-key]", list).map((el) => el.dataset.key);
        try { await api("/drafts/order", { method: "POST", body: JSON.stringify({ keys }) }); toast("順番を保存しました"); refresh(); } catch (e) { toast(e.message, true); }
      };
      document.addEventListener("mousemove", move); document.addEventListener("touchmove", move, { passive: false });
      document.addEventListener("mouseup", up); document.addEventListener("touchend", up);
    };
    g.addEventListener("mousedown", down); g.addEventListener("touchstart", down, { passive: false });
  });
}

// ---- 時間設定 ----
function renderSchedule() {
  const s = state.settings, sc = s.schedule;
  $("#tab-schedule").innerHTML = `
    <div class="card">
      <h2>出品する時間の決め方</h2>
      <div class="field">
        <select id="sc_mode">
          <option value="interval" ${sc.mode === "interval" ? "selected" : ""}>時間帯と回数を決めて等間隔で出す</option>
          <option value="manual" ${sc.mode === "manual" ? "selected" : ""}>時刻を自分で1つずつ指定する</option>
        </select>
      </div>
      <div id="sc_interval" class="${sc.mode === "manual" ? "hide" : ""}">
        <div class="row">
          <div class="field"><label>開始</label><input type="text" id="sc_start" value="${sc.start}" placeholder="9:00"></div>
          <div class="field"><label>終了</label><input type="text" id="sc_end" value="${sc.end}" placeholder="24:00"></div>
          <div class="field"><label>回数(最大${s.dailyLimit})</label><input type="number" id="sc_count" value="${sc.count}" min="1" max="${s.dailyLimit}"></div>
        </div>
        <div class="muted" id="sc_preview"></div>
      </div>
      <div id="sc_manual" class="${sc.mode === "manual" ? "" : "hide"}">
        <div class="field"><label>時刻(1行に1つ、24時間表記)</label>
          <textarea id="sc_times" rows="6" style="font-family:ui-monospace,monospace">${(sc.manual || []).join("\n")}</textarea></div>
        <button class="btn sm" id="sc_suggest">分析結果から推奨時刻を入れる</button>
      </div>
      <button class="btn p" id="sc_save" style="margin-top:14px">保存する</button>
    </div>
    <div class="card">
      <h2>出品の期限</h2>
      <div class="field"><label>出品してから何時間後を期限にするか</label>
        <div class="row">
          <input type="number" id="sc_limit" value="${s.limitHours}" min="0" max="720" style="flex:0 0 120px">
          <div class="muted" style="align-self:center;flex:1">0 にすると、下書きに保存された期限をそのまま使います</div>
        </div>
      </div>
      <button class="btn p" id="sc_limitSave">保存する</button>
    </div>`;
  const upd = () => {
    const slots = previewSlots();
    $("#sc_preview").innerHTML = slots.length ? `出品時刻: ${slots.map(hm2str).join(" / ")}<br>間隔 約${slots.length > 1 ? Math.round((slots[slots.length - 1] - slots[0]) / (slots.length - 1)) : 0}分` : "時間帯が正しくありません";
  };
  $("#sc_mode").onchange = (e) => { $("#sc_interval").classList.toggle("hide", e.target.value === "manual"); $("#sc_manual").classList.toggle("hide", e.target.value !== "manual"); };
  ["sc_start", "sc_end", "sc_count"].forEach((id) => $("#" + id) && ($("#" + id).oninput = upd));
  upd();
  $("#sc_suggest").onclick = async () => { if (!logs) await loadLogs(); const best = bestHours(6); if (!best.length) return toast("まだ分析データがありません", true); $("#sc_times").value = best.map((h) => `${h}:00`).join("\n"); toast("推奨時刻を入れました(確認して保存してください)"); };
  $("#sc_save").onclick = async () => {
    const mode = $("#sc_mode").value;
    const body = { schedule: { mode } };
    if (mode === "interval") { body.schedule.start = $("#sc_start").value.trim(); body.schedule.end = $("#sc_end").value.trim(); body.schedule.count = Number($("#sc_count").value); }
    else body.schedule.manual = $("#sc_times").value.split("\n").map((x) => x.trim()).filter(Boolean);
    try { await api("/settings", { method: "POST", body: JSON.stringify(body) }); toast("保存しました"); refresh(); } catch (e) { toast(e.message, true); }
  };
  $("#sc_limitSave").onclick = async () => { try { await api("/settings", { method: "POST", body: JSON.stringify({ limitHours: Number($("#sc_limit").value) }) }); toast("保存しました"); refresh(); } catch (e) { toast(e.message, true); } };
}
function previewSlots() {
  const n = Math.max(1, Math.min(state.settings.dailyLimit, Number($("#sc_count").value) || 1));
  const p = (v) => { const m = String(v).match(/^(\d{1,2}):(\d{2})$/); return m ? +m[1] * 60 + +m[2] : NaN; };
  const s = p($("#sc_start").value), e = p($("#sc_end").value);
  if (!(e - s > 0)) return [];
  const step = (e - s) / n, out = [];
  for (let i = 0; i < n; i++) { const v = Math.round(s + i * step); if (v < 1440) out.push(v); }
  return out;
}

// ---- 分析 ----
function renderAnalysis() {
  if (!logs) { $("#tab-analysis").innerHTML = "<div class='card'><div class='center'>読み込み中…</div></div>"; return; }
  const sold = logs.filter((l) => l.ok && l.sold && l.soldAt);
  const listed = logs.filter((l) => l.ok);
  const byHour = Array.from({ length: 24 }, () => ({ listed: 0, sold: 0, totalMs: 0 }));
  listed.forEach((l) => byHour[new Date(l.at).getHours()].listed++);
  sold.forEach((l) => { const h = new Date(l.at).getHours(); byHour[h].sold++; byHour[h].totalMs += l.soldAt - l.at; });
  const maxRate = Math.max(0.0001, ...byHour.map((b) => (b.listed ? b.sold / b.listed : 0)));
  const heat = buildHeat();
  const best = bestHours(5);

  $("#tab-analysis").innerHTML = `
    <div class="card">
      <h2>概要</h2>
      <dl class="dl">
        <dt>出品の総数</dt><dd>${listed.length} 件</dd>
        <dt>売れた数(記録済み)</dt><dd>${sold.length} 件</dd>
        <dt>平均で売れるまで</dt><dd>${sold.length ? fmtDur(sold.reduce((a, l) => a + (l.soldAt - l.at), 0) / sold.length) : "—"}</dd>
      </dl>
      ${sold.length < 5 ? "<div class='muted' style='margin-top:10px'>※「売れた」記録が増えるほど精度が上がります。下の記録一覧で、売れた出品に印をつけてください。自動判定も設定タブでオンにできます。</div>" : ""}
    </div>
    <div class="card">
      <h2>時間帯 × 曜日(売れやすさ)</h2>
      <div class="muted" style="margin-bottom:8px">濃いマスほど、その時間に出したものが早く売れています。</div>
      ${heat}
    </div>
    <div class="card">
      <h2>売れやすい時間帯 上位</h2>
      ${best.length ? best.map((h) => { const b = byHour[h]; return `<div class="log"><span class="t">${pad(h)}:00</span><span class="m">出品${b.listed}件 / 売れた${b.sold}件${b.sold ? ` ・ 平均 ${fmtDur(b.totalMs / b.sold)}` : ""}</span></div>`; }).join("") : "<div class='center'>データがたまると表示されます</div>"}
    </div>
    <div class="card">
      <h2>記録一覧 <span class="q">売れたら印をつけてください</span></h2>
      <div id="logList">${logs.slice(0, 100).map(fullLogRow).join("") || "<div class='center'>記録なし</div>"}</div>
    </div>`;
  $$("#logList [data-sold]").forEach((b) => b.onclick = async () => {
    const id = b.dataset.sold, l = logs.find((x) => x.id === id);
    try { await api("/logs/" + id, { method: "PATCH", body: JSON.stringify({ sold: !l.sold }) }); l.sold = !l.sold; l.soldAt = l.sold ? Date.now() : null; render(); } catch (e) { toast(e.message, true); }
  });
}
function fullLogRow(l) {
  return `<div class="log"><span class="ico ${l.ok ? "ok" : "ng"}"></span><span class="t">${fmtDate(l.at)}</span><span class="m">${esc(l.label)}${l.ok ? "" : `<br><span class="muted">${esc(l.message || "")}</span>`}</span>${l.ok ? `<button class="btn sm ${l.sold ? "p" : "gho"}" data-sold="${l.id}">${l.sold ? "売れた✓" : "売れた?"}</button>` : ""}</div>`;
}
function buildHeat() {
  const wd = ["日", "月", "火", "水", "木", "金", "土"];
  const cell = {}; // wd-hourbucket -> {listed, totalMs, sold}
  logs.filter((l) => l.ok).forEach((l) => { const d = new Date(l.at), k = d.getDay() + "-" + d.getHours(); (cell[k] ||= { listed: 0, sold: 0, totalMs: 0 }).listed++; if (l.sold && l.soldAt) { cell[k].sold++; cell[k].totalMs += l.soldAt - l.at; } });
  let max = 0.0001;
  Object.values(cell).forEach((c) => { if (c.listed) max = Math.max(max, c.sold / c.listed); });
  let html = '<div class="heat"><table><tr><th></th>';
  for (let h = 0; h < 24; h += 2) html += `<th colspan="2">${h}</th>`;
  html += "</tr>";
  for (let w = 0; w < 7; w++) {
    html += `<tr><th>${wd[w]}</th>`;
    for (let h = 0; h < 24; h++) {
      const c = cell[w + "-" + h];
      const rate = c && c.listed ? c.sold / c.listed : -1;
      const alpha = rate < 0 ? 0 : 0.12 + 0.88 * (rate / max);
      const bg = rate < 0 ? (c ? "var(--panel2)" : "transparent") : `rgba(255,90,60,${alpha})`;
      const title = c ? `${wd[w]} ${h}時: 出品${c.listed} 売れた${c.sold}` : "";
      html += `<td class="c" style="background:${bg}" title="${title}"></td>`;
    }
    html += "</tr>";
  }
  return html + "</table></div>";
}
function bestHours(n) {
  if (!logs) return [];
  const byHour = Array.from({ length: 24 }, () => ({ listed: 0, sold: 0, totalMs: 0 }));
  logs.filter((l) => l.ok).forEach((l) => { const h = new Date(l.at).getHours(); byHour[h].listed++; if (l.sold && l.soldAt) { byHour[h].sold++; byHour[h].totalMs += l.soldAt - l.at; } });
  const scored = byHour.map((b, h) => ({ h, score: b.sold ? (b.sold / b.listed) * 1000 - (b.totalMs / b.sold) / 60000 : -1, sold: b.sold }));
  return scored.filter((x) => x.sold > 0).sort((a, b) => b.score - a.score).slice(0, n).map((x) => x.h);
}
function fmtDur(ms) { const h = ms / 3600e3; if (h < 1) return `${Math.round(ms / 60e3)}分`; if (h < 24) return `${h.toFixed(1)}時間`; return `${(h / 24).toFixed(1)}日`; }

// ---- 設定 ----
function renderSettings() {
  const s = state.settings;
  $("#tab-settings").innerHTML = `
    <div class="card">
      <h2>ログイン情報(PHPSESSID)</h2>
      <div class="muted" style="margin-bottom:10px">現在: ${state.session.set ? `<span class="pill ok">登録済み</span> ${state.session.updatedAt ? "(" + fmtDate(state.session.updatedAt) + ")" : ""}` : '<span class="pill off">未登録</span>'}</div>
      <div class="field"><label>PHPSESSIDの値</label><input type="password" id="st_sess" placeholder="値の部分だけを貼り付け"></div>
      <div class="row">
        <button class="btn p" id="st_sessSave">保存</button>
        <button class="btn" id="st_test" ${!state.session.set ? "disabled" : ""}>接続テスト</button>
        ${state.session.set ? '<button class="btn gho" id="st_sessDel">削除</button>' : ""}
      </div>
      <div class="muted" id="st_testMsg" style="margin-top:10px"></div>
      <details class="help"><summary>値の取り方</summary><div>
        <ol>
          <li>ゲームクラブを開き、開発者ツール(F12)の「Application」タブへ</li>
          <li>左の Cookies → https://gameclub.jp を選ぶ</li>
          <li><code>PHPSESSID</code> の行の Value をコピーして貼り付け</li>
        </ol>
        ブラウザでログアウトすると無効になります。普段どおり放置すれば長期間有効です。
      </div></details>
    </div>
    <div class="card">
      <h2>売れたかの自動判定</h2>
      <label class="switch" style="margin-bottom:12px"><input type="checkbox" id="st_auto" ${s.autoSold.enabled ? "checked" : ""}><span class="track"></span><span>出品ページを定期的に見て、売り切れを自動で記録する</span></label>
      <div class="field"><label>売り切れと判断する言葉(カンマ区切り)</label><input type="text" id="st_kw" value="${esc(s.autoSold.keywords.join(", "))}"></div>
      <button class="btn p" id="st_autoSave">保存</button>
      <div class="muted" style="margin-top:8px">※ページの文言と違うと誤判定します。実際の売り切れ表示を確認してから使ってください。</div>
    </div>
    <div class="card">
      <h2>通知(任意)</h2>
      <div class="field"><label>Discord Webhook URL</label><input type="text" id="st_hook" value="${esc(s.discordWebhook)}" placeholder="https://discord.com/api/webhooks/..."></div>
      <button class="btn p" id="st_hookSave">保存</button>
      <div class="muted" style="margin-top:8px">ログイン切れやアクセス拒否、出品失敗のときに通知します。</div>
    </div>
    <div class="card">
      <h2>その他</h2>
      <div class="row">
        <div class="field"><label>1日の上限回数</label><input type="number" id="st_limit" value="${s.dailyLimit}" min="1" max="15"></div>
        <div class="field"><label>遅れ許容(分)</label><input type="number" id="st_grace" value="${s.graceMin}" min="5" max="90"></div>
      </div>
      <div class="muted" style="margin-bottom:10px">予定時刻を過ぎても、この分数以内なら出品します(サーバーは5分おきに動くため少しずれます)。</div>
      <button class="btn p" id="st_miscSave">保存</button>
    </div>`;
  $("#st_sessSave").onclick = async () => { const v = $("#st_sess").value.trim(); if (!v) return toast("値を入力してください", true); try { await api("/session", { method: "POST", body: JSON.stringify({ phpsessid: v }) }); toast("保存しました"); $("#st_sess").value = ""; refresh(); } catch (e) { toast(e.message, true); } };
  if ($("#st_sessDel")) $("#st_sessDel").onclick = async () => { if (!confirm("削除しますか?")) return; await api("/session", { method: "DELETE" }); toast("削除しました"); refresh(); };
  $("#st_test").onclick = async (e) => { e.target.disabled = true; $("#st_testMsg").textContent = "確認中…"; try { const r = await api("/test", { method: "POST", body: "{}" }); $("#st_testMsg").innerHTML = `<span style="color:var(--${r.ok ? "ok" : "bad"})">${r.ok ? "✓ " : "✕ "}${esc(r.message)}</span>`; } catch (err) { $("#st_testMsg").textContent = err.message; } e.target.disabled = false; };
  $("#st_autoSave").onclick = async () => { try { await api("/settings", { method: "POST", body: JSON.stringify({ autoSold: { enabled: $("#st_auto").checked, keywords: $("#st_kw").value.split(",").map((x) => x.trim()).filter(Boolean) } }) }); toast("保存しました"); refresh(); } catch (e) { toast(e.message, true); } };
  $("#st_hookSave").onclick = async () => { try { await api("/settings", { method: "POST", body: JSON.stringify({ discordWebhook: $("#st_hook").value.trim() }) }); toast("保存しました"); refresh(); } catch (e) { toast(e.message, true); } };
  $("#st_miscSave").onclick = async () => { try { await api("/settings", { method: "POST", body: JSON.stringify({ dailyLimit: Number($("#st_limit").value), graceMin: Number($("#st_grace").value) }) }); toast("保存しました"); refresh(); } catch (e) { toast(e.message, true); } };
}

if (pw) { fetch("/api/state", { headers: { "x-admin-key": encodeURIComponent(pw) } }).then((r) => { if (r.ok) start(); else { sessionStorage.removeItem(KEY); } }); }
