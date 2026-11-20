import { ig, now, logEvent, getAccount, upsertAccount, refreshTokens, resolveMedia, hmacHex, safeEqual } from "./ig.js";
import { runFollowups, trackClick } from "./automation.js";
import { storeEvent, processEvent, retryEvents } from "./webhooks.js";
import { flushAlerts, dailySummary, checkTokens, alert, sendEmail } from "./alerts.js";
import { runScheduler } from "./scheduler.js";
import { renderDashboard } from "./dashboard.js";
import { DEFAULTS, fill } from "./replies.js";
import { drainOutbox } from "./sender.js";
import { serveMedia, flipbookPage } from "./media.js";
import { refreshStats, postAnalytics } from "./stats.js";
import { calendarItems } from "./calendar.js";
import { liConnectUrl, liOauthCallback, runLinkedIn, checkLiTokens, liAccount } from "./linkedin.js";
import { ytConnectUrl, ytOauthCallback, pollComments, runYtUploads, refreshYtStats, videoIdFrom, ytAccount, quotaUsed, setDescriptionLink } from "./youtube.js";

const json = (d, status = 200) => Response.json(d, { status });
const SCOPES = "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_messages,instagram_business_manage_comments,instagram_business_manage_insights";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/webhook") return webhook(req, env, ctx, url);
      if (p === "/oauth/callback") return oauthCallback(env, url);
      if (p === "/yt/oauth/callback") return ytOauthCallback(env, url);
      if (p === "/li/oauth/callback") return liOauthCallback(env, url);
      if (p.startsWith("/api/")) {
        if (!safeEqual(req.headers.get("authorization") || "", `Bearer ${env.ADMIN_KEY}`)) return json({ error: "unauthorized" }, 401);
        return await api(req, env, url);
      }
      if (p === "/" || p === "/dashboard") {
        if (!viewerOk(req, env)) {
          return new Response("Sign in required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Personal Automation", charset="UTF-8"' } });
        }
        return await renderDashboard(env, url);
      }
      if (p === "/health") return health(env);
      if (p.startsWith("/r/")) {
        const to = await trackClick(env, p.slice(3), req.headers.get("user-agent"));
        return to ? Response.redirect(to, 302) : new Response("Link not found", { status: 404 });
      }
      if (p.startsWith("/m/") && (req.method === "GET" || req.method === "HEAD")) return serveMedia(req, env, decodeURIComponent(p.slice(3)));
      if (p.startsWith("/f/")) {
        const key = decodeURIComponent(p.slice(3));
        const head = await env.MEDIA.head(key);
        if (!head) return new Response("not found", { status: 404 });
        return flipbookPage(key, url.searchParams.get("t") || key.split("/").pop().replace(/^[a-z0-9]+-/, "").replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), head.etag);
      }
      if (p === "/privacy") return legalPage("Privacy Policy", PRIVACY(env));
      if (p === "/data-deletion") return legalPage("Data Deletion", DELETION(env));
      return new Response("not found", { status: 404 });
    } catch (e) {
      console.log(e.stack || e);
      return json({ error: e.message }, e.status || 500);
    }
  },

  async scheduled(ev, env, ctx) {
    try {
      if (ev.cron === "0 3 * * *") {
        await refreshTokens(env);
        await checkTokens(env);
        await checkLiTokens(env);
        await env.DB.batch([
          env.DB.prepare("DELETE FROM events WHERE ts < ?").bind(now() - 60 * 86400),
          env.DB.prepare("DELETE FROM sends WHERE ts < ?").bind(now() - 2 * 86400),
          env.DB.prepare("DELETE FROM webhook_events WHERE status = 'done' AND received < ?").bind(now() - 14 * 86400),
          env.DB.prepare("DELETE FROM webhook_events WHERE status = 'dead' AND received < ?").bind(now() - 30 * 86400),
          env.DB.prepare("DELETE FROM alerts WHERE sent = 1 AND ts < ?").bind(now() - 30 * 86400),
        ]);
        await dailySummary(env);
        return;
      }
      if (ev.cron === "30 */6 * * *") return void (await Promise.allSettled([refreshStats(env), refreshYtStats(env)]));

      // every minute; the lock stops two overlapping runs from double-sending
      if (!(await lock(env, "minute", 110))) return;
      try {
        const jobs = { retryEvents, runFollowups, runScheduler, drainOutbox, flushAlerts, pollComments, runYtUploads, runLinkedIn };
        const res = await Promise.allSettled(Object.values(jobs).map((f) => f(env)));
        for (const [i, r] of res.entries()) {
          if (r.status === "rejected") await alert(env, "error", `Background job ${Object.keys(jobs)[i]} crashed`, String(r.reason?.stack || r.reason).slice(0, 600));
        }
      } finally {
        await env.DB.prepare("UPDATE locks SET until = 0 WHERE name = 'minute'").run();
      }
    } catch (e) {
      console.log("cron failed", e.stack || e);
    }
  },
};

async function lock(env, name, ttl) {
  const r = await env.DB.prepare(
    "INSERT INTO locks (name, until) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET until = excluded.until WHERE locks.until < ?"
  ).bind(name, now() + ttl, now()).run();
  return r.meta.changes > 0;
}

async function health(env) {
  try {
    const [ev, q, acc] = await Promise.all([
      env.DB.prepare("SELECT MAX(received) AS last, SUM(status IN ('failed','processing') AND received < ?) AS stuck, SUM(status = 'dead') AS dead FROM webhook_events").bind(now() - 600).first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first(),
      env.DB.prepare("SELECT SUM(status = 'active') AS ok, SUM(status != 'active') AS bad FROM accounts").first(),
    ]);
    const ok = !acc?.bad && !ev?.stuck;
    return json({ ok, last_webhook: ev?.last || null, retrying_events: ev?.stuck || 0, dead_events: ev?.dead || 0, queued_messages: q?.n || 0,
      accounts_ok: acc?.ok || 0, accounts_with_problems: acc?.bad || 0 }, ok ? 200 : 503);
  } catch (e) {
    return json({ ok: false, error: "database unavailable" }, 503);
  }
}

// ---------- public legal pages (required by Meta to publish the app) ----------
// set OWNER_NAME, OWNER_HANDLE (your Instagram username) and POLICY_DATE in wrangler.toml [vars]
const owner = (env) => ({ name: env.OWNER_NAME || "the account owner", handle: (env.OWNER_HANDLE || "").replace(/^@/, ""), date: env.POLICY_DATE || "" });
const igLink = (o) => o.handle ? `<a href="https://instagram.com/${o.handle}">@${o.handle}</a>` : "us";
const PRIVACY = (env) => { const o = owner(env), UPDATED = o.date; return `
${UPDATED ? `<p>Last updated: ${UPDATED}</p>` : ""}
<p>This tool is operated by ${o.name} (Instagram ${igLink(o)}) to manage our own Instagram professional accounts: scheduling posts and replying to people who comment on or message those accounts.</p>
<h2>What we collect</h2>
<p>When you comment on one of our posts or send one of our accounts a message, Instagram shares with us your Instagram-scoped ID, your username, and the text of the comment or message. We store this only so we can reply to you (for example, send the link you asked for) and avoid messaging you twice.</p>
<h2>How we use it</h2>
<p>Only to reply to your comment or message on Instagram. We never sell your data, use it for advertising, or share it with anyone except the service providers that run this tool (Meta/Instagram and Cloudflare, which hosts it).</p>
<h2>How long we keep it</h2>
<p>Activity logs are deleted after 60 days. Records of who received which message are kept while the related automation is active, and you can ask us to delete them at any time.</p>
<h2>Your choices</h2>
<p>To have your data deleted, follow the steps on our <a href="/data-deletion">data deletion page</a>. For any question, message ${igLink(o)} on Instagram.</p>`; };
const DELETION = (env) => { const o = owner(env), UPDATED = o.date; return `
${UPDATED ? `<p>Last updated: ${UPDATED}</p>` : ""}
<p>To delete the data this tool holds about you (your Instagram-scoped ID, username and the comments or messages you sent us):</p>
<ol><li>Send a direct message on Instagram to ${igLink(o)} saying <b>"delete my data"</b>.</li>
<li>We delete every record linked to your Instagram account within 30 days and reply to confirm.</li></ol>
<p>You can also remove this app's access at any time in Instagram: Settings → Website permissions → Apps and websites.</p>`; };

function legalPage(title, body) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>:root{--bg:#F3FCFE;--ink:#002B36;--a:#007fa6}@media (prefers-color-scheme:dark){:root{--bg:#00222b;--ink:#E6FBFF;--a:#00F5FF}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif}main{max-width:680px;margin:0 auto;padding:40px 16px 64px}
a{color:var(--a)}h1{font-size:28px}h2{font-size:18px;margin-top:28px}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
}

function viewerOk(req, env) {
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ") || !env.VIEW_PASSWORD) return false;
  let decoded = "";
  try { decoded = atob(h.slice(6)); } catch { return false; }
  const pass = decoded.slice(decoded.indexOf(":") + 1);
  return safeEqual(pass, env.VIEW_PASSWORD);
}

// ---------- Meta webhook ----------
async function webhook(req, env, ctx, url) {
  if (req.method === "GET") {
    const q = url.searchParams;
    if (q.get("hub.mode") === "subscribe" && q.get("hub.verify_token") === env.VERIFY_TOKEN) return new Response(q.get("hub.challenge"));
    return new Response("forbidden", { status: 403 });
  }
  const raw = await req.text();
  const sig = (req.headers.get("x-hub-signature-256") || "").replace(/^sha256=/, "");
  if (!safeEqual(sig, await hmacHex(env.IG_APP_SECRET, raw))) return new Response("bad signature", { status: 401 });
  try { JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }

  // saved before we answer: if we can't save it, Meta gets a 500 and redelivers
  const id = await storeEvent(env, raw);
  if (id) ctx.waitUntil(processEvent(env, id, raw));
  return new Response("ok");
}

// ---------- connect an account (Instagram Business Login) ----------
const redirectUri = (url) => `${url.origin}/oauth/callback`;

async function connectUrl(env, url) {
  if (!env.IG_APP_ID) throw Object.assign(new Error("IG_APP_ID is not set in wrangler.toml"), { status: 400 });
  const ts = String(now());
  const state = `${ts}.${(await hmacHex(env.ADMIN_KEY, `oauth:${ts}`)).slice(0, 32)}`;
  const q = new URLSearchParams({ client_id: env.IG_APP_ID, redirect_uri: redirectUri(url), response_type: "code", scope: SCOPES, state, enable_fb_login: "0", force_reauth: "true" });
  return `https://www.instagram.com/oauth/authorize?${q}`;
}

async function oauthCallback(env, url) {
  const page = (title, msg) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<body style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:0 16px;color:#002B36;background:#F3FCFE"><h2>${title}</h2><p>${msg}</p></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
  const [ts, sig] = (url.searchParams.get("state") || "").split(".");
  const expect = ts ? (await hmacHex(env.ADMIN_KEY, `oauth:${ts}`)).slice(0, 32) : "";
  if (!sig || !safeEqual(sig, expect) || now() - Number(ts) > 3600) return page("Link expired", "Ask for a new connect link.");
  if (url.searchParams.get("error")) return page("Not connected", "Instagram login was cancelled.");

  const form = new URLSearchParams({ client_id: env.IG_APP_ID, client_secret: env.IG_APP_SECRET, grant_type: "authorization_code", redirect_uri: redirectUri(url), code: url.searchParams.get("code") || "" });
  const r = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
  const d = await r.json();
  const short = d.access_token || d.data?.[0]?.access_token;
  if (!short) return page("Not connected", `Instagram said: ${String(d.error_message || d.error?.message || "unknown error").replace(/</g, "&lt;")}`);

  const l = await (await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${env.IG_APP_SECRET}&access_token=${short}`)).json();
  if (!l.access_token) return page("Not connected", "Couldn't get a long-lived token. Try again.");
  const a = await upsertAccount(env, l.access_token, l.expires_in);
  return page("Connected ✅", `@${a.username} is connected. You can close this tab.`);
}

// ---------- admin API (used by pa.py) ----------
const BTN_MAX = 20;
const TRIGGERS = ["comment", "dm", "story_reply", "story_mention"];

function ruleDefaults(r) {
  const triggers = (r.triggers?.length ? r.triggers : ["comment", ...(r.dm_trigger === false ? [] : ["dm"])]).filter((t) => TRIGGERS.includes(t));
  let keywords = (r.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
  if (!keywords.length && triggers.every((t) => t === "story_mention" || t === "story_reply")) keywords = ["*"];
  return {
    name: r.name,
    triggers,
    keywords,
    thing: r.thing || "",
    require_follow: !!r.require_follow,
    opener_text: r.opener_text || "",            // "" = default copy for the trigger
    ask_button: r.ask_button || "",
    link_text: r.link_text || "",
    link_title: r.link_title || "",
    link_url: r.link_url,
    followup_text: r.followup_text || null,      // null = default copy
    review_text: r.review_text || null,
    followup_mins: r.followup === false ? 0 : Number(r.followup_mins || DEFAULTS.followup_mins),
    public_replies: r.public_replies?.length ? r.public_replies : null,
    dm_trigger: triggers.includes("dm"),
  };
}

function validateRule(r) {
  const errs = [];
  if (!r.name) errs.push("name");
  if (!r.triggers.length) errs.push("at least one trigger");
  if (!r.keywords.length) errs.push("keywords");
  if (!/^https:\/\//.test(r.link_url || "")) errs.push("link_url must be https");
  const v = { thing: r.thing || DEFAULTS.thing };
  if (fill(r.ask_button || DEFAULTS.ask_button, v).length > BTN_MAX) errs.push(`button text "${fill(r.ask_button || DEFAULTS.ask_button, v)}" is over ${BTN_MAX} chars (shorten --thing or set --button)`);
  if (fill(r.link_title || DEFAULTS.link_title, v).length > BTN_MAX) errs.push(`link button "${fill(r.link_title || DEFAULTS.link_title, v)}" is over ${BTN_MAX} chars (set --link-title)`);
  if (r.followup_mins && (r.followup_mins < 1 || r.followup_mins > 1380)) errs.push("followup_mins 1-1380 (must be inside Instagram's 24h window)");
  if (errs.length) throw Object.assign(new Error(`invalid automation: ${errs.join(", ")}`), { status: 400 });
}

export async function insertRule(env, acctId, r, mediaIds, permalink) {
  await env.DB.prepare(
    `INSERT INTO rules (ig_user_id, name, media_ids, permalink, keywords, require_follow, opener_text, ask_button, link_text,
      link_title, link_url, followup_text, followup_mins, public_replies, dm_trigger, triggers, thing, review_text, active, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(acctId, r.name, JSON.stringify(mediaIds), permalink || null, JSON.stringify(r.keywords), r.require_follow ? 1 : 0,
    r.opener_text || "", r.ask_button || "", r.link_text || "", r.link_title || "", r.link_url, r.followup_text ?? null, r.followup_mins ?? 60,
    r.public_replies ? JSON.stringify(r.public_replies) : null, r.dm_trigger ? 1 : 0, JSON.stringify(r.triggers), r.thing || "", r.review_text ?? null, now()).run();
}

async function keywordClashes(env, acctId, keywords, mediaIds) {
  const { results } = await env.DB.prepare("SELECT name, keywords, media_ids FROM rules WHERE ig_user_id = ? AND active = 1").bind(acctId).all();
  return results.filter((x) => JSON.parse(x.keywords).some((k) => keywords.includes(k)))
    .map((x) => ({ name: x.name, same_post: !mediaIds || JSON.parse(x.media_ids).some((m) => mediaIds.includes(m)) }));
}

async function needAccount(env, ref) {
  const a = ref ? await getAccount(env, ref) : (await env.DB.prepare("SELECT * FROM accounts").all()).results.length === 1 ? await env.DB.prepare("SELECT * FROM accounts").first() : null;
  if (!a) throw Object.assign(new Error(ref ? `account ${ref} not found` : "several accounts connected; pass account"), { status: 400 });
  return a;
}

async function api(req, env, url) {
  const path = url.pathname.slice(5);
  const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await req.json() : {};
  const m = req.method;

  if (path === "accounts" && m === "GET") {
    return json((await env.DB.prepare("SELECT ig_user_id, username, status, token_expires, error, created FROM accounts ORDER BY username").all()).results);
  }
  if (path === "accounts/import" && m === "POST") return json(await upsertAccount(env, body.token, body.expires_in));
  if (path === "accounts/connect-url" && m === "GET") return json({ url: await connectUrl(env, url) });
  if (path.startsWith("accounts/") && m === "PATCH") {
    const a = await needAccount(env, decodeURIComponent(path.split("/")[1]));
    await env.DB.prepare("UPDATE accounts SET status = ? WHERE ig_user_id = ?").bind(body.status === "paused" ? "paused" : "active", a.ig_user_id).run();
    return json({ ok: true });
  }

  if (path === "rules" && m === "GET") {
    const a = url.searchParams.get("account") ? await needAccount(env, url.searchParams.get("account")) : null;
    const { results } = await env.DB.prepare(
      `SELECT r.*, a.username, (SELECT COUNT(*) FROM leads l WHERE l.rule_id = r.id) AS leads,
              (SELECT COUNT(*) FROM leads l WHERE l.rule_id = r.id AND l.stage IN ('link_sent','followed_up')) AS links
       FROM rules r JOIN accounts a ON a.ig_user_id = r.ig_user_id ${a ? "WHERE r.ig_user_id = ?" : ""} ORDER BY r.created DESC`
    ).bind(...(a ? [a.ig_user_id] : [])).all();
    return json(results);
  }
  if (path === "rules/check" && m === "POST") {
    const a = await needAccount(env, body.account);
    validateRule(ruleDefaults(body));
    return json({ clashes: await keywordClashes(env, a.ig_user_id, ruleDefaults(body).keywords, null) });
  }
  if (path === "rules" && m === "POST") {
    const a = await needAccount(env, body.account);
    const r = ruleDefaults(body);
    validateRule(r);
    // which posts: a specific post, "any" (every post), or none needed (DM / story triggers only)
    const ref = String(body.post || "").trim().toLowerCase();
    let media = { id: "*", permalink: null };
    if (ref && ref !== "any" && ref !== "*") media = await resolveMedia(a, String(body.post));
    else if (!ref && r.triggers.includes("comment")) throw Object.assign(new Error("comment automations need --post (a post link, or 'any' for every post)"), { status: 400 });
    const clashes = await keywordClashes(env, a.ig_user_id, r.keywords, [media.id]);
    if (clashes.some((c) => c.same_post)) throw Object.assign(new Error(`keyword already used on this post by ${clashes.map((c) => c.name).join(", ")}`), { status: 409 });
    await insertRule(env, a.ig_user_id, r, [media.id], media.permalink);
    await logEvent(env, a.ig_user_id, "info", `automation ${r.name} created (${r.triggers.join("+")}) on ${media.id === "*" ? "every post" : media.permalink || media.id} for ${r.keywords.join(", ")}`);
    return json({ ok: true, media, clashes });
  }
  if (path.startsWith("rules/") && (m === "PATCH" || m === "DELETE")) {
    const a = await needAccount(env, url.searchParams.get("account"));
    const name = decodeURIComponent(path.split("/")[1]);
    const res = m === "DELETE"
      ? await env.DB.prepare("DELETE FROM rules WHERE ig_user_id = ? AND name = ?").bind(a.ig_user_id, name).run()
      : await env.DB.prepare("UPDATE rules SET active = ? WHERE ig_user_id = ? AND name = ?").bind(body.active ? 1 : 0, a.ig_user_id, name).run();
    if (!res.meta.changes) return json({ error: "not found" }, 404);
    await logEvent(env, a.ig_user_id, "info", `automation ${name} ${m === "DELETE" ? "deleted" : body.active ? "resumed" : "paused"}`);
    return json({ ok: true });
  }

  if (path === "posts" && m === "GET") {
    return json((await env.DB.prepare("SELECT p.*, a.username FROM posts p JOIN accounts a ON a.ig_user_id = p.ig_user_id ORDER BY publish_at DESC LIMIT 100").all()).results);
  }
  if (path === "posts" && m === "POST") {
    const a = await needAccount(env, body.account);
    const media = body.media || [];
    if (!media.length || media.some((x) => !/^https:\/\//.test(x))) throw Object.assign(new Error("media must be https URLs (pa.py uploads local files for you)"), { status: 400 });
    if (body.type === "carousel" ? media.length < 2 || media.length > 10 : media.length !== 1) throw Object.assign(new Error("wrong number of media for type"), { status: 400 });
    let autodm = null;
    if (body.autodm) {
      autodm = ruleDefaults(body.autodm);
      validateRule(autodm);
    }
    const id = crypto.randomUUID().slice(0, 6);
    await env.DB.prepare(
      "INSERT INTO posts (id, ig_user_id, publish_at, type, media, caption, cover, status, autodm, uploads, created) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)"
    ).bind(id, a.ig_user_id, body.publish_at, body.type, JSON.stringify(media), body.caption || "", body.cover || null, autodm ? JSON.stringify(autodm) : null,
      body.uploads?.length ? JSON.stringify(body.uploads) : null, now()).run();
    await logEvent(env, a.ig_user_id, "info", `post ${id} (${body.type}) scheduled for ${new Date(body.publish_at * 1000).toISOString()}${autodm ? ` with auto-DM ${autodm.keywords.join(",")}` : ""}`);
    return json({ id });
  }
  if (path === "calendar" && m === "GET") {
    const back = Number(url.searchParams.get("days_back") || 7), ahead = Number(url.searchParams.get("days_ahead") || 21);
    return json(await calendarItems(env, now() - back * 86400, now() + ahead * 86400));
  }
  if (path.startsWith("posts/") && path.split("/").length === 2 && m === "PATCH") {
    const id = path.split("/")[1];
    const sets = [], vals = [];
    if (typeof body.caption === "string") { sets.push("caption = ?"); vals.push(body.caption); }
    if (body.publish_at) { sets.push("publish_at = ?"); vals.push(Number(body.publish_at)); }
    if (typeof body.cover === "string") {
      if (!/^https:\/\//.test(body.cover)) return json({ error: "cover must be an https URL" }, 400);
      sets.push("cover = ?"); vals.push(body.cover);
    }
    if (Array.isArray(body.add_uploads) && body.add_uploads.length) {
      const cur = await env.DB.prepare("SELECT uploads FROM posts WHERE id = ?").bind(path.split("/")[1]).first();
      sets.push("uploads = ?"); vals.push(JSON.stringify([...(cur?.uploads ? JSON.parse(cur.uploads) : []), ...body.add_uploads]));
    }
    if (!sets.length) return json({ error: "nothing to change" }, 400);
    const res = await env.DB.prepare(`UPDATE posts SET ${sets.join(", ")} WHERE id = ? AND status = 'pending'`).bind(...vals, id).run();
    if (!res.meta.changes) return json({ error: "not found, or already publishing/published" }, 404);
    const p = await env.DB.prepare("SELECT ig_user_id FROM posts WHERE id = ?").bind(id).first();
    await logEvent(env, p.ig_user_id, "info", `post ${id} edited (${sets.map((x) => x.split(" ")[0]).join(", ")})`);
    return json({ ok: true });
  }
  if (path.startsWith("posts/") && m === "DELETE") {
    const res = await env.DB.prepare("DELETE FROM posts WHERE id = ? AND status = 'pending'").bind(path.split("/")[1]).run();
    return res.meta.changes ? json({ ok: true }) : json({ error: "not found or already publishing" }, 404);
  }
  if (path.startsWith("posts/") && path.endsWith("/now") && m === "POST") {
    await env.DB.prepare("UPDATE posts SET publish_at = ? WHERE id = ? AND status = 'pending'").bind(now(), path.split("/")[1]).run();
    return json({ ok: true, note: "publishes within a minute" });
  }

  if (path === "leads" && m === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT l.*, r.name AS rule, a.username AS account FROM leads l JOIN rules r ON r.id = l.rule_id JOIN accounts a ON a.ig_user_id = l.ig_user_id ORDER BY l.updated DESC LIMIT ?"
    ).bind(Number(url.searchParams.get("limit") || 50)).all();
    return json(results);
  }
  if (path === "events" && m === "GET") {
    const { results } = await env.DB.prepare(
      "SELECT e.*, a.username FROM events e LEFT JOIN accounts a ON a.ig_user_id = e.ig_user_id ORDER BY e.id DESC LIMIT ?"
    ).bind(Number(url.searchParams.get("limit") || 30)).all();
    return json(results);
  }
  if (path === "stats" && m === "GET") {
    const a = url.searchParams.get("account") ? await needAccount(env, url.searchParams.get("account")) : null;
    return json(await postAnalytics(env, a?.ig_user_id, Number(url.searchParams.get("limit") || 30)));
  }
  if (path === "stats/refresh" && m === "POST") return json({ refreshed: await refreshStats(env) });
  if (path === "outbox" && m === "GET") {
    return json((await env.DB.prepare("SELECT id, ig_user_id, kind, label, attempts, next_try, created FROM outbox ORDER BY id").all()).results);
  }
  // ---------- LinkedIn ----------
  if (path === "li/connect-url" && m === "GET") return json({ url: await liConnectUrl(env) });
  if (path === "li/accounts" && m === "GET") {
    return json((await env.DB.prepare("SELECT person_urn, name, email, expires, status, error FROM li_accounts").all()).results);
  }
  if (path === "li/posts" && m === "GET") {
    return json((await env.DB.prepare("SELECT p.id, p.publish_at, p.text, p.kind, p.status, p.permalink, p.error, a.name FROM li_posts p JOIN li_accounts a ON a.person_urn = p.person_urn ORDER BY p.publish_at DESC LIMIT 50").all()).results);
  }
  if (path === "li/posts" && m === "POST") {
    const a = await liAccount(env, body.account);
    const kinds = ["text", "image", "images", "video", "document"];
    if (!body.text || !kinds.includes(body.kind) || !body.publish_at) return json({ error: "text, kind and publish_at required" }, 400);
    if (body.text.length > 3000) return json({ error: `post is ${body.text.length} chars; LinkedIn allows 3,000` }, 400);
    const media = body.media || [];
    if (body.kind === "text" ? media.length : body.kind === "images" ? media.length < 2 || media.length > 20 : media.length !== 1) return json({ error: "wrong number of media files for this kind" }, 400);
    for (const md of media) if (!(await env.MEDIA.head(md.key))) return json({ error: `uploaded file missing: ${md.key}` }, 400);
    const id = crypto.randomUUID().slice(0, 6);
    await env.DB.prepare("INSERT INTO li_posts (id, person_urn, publish_at, text, kind, media, status, created) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
      .bind(id, a.person_urn, Number(body.publish_at), body.text, body.kind, media.length ? JSON.stringify(media) : null, now()).run();
    await logEvent(env, null, "info", `LinkedIn ${body.kind} post ${id} scheduled for ${new Date(body.publish_at * 1000).toISOString()}`);
    return json({ id });
  }
  if (path.startsWith("li/posts/") && m === "PATCH") {
    const id = path.split("/")[2];
    const sets = [], vals = [];
    if (typeof body.text === "string") { sets.push("text = ?"); vals.push(body.text); }
    if (body.publish_at) { sets.push("publish_at = ?"); vals.push(Number(body.publish_at)); }
    if (!sets.length) return json({ error: "nothing to change" }, 400);
    const res = await env.DB.prepare(`UPDATE li_posts SET ${sets.join(", ")} WHERE id = ? AND status IN ('pending','processing')`).bind(...vals, id).run();
    return res.meta.changes ? json({ ok: true }) : json({ error: "not found or already published" }, 404);
  }
  if (path.startsWith("li/posts/") && m === "DELETE") {
    const id = path.split("/")[2];
    const p = await env.DB.prepare("SELECT media FROM li_posts WHERE id = ? AND status IN ('pending','failed')").bind(id).first();
    if (!p) return json({ error: "not found or already uploading/published" }, 404);
    for (const md of p.media ? JSON.parse(p.media) : []) { try { await env.MEDIA.delete(md.key); } catch {} }
    await env.DB.prepare("DELETE FROM li_posts WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }

  // ---------- YouTube ----------
  if (path === "yt/connect-url" && m === "GET") return json({ url: await ytConnectUrl(env) });
  if (path === "yt/accounts" && m === "GET") {
    const rows = (await env.DB.prepare("SELECT channel_id, title, handle, status, error, created FROM yt_accounts ORDER BY title").all()).results;
    return json({ accounts: rows, quota_used_today: await quotaUsed(env), quota_limit: 10000 });
  }
  if (path === "yt/rules" && m === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT r.*, a.title AS channel, (SELECT COUNT(*) FROM yt_replies x WHERE x.rule_id = r.id AND x.status = 'replied') AS replied,
              (SELECT COUNT(*) FROM yt_replies x WHERE x.rule_id = r.id AND x.status != 'replied') AS failed
       FROM yt_rules r JOIN yt_accounts a ON a.channel_id = r.channel_id ORDER BY r.created DESC`).all();
    return json(results);
  }
  if (path === "yt/rules" && m === "POST") {
    const a = await ytAccount(env, body.channel);
    const kws = (body.keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean);
    if (!kws.length) return json({ error: "keywords required" }, 400);
    if (body.mode !== "description" && !/^https:\/\//.test(body.link_url || "")) return json({ error: "link_url must be https (or use mode=description)" }, 400);
    let vid = "*", title = null;
    if (body.video && !["any", "*"].includes(String(body.video).toLowerCase())) {
      vid = videoIdFrom(body.video);
      if (!vid) return json({ error: "couldn't read a video id from --video" }, 400);
    }
    await env.DB.prepare("INSERT INTO yt_rules (channel_id, name, video_ids, title, keywords, link_url, replies, mode, active, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
      .bind(a.channel_id, body.name, JSON.stringify([vid]), title, JSON.stringify(kws), body.link_url || null, body.replies?.length ? JSON.stringify(body.replies) : null, body.mode === "description" ? "description" : "link", now()).run();
    await logEvent(env, null, "info", `YouTube automation ${body.name} created on ${vid === "*" ? "every video" : vid} for ${kws.join(", ")}`);
    return json({ ok: true, video: vid });
  }
  if (path.startsWith("yt/rules/") && (m === "DELETE" || m === "PATCH")) {
    const name = decodeURIComponent(path.split("/")[2]);
    const res = m === "DELETE" ? await env.DB.prepare("DELETE FROM yt_rules WHERE name = ?").bind(name).run()
      : await env.DB.prepare("UPDATE yt_rules SET active = ? WHERE name = ?").bind(body.active ? 1 : 0, name).run();
    return res.meta.changes ? json({ ok: true }) : json({ error: "not found" }, 404);
  }
  if (path === "yt/replies" && m === "GET") {
    return json((await env.DB.prepare("SELECT x.*, r.name AS rule FROM yt_replies x LEFT JOIN yt_rules r ON r.id = x.rule_id ORDER BY x.created DESC LIMIT ?").bind(Number(url.searchParams.get("limit") || 30)).all()).results);
  }
  if (path === "yt/videos" && m === "GET") {
    return json((await env.DB.prepare("SELECT v.*, a.title AS channel FROM yt_videos v JOIN yt_accounts a ON a.channel_id = v.channel_id ORDER BY v.publish_at DESC LIMIT 50").all()).results);
  }
  if (path === "yt/videos" && m === "POST") {
    const a = await ytAccount(env, body.channel);
    if (!body.title || !body.media_key || !body.publish_at) return json({ error: "title, media_key and publish_at are required" }, 400);
    if (!(await env.MEDIA.head(body.media_key))) return json({ error: "uploaded video not found in storage" }, 400);
    const id = crypto.randomUUID().slice(0, 6);
    await env.DB.prepare("INSERT INTO yt_videos (id, channel_id, title, description, tags, media_key, thumb_key, publish_at, status, autoreply, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .bind(id, a.channel_id, body.title, body.description || "", JSON.stringify(body.tags || []), body.media_key, body.thumb_key || null, Number(body.publish_at),
        body.autoreply ? JSON.stringify(body.autoreply) : null, now()).run();
    await logEvent(env, null, "info", `YouTube "${body.title}" queued, goes public ${new Date(body.publish_at * 1000).toISOString()}`);
    return json({ id });
  }
  if (path.startsWith("yt/videos/") && m === "DELETE") {
    const id = path.split("/")[2];
    const v = await env.DB.prepare("SELECT * FROM yt_videos WHERE id = ? AND status IN ('pending','failed')").bind(id).first();
    if (!v) return json({ error: "not found, or already uploaded to YouTube (delete it in YouTube Studio)" }, 404);
    for (const k of [v.media_key, v.thumb_key].filter(Boolean)) { try { await env.MEDIA.delete(k); } catch {} }
    await env.DB.prepare("DELETE FROM yt_videos WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  if (path === "yt/describe" && m === "POST") {
    const a = await ytAccount(env, body.channel);
    const vid = videoIdFrom(body.video);
    if (!vid) return json({ error: "couldn't read a video id" }, 400);
    if (!/^🔗 .+ https:\/\//.test(body.line || "")) return json({ error: "bad link line" }, 400);
    return json({ video: vid, ...(await setDescriptionLink(env, a, vid, body.line)) });
  }
  if (path === "yt/stats" && m === "GET") {
    return json((await env.DB.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM yt_replies x WHERE x.video_id = s.video_id AND x.status = 'replied') AS replies
       FROM yt_stats s ORDER BY s.published DESC LIMIT ?`).bind(Number(url.searchParams.get("limit") || 20)).all()).results);
  }
  if (path === "yt/stats/refresh" && m === "POST") return json({ refreshed: await refreshYtStats(env) });
  if (path === "yt/poll-now" && m === "POST") {
    await env.DB.prepare("DELETE FROM kv WHERE k LIKE 'ytpoll:%'").run();
    await pollComments(env);
    return json({ ok: true });
  }

  if (path === "webhook-events" && m === "GET") {
    const counts = (await env.DB.prepare("SELECT status, COUNT(*) AS n FROM webhook_events GROUP BY status").all()).results;
    const problems = (await env.DB.prepare("SELECT id, received, status, attempts, next_try, error FROM webhook_events WHERE status IN ('failed','dead','processing') ORDER BY id DESC LIMIT 20").all()).results;
    return json({ counts, problems });
  }
  if (path.startsWith("webhook-events/") && path.endsWith("/retry") && m === "POST") {
    const r = await env.DB.prepare("UPDATE webhook_events SET status = 'failed', attempts = 0, next_try = 0 WHERE id = ?").bind(Number(path.split("/")[1])).run();
    return json({ ok: !!r.meta.changes, note: "retries within a minute" });
  }
  if (path === "alerts/test" && m === "POST") {
    if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) return json({ error: "RESEND_API_KEY / ALERT_EMAIL secrets not set" }, 400);
    const ok = await sendEmail(env, "✅ Instagram automation alerts are working", `<p style="font:15px system-ui">Alerts for failed DMs, disconnected accounts and "Need help" replies will arrive here, plus a daily summary at 08:30.</p>`);
    return json({ ok });
  }
  if (path === "alerts/summary" && m === "POST") return json({ ok: await dailySummary(env) });
  if (path === "quota" && m === "GET") {
    const a = await needAccount(env, url.searchParams.get("account"));
    const d = await ig(a.token, "GET", `${a.ig_user_id}/content_publishing_limit`, { fields: "config,quota_usage" });
    return json({ username: a.username, ...d.data[0] });
  }
  return json({ error: "unknown endpoint" }, 404);
}
