// Read-only team dashboard (server-rendered, auto-refreshes every 60s).
import { now } from "./ig.js";
import { postAnalytics } from "./stats.js";
import { calendarItems } from "./calendar.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function tzOffsetSec(tz) {
  const d = new Date();
  const local = new Date(d.toLocaleString("en-US", { timeZone: tz }));
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((local - utc) / 1000);
}

const STAGES = {
  new: ["Starting", "muted"],
  opened: ["DM sent, waiting for tap", "info"],
  asked_follow: ["Asked to follow", "warn"],
  link_sent: ["Link sent", "ok"],
  followed_up: ["Followed up", "ok"],
  error: ["Failed", "err"],
};

export async function renderDashboard(env, url) {
  const tz = env.TZ || "UTC";
  const fmt = (ts) => (ts ? new Date(ts * 1000).toLocaleString("en-IN", { timeZone: tz, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
  const ago = (ts) => {
    const d = now() - ts;
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  };

  const accounts = (await env.DB.prepare("SELECT ig_user_id, username, status, token_expires, error FROM accounts ORDER BY username").all()).results;
  const sel = accounts.find((a) => a.username === url.searchParams.get("account"));
  const f = sel ? " AND x.ig_user_id = ?" : "";
  const b = sel ? [sel.ig_user_id] : [];
  const q = (sql, ...extra) => env.DB.prepare(sql.replaceAll("{F}", f)).bind(...extra, ...b).all().then((r) => r.results);

  const week = now() - 7 * 86400;
  const [totals] = await q(
    `SELECT COUNT(*) AS leads, SUM(stage IN ('link_sent','followed_up')) AS links, SUM(stage = 'followed_up') AS fups,
            SUM(stage = 'error') AS errs FROM leads x WHERE created >= ? {F}`, week);
  const rules = await q(
    `SELECT x.*, a.username, COUNT(l.id) AS total, SUM(l.stage IN ('link_sent','followed_up')) AS links, SUM(l.clicks > 0) AS clicked,
            SUM(l.stage = 'followed_up') AS fups, SUM(l.stage = 'asked_follow') AS waiting, SUM(l.stage = 'opened') AS opened
     FROM rules x JOIN accounts a ON a.ig_user_id = x.ig_user_id LEFT JOIN leads l ON l.rule_id = x.id
     WHERE 1 = 1 {F} GROUP BY x.id ORDER BY x.active DESC, x.created DESC`);
  const leads = await q(
    `SELECT x.*, r.name AS rule_name, a.username AS acct FROM leads x JOIN rules r ON r.id = x.rule_id
     JOIN accounts a ON a.ig_user_id = x.ig_user_id WHERE 1 = 1 {F} ORDER BY x.updated DESC LIMIT 50`);
  const upcoming = await q(
    `SELECT x.*, a.username FROM posts x JOIN accounts a ON a.ig_user_id = x.ig_user_id
     WHERE x.status IN ('pending','processing') {F} ORDER BY x.publish_at LIMIT 30`);
  const recentPosts = await q(
    `SELECT x.*, a.username FROM posts x JOIN accounts a ON a.ig_user_id = x.ig_user_id
     WHERE x.status IN ('published','failed') {F} ORDER BY x.publish_at DESC LIMIT 15`);
  const posts = await postAnalytics(env, sel?.ig_user_id, 20);

  // calendar: Monday of last week -> 4 weeks
  const localNow = new Date(Date.now() + tzOffsetSec(tz) * 1000);
  const dow = (localNow.getUTCDay() + 6) % 7;
  const startDay = Math.floor((now() + tzOffsetSec(tz)) / 86400) - dow - 7; // in local days
  const calFrom = startDay * 86400 - tzOffsetSec(tz), calTo = calFrom + 28 * 86400;
  const cal = await calendarItems(env, calFrom, calTo, sel?.ig_user_id);
  const queued = (await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first())?.n || 0;
  const [clickTot] = await q(`SELECT SUM(clicks > 0) AS clicked, SUM(feedback = 'loved') AS loved FROM leads x WHERE created >= ? {F}`, week);
  const ytAccts = sel ? [] : (await env.DB.prepare("SELECT channel_id, title, status, error FROM yt_accounts").all()).results;
  const ytQuota = ytAccts.length ? Number((await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(`ytq:${new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date())}`).first())?.v || 0) : 0;
  const ytRules = ytAccts.length ? (await env.DB.prepare(`SELECT r.*, (SELECT COUNT(*) FROM yt_replies x WHERE x.rule_id = r.id AND x.status = 'replied') AS replied,
      (SELECT COUNT(*) FROM yt_replies x WHERE x.rule_id = r.id AND x.status != 'replied') AS failed FROM yt_rules r ORDER BY r.created DESC`).all()).results : [];
  const ytReplies = ytAccts.length ? (await env.DB.prepare("SELECT x.*, r.name AS rule FROM yt_replies x LEFT JOIN yt_rules r ON r.id = x.rule_id ORDER BY x.created DESC LIMIT 15").all()).results : [];
  const ytStats = ytAccts.length ? (await env.DB.prepare(`SELECT s.*, (SELECT COUNT(*) FROM yt_replies x WHERE x.video_id = s.video_id AND x.status = 'replied') AS replies FROM yt_stats s ORDER BY s.published DESC LIMIT 15`).all()).results : [];
  const events = await q(
    `SELECT x.*, a.username FROM events x LEFT JOIN accounts a ON a.ig_user_id = x.ig_user_id
     WHERE 1 = 1 {F} ORDER BY x.id DESC LIMIT 60`);

  const pct = (a, b) => (b ? `${Math.round((100 * (a || 0)) / b)}%` : "—");
  const typeLabel = { image: "Image", reel: "Reel", carousel: "Carousel", story: "Story" };

  const tabs = [`<a href="/" class="${sel ? "" : "on"}">All accounts</a>`]
    .concat(accounts.map((a) => `<a href="/?account=${encodeURIComponent(a.username)}" class="${sel?.username === a.username ? "on" : ""}">@${esc(a.username)}</a>`))
    .join("");

  const accountCards = accounts.map((a) => {
    const days = a.token_expires ? Math.floor((a.token_expires - now()) / 86400) : null;
    const bad = a.status !== "active";
    return `<div class="acct ${bad ? "bad" : ""}">
      <div class="acct-name">@${esc(a.username)}</div>
      <div class="acct-meta"><span class="pill ${bad ? "err" : "ok"}">${bad ? esc(a.status.replace("_", " ")) : "Connected"}</span>
      ${days !== null ? `<span class="dim">token renews automatically · ${days}d left</span>` : ""}</div>
      ${a.error ? `<div class="acct-err">${esc(a.error)}</div>` : ""}
    </div>`;
  }).join("") || `<div class="empty">No accounts connected yet.</div>`;

  const ruleRows = rules.map((r) => {
    const kws = JSON.parse(r.keywords).map((k) => `<code>${esc(k.toUpperCase())}</code>`).join(" ");
    return `<tr class="${r.active ? "" : "off"}">
      <td><div class="strong">${esc(r.name)}</div><div class="dim">@${esc(r.username)}${r.active ? "" : " · paused"}</div></td>
      <td>${kws.includes("*") ? "Any" : kws}</td>
      <td>${JSON.parse(r.media_ids).includes("*") ? "Every post" : r.permalink ? `<a href="${esc(r.permalink)}" target="_blank" rel="noopener">View post ↗</a>` : "—"}
          <div class="dim">${esc((r.triggers ? JSON.parse(r.triggers) : ["comment", ...(r.dm_trigger ? ["dm"] : [])]).map((t) => ({ comment: "Comments", dm: "DMs", story_reply: "Story replies", story_mention: "Story mentions" }[t] || t)).join(" · "))}</div></td>
      <td><div>${esc(r.ask_button)}${r.require_follow ? ` <span class="pill warn">follow gate</span>` : ""}</div>
          <div class="dim">→ <a href="${esc(r.link_url)}" target="_blank" rel="noopener">${esc(r.link_title)}</a>${r.followup_text ? ` · follow-up ${r.followup_mins}m` : ""}</div></td>
      <td class="num">${r.total || 0}</td>
      <td class="num">${(r.opened || 0) + (r.waiting || 0)}</td>
      <td class="num">${r.links || 0} <span class="dim">${pct(r.links, r.total)}</span></td>
      <td class="num">${r.clicked || 0} <span class="dim">${pct(r.clicked, r.links)}</span></td>
      <td class="num">${r.fups || 0}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="9" class="empty">No automations yet.</td></tr>`;

  const leadRows = leads.map((l) => {
    const [label, cls] = STAGES[l.stage] || [l.stage, "muted"];
    return `<tr>
      <td class="dim nowrap" title="${esc(fmt(l.updated))}">${ago(l.updated)}</td>
      <td>${l.username ? `<a href="https://instagram.com/${esc(l.username)}" target="_blank" rel="noopener">@${esc(l.username)}</a>` : `<span class="dim">via DM</span>`}</td>
      <td>${esc(l.rule_name)}<div class="dim">${{ comment: "comment", dm: "DM", story_reply: "story reply", story_mention: "story mention" }[l.source] || ""}${sel ? "" : ` · @${esc(l.acct)}`}</div></td>
      <td class="clip">${esc(l.comment_text)}</td>
      <td><span class="pill ${cls}">${label}</span>${l.clicks > 0 ? ` <span class="pill ok">opened${l.clicks > 1 ? ` ×${l.clicks}` : ""}</span>` : ""}${l.feedback ? ` <span class="pill ${l.feedback === "help" ? "warn" : "info"}">${{ loved: "loved it 🔥", okay: "okay 👍", help: "needs help 🙋" }[l.feedback] || esc(l.feedback)}</span>` : ""}${l.stage === "link_sent" && l.followup_due ? `<div class="dim">follow-up ${fmt(l.followup_due)}</div>` : ""}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="5" class="empty">No leads yet. They show up here as people comment.</td></tr>`;

  const postRow = (p) => {
    const cls = { pending: "info", processing: "warn", published: "ok", failed: "err" }[p.status];
    const auto = p.autodm ? JSON.parse(p.autodm) : null;
    return `<tr>
      <td class="nowrap">${fmt(p.publish_at)}</td>
      <td>@${esc(p.username)}</td>
      <td>${typeLabel[p.type] || p.type}</td>
      <td class="clip">${esc((p.caption || "").slice(0, 120))}</td>
      <td>${auto ? auto.keywords.map((k) => `<code>${esc(k.toUpperCase())}</code>`).join(" ") : `<span class="dim">—</span>`}</td>
      <td><span class="pill ${cls}">${p.status}</span>${p.permalink ? ` <a href="${esc(p.permalink)}" target="_blank" rel="noopener">↗</a>` : ""}${p.error ? `<div class="err-text">${esc(p.error.slice(0, 160))}</div>` : ""}</td>
    </tr>`;
  };

  const eventRows = events.map((e) => `<li class="${e.level}">
      <span class="dim nowrap">${fmt(e.ts)}</span>${sel || !e.username ? "" : ` <span class="dim">@${esc(e.username)}</span>`}
      <span>${esc(e.msg)}</span></li>`).join("") || `<li class="dim">Nothing yet.</li>`;

  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="60">
<title>Personal Automation</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#F3FCFE;--panel:#fff;--ink:#002B36;--dim:#4d6b73;--line:#d6eef3;--accent:#00A6D6;--ok:#0a8f6a;--okbg:#e2f7ef;--info:#0077a8;--infobg:#e0f4fb;--warn:#a36200;--warnbg:#fdf1dc;--err:#d42a56;--errbg:#fde6ec;--mutedbg:#eef3f4}
@media (prefers-color-scheme:dark){:root{--bg:#00222b;--panel:#002B36;--ink:#E6FBFF;--dim:#8fb5bd;--line:#0d4250;--accent:#00F5FF;--ok:#3ee0a8;--okbg:#063d33;--info:#00BBF0;--infobg:#06384a;--warn:#ffc266;--warnbg:#3d2f12;--err:#FF3D71;--errbg:#40121f;--mutedbg:#0a3742}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 Inter,system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1240px;margin:0 auto;padding:24px 16px 64px}
header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:16px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}h2{font-size:15px;margin:32px 0 10px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim)}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:18px}.tabs a{padding:6px 12px;border:1px solid var(--line);border-radius:999px;color:var(--ink);background:var(--panel)}
.tabs a.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}.tabs a:hover{text-decoration:none;border-color:var(--accent)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.stat b{display:block;font-size:26px;letter-spacing:-.02em}.stat span{color:var(--dim);font-size:13px}
.accts{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.acct{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}.acct.bad{border-color:var(--err)}
.acct-name{font-weight:600;font-size:15px}.acct-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}.acct-err{color:var(--err);font-size:12px;margin-top:6px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow-x:auto}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;font-weight:600;color:var(--dim);white-space:nowrap}tr:last-child td{border-bottom:0}tr.off{opacity:.5}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}th.num{text-align:right}
.dim{color:var(--dim);font-size:12.5px}.strong{font-weight:600}.nowrap{white-space:nowrap}.clip{max-width:280px;overflow:hidden;text-overflow:ellipsis}
code{font:600 12px ui-monospace,monospace;background:var(--mutedbg);padding:2px 6px;border-radius:5px}
.pill{display:inline-block;font-size:12px;font-weight:500;padding:2px 8px;border-radius:999px;white-space:nowrap}
.pill.ok{color:var(--ok);background:var(--okbg)}.pill.info{color:var(--info);background:var(--infobg)}.pill.warn{color:var(--warn);background:var(--warnbg)}.pill.err{color:var(--err);background:var(--errbg)}.pill.muted{color:var(--dim);background:var(--mutedbg)}
.err-text{color:var(--err);font-size:12px;margin-top:4px}.empty{color:var(--dim);padding:18px;text-align:center}
ul.log{list-style:none;margin:0;padding:6px 0;font-size:13px}ul.log li{display:flex;gap:10px;padding:6px 14px;border-bottom:1px solid var(--line)}ul.log li:last-child{border:0}
ul.log li.error span:last-child{color:var(--err)}ul.log li.warn span:last-child{color:var(--warn)}
.cols{display:grid;grid-template-columns:1fr;gap:0 20px}
.cal-wrap{overflow-x:auto}.cal{display:grid;grid-template-columns:repeat(7,minmax(118px,1fr));min-width:826px}
.cal-h{padding:8px 10px;font-size:12px;font-weight:600;color:var(--dim);border-bottom:1px solid var(--line)}
.cal-d{min-height:96px;padding:6px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:4px}
.cal-d:nth-child(7n+7){border-right:0}.cal-d.past{background:var(--mutedbg);opacity:.85}.cal-d.today{box-shadow:inset 0 0 0 2px var(--accent)}
.cal-n{font-size:12px;color:var(--dim);font-weight:600}
.cal-p{display:block;font-size:12px;line-height:1.3;padding:5px 6px;border-radius:6px;color:var(--ink);text-decoration:none;border-left:3px solid var(--dim);background:var(--panel)}
.cal-p:hover{text-decoration:none;filter:brightness(1.05)}.cal-p code{font-size:10px;padding:1px 4px}
.cal-p.published{border-left-color:var(--ok);background:var(--okbg)}.cal-p.pending,.cal-p.processing{border-left-color:var(--info);background:var(--infobg)}.cal-p.failed{border-left-color:var(--err);background:var(--errbg)}
.yt{font-size:10px;font-weight:700;color:#fff;background:#d42a2a;border-radius:4px;padding:0 4px}
.cal-legend{display:flex;gap:6px;align-items:center;margin:-4px 0 8px}.dot{display:inline-block;width:9px;height:9px;border-radius:3px;margin-left:8px}
.dot.published{background:var(--ok)}.dot.pending{background:var(--info)}.dot.failed{background:var(--err)}
</style></head><body><div class="wrap">
<header><h1>Personal Automation</h1><span class="dim">Read-only · updated ${fmt(now())} · refreshes every minute</span></header>
<nav class="tabs">${tabs}</nav>
<div class="stats">
  <div class="stat"><b>${totals?.leads || 0}</b><span>People triggered (7 days)</span></div>
  <div class="stat"><b>${totals?.links || 0}</b><span>Links delivered · ${pct(totals?.links, totals?.leads)}</span></div>
  <div class="stat"><b>${clickTot?.clicked || 0}</b><span>Opened the link · ${pct(clickTot?.clicked, totals?.links)}</span></div>
  <div class="stat"><b>${totals?.fups || 0}</b><span>Follow-ups sent</span></div>
  <div class="stat"><b>${upcoming.length}</b><span>Posts scheduled</span></div>
  <div class="stat"><b style="color:${totals?.errs ? "var(--err)" : "inherit"}">${totals?.errs || 0}</b><span>Failed DMs (7 days)</span></div>
  ${queued ? `<div class="stat"><b style="color:var(--warn)">${queued}</b><span>Messages queued (rate limit)</span></div>` : ""}
</div>
<h2>Accounts</h2><div class="accts">${accountCards}</div>
<h2>Automations</h2>
<div class="card"><table><thead><tr><th>Automation</th><th>Keyword</th><th>Post</th><th>DM button → link</th>
<th class="num">Triggered</th><th class="num">Waiting</th><th class="num">Link sent</th><th class="num">Opened</th><th class="num">Followed up</th></tr></thead><tbody>${ruleRows}</tbody></table></div>
<h2>Recent leads</h2>
<div class="card"><table><thead><tr><th>When</th><th>Person</th><th>Automation</th><th>Comment</th><th>Stage</th></tr></thead><tbody>${leadRows}</tbody></table></div>
<h2>Content calendar</h2>
<div class="cal-legend dim"><span class="dot published"></span>Posted <span class="dot pending"></span>Scheduled <span class="dot failed"></span>Failed · times in ${esc(tz)}</div>
<div class="card cal-wrap"><div class="cal">
${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="cal-h">${d}</div>`).join("")}
${Array.from({ length: 28 }, (_, i) => {
  const dayStart = calFrom + i * 86400;
  const today = Math.floor((now() + tzOffsetSec(tz)) / 86400) === startDay + i;
  const past = dayStart + 86400 <= now();
  const items = cal.filter((p) => p.ts >= dayStart && p.ts < dayStart + 86400);
  const label = new Date((dayStart + tzOffsetSec(tz)) * 1000).toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short" });
  return `<div class="cal-d${today ? " today" : ""}${past ? " past" : ""}"><div class="cal-n">${label}</div>${items.map((p) => {
    const st = p.status === "posted" ? "published" : p.status;
    const t = new Date((p.ts + tzOffsetSec(tz)) * 1000).toISOString().slice(11, 16);
    const title = esc((p.caption || "(no caption)").split("\n")[0].slice(0, 46));
    const inner = `<b>${t}</b> ${p.platform === "youtube" ? '<span class="yt">▶ YT</span> ' : p.platform === "linkedin" ? '<span class="yt" style="background:#0a66c2">in</span> ' : ""}${title}${p.keywords?.length ? ` <code>${esc(p.keywords.map((k) => k.toUpperCase()).join(","))}</code>` : ""}${sel ? "" : `<div class="dim">@${esc(p.username)}</div>`}`;
    return p.permalink ? `<a class="cal-p ${st}" href="${esc(p.permalink)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="cal-p ${st}" title="${esc(p.error || "")}">${inner}</div>`;
  }).join("")}</div>`;
}).join("")}
</div></div>
${ytAccts.length ? `<h2>YouTube</h2>
<div class="accts">${ytAccts.map((c) => `<div class="acct ${c.status !== "active" ? "bad" : ""}"><div class="acct-name">▶ ${esc(c.title)}</div>
  <div class="acct-meta"><span class="pill ${c.status === "active" ? "ok" : "err"}">${c.status === "active" ? "Connected" : esc(c.status.replace("_", " "))}</span>
  <span class="dim">API quota today: ${ytQuota.toLocaleString()} / 10,000</span></div>${c.error ? `<div class="acct-err">${esc(c.error)}</div>` : ""}</div>`).join("")}</div>
<div class="card" style="margin-top:12px"><table><thead><tr><th>Comment automation</th><th>Keyword</th><th>Video</th><th>Reply</th><th class="num">Replied</th><th class="num">Failed</th></tr></thead><tbody>
${ytRules.map((r) => `<tr class="${r.active ? "" : "off"}"><td class="strong">${esc(r.name)}</td><td>${JSON.parse(r.keywords).map((k) => `<code>${esc(k.toUpperCase())}</code>`).join(" ")}</td>
  <td>${JSON.parse(r.video_ids).includes("*") ? "Every video" : JSON.parse(r.video_ids).map((v) => `<a href="https://youtu.be/${esc(v)}" target="_blank" rel="noopener">${esc(v)} ↗</a>`).join(" ")}</td>
  <td class="dim">${r.mode === "description" ? "points to description" : `link: ${r.link_url ? `<a href="${esc(r.link_url)}" target="_blank" rel="noopener">open ↗</a>` : "—"}`}</td>
  <td class="num">${r.replied || 0}</td><td class="num">${r.failed || 0}</td></tr>`).join("") || `<tr><td colspan="6" class="empty">No YouTube automations yet.</td></tr>`}</tbody></table></div>
${ytReplies.length ? `<div class="card" style="margin-top:12px"><table><thead><tr><th>When</th><th>Viewer</th><th>Comment</th><th>Automation</th><th>Status</th></tr></thead><tbody>
${ytReplies.map((x) => `<tr><td class="dim nowrap">${ago(x.created)}</td><td>${esc(x.author)}</td><td class="clip">${esc(x.text)}</td><td>${esc(x.rule || "")}</td>
  <td><span class="pill ${x.status === "replied" ? "ok" : "err"}">${esc(x.status.replace("_", " "))}</span>${x.error ? `<div class="err-text">${esc(x.error.slice(0, 120))}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>` : ""}
${ytStats.length ? `<div class="card" style="margin-top:12px"><table><thead><tr><th>Video</th><th class="num">Views</th><th class="num">Likes</th><th class="num">Comments</th><th class="num">Watch min</th><th class="num">Auto-replies</th></tr></thead><tbody>
${ytStats.map((s) => `<tr><td><a class="strong" href="https://youtu.be/${esc(s.video_id)}" target="_blank" rel="noopener">${esc((s.title || "").slice(0, 70))}</a><div class="dim">${fmt(s.published)} · ${s.is_short ? "Short" : "Video"}</div></td>
  <td class="num">${s.views ?? "—"}</td><td class="num">${s.likes ?? "—"}</td><td class="num">${s.comments ?? "—"}</td><td class="num">${s.minutes ?? "—"}</td><td class="num">${s.replies || 0}</td></tr>`).join("")}</tbody></table></div>` : ""}` : ""}
<h2>Post performance</h2>
<div class="card"><table><thead><tr><th>Post</th><th class="num">Views</th><th class="num">Reach</th><th class="num">Likes</th><th class="num">Comments</th><th class="num">Saves</th>
<th class="num">Triggered</th><th class="num">Link sent</th><th class="num">Opened</th><th class="num">Loved it</th></tr></thead><tbody>${posts.map((p) => `<tr>
  <td><a href="${esc(p.permalink || "#")}" target="_blank" rel="noopener" class="strong">${esc((p.caption || "(no caption)").split("\n")[0].slice(0, 60))}</a>
      <div class="dim">${fmt(p.posted)} · ${esc((p.media_type || "").toLowerCase().replace("_", " "))}${sel ? "" : ` · @${esc(p.username)}`}</div></td>
  <td class="num">${p.views ?? "—"}</td><td class="num">${p.reach ?? "—"}</td><td class="num">${p.likes ?? "—"}</td><td class="num">${p.comments ?? "—"}</td><td class="num">${p.saves ?? "—"}</td>
  <td class="num">${p.triggered || 0}</td><td class="num">${p.links || 0}</td>
  <td class="num">${p.clicked || 0} <span class="dim">${pct(p.clicked, p.links)}</span></td><td class="num">${p.loved || 0}</td></tr>`).join("") ||
  `<tr><td colspan="10" class="empty">No stats yet. They refresh every 6 hours (or run ./pa.py stats --refresh).</td></tr>`}</tbody></table></div>
<h2>Scheduled posts</h2>
<div class="card"><table><thead><tr><th>Publishes</th><th>Account</th><th>Type</th><th>Caption</th><th>Auto-DM</th><th>Status</th></tr></thead>
<tbody>${upcoming.map(postRow).join("") || `<tr><td colspan="6" class="empty">Nothing scheduled.</td></tr>`}</tbody></table></div>
${recentPosts.length ? `<h2>Recently published</h2><div class="card"><table><thead><tr><th>Published</th><th>Account</th><th>Type</th><th>Caption</th><th>Auto-DM</th><th>Status</th></tr></thead><tbody>${recentPosts.map(postRow).join("")}</tbody></table></div>` : ""}
<h2>Activity</h2><div class="card"><ul class="log">${eventRows}</ul></div>
</div></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
