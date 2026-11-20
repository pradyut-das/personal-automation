// Email alerts via Resend.
// - errors/warnings are grouped (same kind of problem = one alert per hour) and sent as a digest at most every 15 min
// - urgent ones ("Need help" replies, account/token problems) go out immediately
// - daily summary of the last 24h
// Needs secrets RESEND_API_KEY + ALERT_EMAIL (and optionally ALERT_FROM, a sender on your verified Resend domain).
import { now } from "./ig.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const keyOf = (s) => String(s).replace(/@[\w.]+|\b\d{3,}\b|"[^"]*"/g, "").replace(/\s+/g, " ").slice(0, 90);

export async function alert(env, level, subject, body = "", key = null) {
  const k = key || keyOf(subject);
  const dup = await env.DB.prepare("SELECT id FROM alerts WHERE key = ? AND ts > ? LIMIT 1").bind(k, now() - 3600).first();
  if (dup) return;
  await env.DB.prepare("INSERT INTO alerts (ts, level, key, subject, body) VALUES (?, ?, ?, ?, ?)").bind(now(), level, k, subject.slice(0, 300), String(body).slice(0, 4000)).run();
  if (level === "urgent") await flushAlerts(env, true);
}

export async function sendEmail(env, subject, html) {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.ALERT_FROM || "Personal Automation <onboarding@resend.dev>",
      to: env.ALERT_EMAIL.split(",").map((s) => s.trim()),
      subject,
      html,
    }),
  });
  if (!r.ok) {
    console.log("resend failed", r.status, await r.text());
    return false;
  }
  return true;
}

const shell = (title, inner, env) => `<!doctype html><html><body style="margin:0;background:#F3FCFE;font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#002B36">
<div style="max-width:560px;margin:0 auto;padding:24px 16px"><div style="font-weight:700;font-size:18px;margin-bottom:12px">${esc(title)}</div>${inner}
<p style="margin-top:24px;font-size:13px;color:#4d6b73"><a href="${esc(env.PUBLIC_URL || "")}/" style="color:#007fa6">Open dashboard</a></p></div></body></html>`;

export async function flushAlerts(env, force = false) {
  const { results } = await env.DB.prepare("SELECT * FROM alerts WHERE sent = 0 ORDER BY id LIMIT 50").all();
  if (!results.length) return;
  const last = Number((await env.DB.prepare("SELECT v FROM kv WHERE k = 'last_alert_email'").first())?.v || 0);
  const urgent = results.some((a) => a.level === "urgent");
  if (!force && !urgent && now() - last < 15 * 60) return;

  const subject = results.length === 1 ? results[0].subject : `${urgent ? "🙋 " : "⚠️ "}${results.length} Automation alerts`;
  const color = { urgent: "#a36200", error: "#d42a56", warn: "#a36200" };
  const html = shell(urgent ? "Needs your attention" : "Automation alerts", results.map((a) => `
    <div style="background:#fff;border:1px solid #d6eef3;border-left:4px solid ${color[a.level] || "#4d6b73"};border-radius:8px;padding:10px 12px;margin:8px 0">
      <div style="font-weight:600">${esc(a.subject)}</div>
      ${a.body ? `<div style="font-size:13px;color:#4d6b73;white-space:pre-wrap">${esc(a.body)}</div>` : ""}
      <div style="font-size:12px;color:#8aa">${new Date(a.ts * 1000).toLocaleString("en-IN", { timeZone: env.TZ || "UTC" })}</div></div>`).join(""), env);

  if (await sendEmail(env, subject, html)) {
    await env.DB.prepare(`UPDATE alerts SET sent = 1 WHERE id IN (${results.map(() => "?").join(",")})`).bind(...results.map((a) => a.id)).run();
    await env.DB.prepare("INSERT INTO kv (k, v) VALUES ('last_alert_email', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(String(now())).run();
  }
}

export async function dailySummary(env) {
  const since = now() - 86400;
  const { results: accts } = await env.DB.prepare("SELECT ig_user_id, username, status, token_expires FROM accounts").all();
  const rows = [];
  for (const a of accts) {
    const s = await env.DB.prepare(
      `SELECT COUNT(*) AS leads, SUM(stage IN ('link_sent','followed_up')) AS links, SUM(clicks > 0) AS opened,
              SUM(feedback = 'loved') AS loved, SUM(feedback = 'help') AS help, SUM(stage = 'error') AS errors
       FROM leads WHERE ig_user_id = ? AND created >= ?`
    ).bind(a.ig_user_id, since).first();
    const pub = await env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE ig_user_id = ? AND status = 'published' AND publish_at >= ?").bind(a.ig_user_id, since).first();
    const days = a.token_expires ? Math.floor((a.token_expires - now()) / 86400) : null;
    rows.push({ ...a, ...s, published: pub?.n || 0, days });
  }
  const queued = (await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first())?.n || 0;
  const dead = (await env.DB.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE status = 'dead' AND received >= ?").bind(since).first())?.n || 0;
  const cell = "padding:6px 8px;border-bottom:1px solid #d6eef3;text-align:right";
  const html = shell("Yesterday", `
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #d6eef3;border-radius:8px;font-size:14px">
      <tr style="color:#4d6b73;font-size:12px"><th style="${cell};text-align:left">Account</th><th style="${cell}">Leads</th><th style="${cell}">Links</th><th style="${cell}">Opened</th><th style="${cell}">Loved</th><th style="${cell}">Posts</th></tr>
      ${rows.map((r) => `<tr><td style="${cell};text-align:left">@${esc(r.username)}${r.status !== "active" ? ` <b style="color:#d42a56">${esc(r.status)}</b>` : ""}${r.days !== null && r.days < 14 ? `<div style="font-size:12px;color:#a36200">token renews in ${r.days}d</div>` : ""}</td>
        <td style="${cell}">${r.leads || 0}</td><td style="${cell}">${r.links || 0}</td><td style="${cell}">${r.opened || 0}</td><td style="${cell}">${r.loved || 0}</td><td style="${cell}">${r.published}</td></tr>`).join("")}
    </table>
    ${rows.some((r) => r.help) ? `<p>🙋 ${rows.reduce((n, r) => n + (r.help || 0), 0)} people asked for help, reply to them in Instagram.</p>` : ""}
    ${rows.some((r) => r.errors) || queued || dead ? `<p style="color:#a36200">${[rows.reduce((n, r) => n + (r.errors || 0), 0) && `${rows.reduce((n, r) => n + (r.errors || 0), 0)} failed DMs`, queued && `${queued} messages waiting in the rate-limit queue`, dead && `${dead} webhook events failed after 5 retries`].filter(Boolean).join(" · ")}</p>` : `<p>No problems 👌</p>`}`, env);
  return sendEmail(env, `Daily: ${rows.reduce((n, r) => n + (r.leads || 0), 0)} leads, ${rows.reduce((n, r) => n + (r.opened || 0), 0)} opened`, html);
}

// warn ~10 days before a token expires (the weekly refresh should keep it far away)
export async function checkTokens(env) {
  const { results } = await env.DB.prepare("SELECT username, status, token_expires FROM accounts").all();
  for (const a of results) {
    if (a.status === "token_error") await alert(env, "urgent", `@${a.username} is disconnected: token refresh failed`, "Reconnect it with ./pa.py connect", `token-${a.username}`);
    else if (a.token_expires && a.token_expires - now() < 10 * 86400) await alert(env, "error", `@${a.username}'s token expires in ${Math.floor((a.token_expires - now()) / 86400)} days`, "Automatic refresh hasn't worked. Reconnect with ./pa.py connect", `exp-${a.username}`);
  }
}
