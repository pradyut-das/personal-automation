// YouTube: connect a channel (Google OAuth), keyword comment auto-replies (polled), scheduled uploads
// (YouTube's own publishAt), and per-video stats. Daily quota (10,000 units, resets midnight Pacific) is tracked.
import { now, logEvent, hmacHex, safeEqual } from "./ig.js";
import { alert } from "./alerts.js";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
].join(" ");
const API = "https://www.googleapis.com/youtube/v3";
const QUOTA_LIMIT = 10000;
const QUOTA_RESERVE = 1700; // always keep enough for one upload
const POLL_EVERY = 180;     // seconds between comment checks per channel

export const YT_REPLIES = [
  "Here you go {name} 👉 {link}",
  "Sent it your way {name}! Grab it here: {link}",
  "Thanks for the comment {name} 🙌 Here it is: {link}",
  "{name} here's the link 👇 {link}",
  "Got you {name} ✨ {link}",
  "Here's the full workflow {name}: {link}",
  "Enjoy it {name} 🚀 {link}",
  "Thanks {name}! Here you go: {link}",
];
export const YT_DESC_REPLIES = [
  "Thanks {name}! The link is in the description 🙌",
  "Got you {name} 👆 Check the description for the link",
  "{name} it's linked in the description ✨",
];

// ---------- quota ----------
function ptDay() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
}
export async function quotaUsed(env) {
  return Number((await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(`ytq:${ptDay()}`).first())?.v || 0);
}
async function spend(env, units) {
  await env.DB.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = CAST(v AS INTEGER) + ?")
    .bind(`ytq:${ptDay()}`, String(units), units).run();
}
const canSpend = async (env, units, reserve = 0) => (await quotaUsed(env)) + units + reserve <= QUOTA_LIMIT;

// ---------- auth ----------
const redirect = (env) => `${(env.PUBLIC_URL || "").replace(/\/$/, "")}/yt/oauth/callback`;

export async function ytConnectUrl(env) {
  if (!env.YT_CLIENT_ID) throw Object.assign(new Error("YT_CLIENT_ID secret is not set"), { status: 400 });
  const ts = String(now());
  const state = `${ts}.${(await hmacHex(env.ADMIN_KEY, `yt:${ts}`)).slice(0, 32)}`;
  const q = new URLSearchParams({ client_id: env.YT_CLIENT_ID, redirect_uri: redirect(env), response_type: "code", scope: SCOPES,
    access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function ytOauthCallback(env, url) {
  const page = (t, m) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title>
<body style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:0 16px;color:#002B36;background:#F3FCFE"><h2>${t}</h2><p>${m}</p></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
  const [ts, sig] = (url.searchParams.get("state") || "").split(".");
  const expect = ts ? (await hmacHex(env.ADMIN_KEY, `yt:${ts}`)).slice(0, 32) : "";
  if (!sig || !safeEqual(sig, expect) || now() - Number(ts) > 3600) return page("Link expired", "Run ./pa.py yt-connect for a new link.");
  if (url.searchParams.get("error")) return page("Not connected", "Google sign-in was cancelled.");

  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
    code: url.searchParams.get("code") || "", client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET,
    redirect_uri: redirect(env), grant_type: "authorization_code" }) });
  const t = await r.json();
  if (!t.refresh_token) return page("Not connected", `Google didn't return a refresh token (${(t.error_description || t.error || "unknown").replace(/</g, "&lt;")}). Try again.`);

  const ch = await (await fetch(`${API}/channels?part=snippet,contentDetails&mine=true`, { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
  const c = ch.items?.[0];
  if (!c) return page("Not connected", "That Google account has no YouTube channel.");
  await env.DB.prepare(
    `INSERT INTO yt_accounts (channel_id, title, handle, uploads_playlist, refresh_token, access_token, access_expires, status, created)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT (channel_id) DO UPDATE SET title = excluded.title, handle = excluded.handle, uploads_playlist = excluded.uploads_playlist,
       refresh_token = excluded.refresh_token, access_token = excluded.access_token, access_expires = excluded.access_expires, status = 'active', error = NULL`
  ).bind(c.id, c.snippet.title, c.snippet.customUrl || null, c.contentDetails?.relatedPlaylists?.uploads || null, t.refresh_token,
    t.access_token, now() + (t.expires_in || 3600) - 60, now()).run();
  await spend(env, 1);
  await logEvent(env, null, "info", `YouTube channel ${c.snippet.title} connected`);
  return page("YouTube connected ✅", `${c.snippet.title} is connected. You can close this tab.`);
}

async function token(env, a) {
  if (a.access_token && a.access_expires > now() + 30) return a.access_token;
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body: new URLSearchParams({
    client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, refresh_token: a.refresh_token, grant_type: "refresh_token" }) });
  const t = await r.json();
  if (!t.access_token) {
    await env.DB.prepare("UPDATE yt_accounts SET status = 'token_error', error = ? WHERE channel_id = ?").bind(t.error_description || t.error || "refresh failed", a.channel_id).run();
    await alert(env, "urgent", `YouTube ${a.title} is disconnected`, "Google refused the saved sign-in. Reconnect with ./pa.py yt-connect", `yt-token-${a.channel_id}`);
    throw new Error(`YouTube token refresh failed: ${t.error || "unknown"}`);
  }
  a.access_token = t.access_token;
  await env.DB.prepare("UPDATE yt_accounts SET access_token = ?, access_expires = ? WHERE channel_id = ?").bind(t.access_token, now() + (t.expires_in || 3600) - 60, a.channel_id).run();
  return t.access_token;
}

async function yt(env, a, method, path, { body, units = 1, raw } = {}) {
  const tk = await token(env, a);
  const r = await fetch(path.startsWith("http") ? path : `${API}/${path}`, {
    method, headers: { Authorization: `Bearer ${tk}`, ...(body && !raw ? { "Content-Type": "application/json" } : {}) },
    body: raw || (body ? JSON.stringify(body) : undefined),
  });
  await spend(env, units);
  const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const e = new Error(`${method} ${path.split("?")[0]}: ${d.error?.message || r.status}`);
    e.reason = d.error?.errors?.[0]?.reason;
    throw e;
  }
  return d;
}

// ---------- keyword comment replies ----------
const norm = (t) => ` ${(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
const hasKeyword = (text, kws) => kws.includes("*") || kws.some((k) => norm(k).trim() && norm(text).includes(norm(k)));
const pick = (l) => l[Math.floor(Math.random() * l.length)];

export async function pollComments(env) {
  const { results: accts } = await env.DB.prepare("SELECT * FROM yt_accounts WHERE status = 'active'").all();
  for (const a of accts) {
    const last = Number((await env.DB.prepare("SELECT v FROM kv WHERE k = ?").bind(`ytpoll:${a.channel_id}`).first())?.v || 0);
    if (now() - last < POLL_EVERY) continue;
    await env.DB.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").bind(`ytpoll:${a.channel_id}`, String(now())).run();

    const { results: ruleRows } = await env.DB.prepare("SELECT * FROM yt_rules WHERE channel_id = ? AND active = 1 ORDER BY id").bind(a.channel_id).all();
    if (!ruleRows.length) { // nothing to do; just keep the cursor fresh so old comments never get replies
      await env.DB.prepare("UPDATE yt_accounts SET last_poll = ? WHERE channel_id = ?").bind(now(), a.channel_id).run();
      continue;
    }
    const rules = ruleRows.map((r) => ({ ...r, video_ids: JSON.parse(r.video_ids), keywords: JSON.parse(r.keywords), replies: r.replies ? JSON.parse(r.replies) : null }));
    const ordered = [...rules.filter((r) => !r.video_ids.includes("*")), ...rules.filter((r) => r.video_ids.includes("*"))];
    if (!(await canSpend(env, 1))) continue;

    let d;
    try {
      d = await yt(env, a, "GET", `commentThreads?part=snippet&allThreadsRelatedToChannelId=${a.channel_id}&order=time&maxResults=50&textFormat=plainText`);
    } catch (e) {
      await logEvent(env, null, "error", `YouTube comment check failed for ${a.title}: ${e.message.slice(0, 160)}`);
      continue;
    }
    const since = a.last_poll || now(); // first run: only comments from now on
    let newest = since;
    for (const th of (d.items || []).reverse()) {
      const s = th.snippet?.topLevelComment?.snippet;
      if (!s) continue;
      const t = Math.floor(Date.parse(s.publishedAt) / 1000);
      newest = Math.max(newest, t);
      if (t <= since - 600) continue; // older than our window (with 10 min overlap; dedupe handles repeats)
      if (s.authorChannelId?.value === a.channel_id) continue;
      const vid = th.snippet.videoId || s.videoId;
      const rule = ordered.find((r) => (r.video_ids.includes("*") || r.video_ids.includes(vid)) && hasKeyword(s.textOriginal, r.keywords));
      if (!rule) continue;
      const exists = await env.DB.prepare("SELECT 1 FROM yt_replies WHERE comment_id = ?").bind(th.id).first();
      if (exists) continue;

      const name = s.authorDisplayName?.startsWith("@") ? s.authorDisplayName : `@${(s.authorDisplayName || "").replace(/\s+/g, "")}`;
      const list = rule.replies?.length ? rule.replies : rule.mode === "description" ? YT_DESC_REPLIES : YT_REPLIES;
      const text = pick(list).replaceAll("{name}", name).replaceAll("{link}", rule.link_url || "");
      const row = [th.id, a.channel_id, rule.id, vid, s.authorDisplayName || "", (s.textOriginal || "").slice(0, 500)];

      if (!(await canSpend(env, 50, QUOTA_RESERVE))) {
        await env.DB.prepare("INSERT OR IGNORE INTO yt_replies (comment_id, channel_id, rule_id, video_id, author, text, status, created) VALUES (?, ?, ?, ?, ?, ?, 'skipped_quota', ?)").bind(...row, now()).run();
        await alert(env, "error", "YouTube daily quota nearly used up, comment replies paused until midnight Pacific", "", "yt-quota");
        continue;
      }
      try {
        const r = await yt(env, a, "POST", "comments?part=snippet", { body: { snippet: { parentId: th.id, textOriginal: text } }, units: 50 });
        await env.DB.prepare("INSERT OR IGNORE INTO yt_replies (comment_id, channel_id, rule_id, video_id, author, text, reply_id, status, created) VALUES (?, ?, ?, ?, ?, ?, ?, 'replied', ?)").bind(...row, r.id, now()).run();
        await logEvent(env, null, "info", `YouTube ${rule.name}: replied to ${name} "${(s.textOriginal || "").slice(0, 50)}"`);
      } catch (e) {
        await env.DB.prepare("INSERT OR IGNORE INTO yt_replies (comment_id, channel_id, rule_id, video_id, author, text, status, error, created) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?)").bind(...row, e.message.slice(0, 300), now()).run();
        await logEvent(env, null, "error", `YouTube ${rule.name}: reply to ${name} failed: ${e.message.slice(0, 160)}`);
      }
    }
    await env.DB.prepare("UPDATE yt_accounts SET last_poll = ? WHERE channel_id = ?").bind(newest, a.channel_id).run();
  }
}

// ---------- scheduled uploads (YouTube publishes them itself at publishAt) ----------
export async function runYtUploads(env) {
  const { results } = await env.DB.prepare(
    `SELECT v.*, a.title AS ch_title, a.refresh_token, a.access_token, a.access_expires, a.status AS ch_status
     FROM yt_videos v JOIN yt_accounts a ON a.channel_id = v.channel_id
     WHERE a.status = 'active' AND (v.status = 'pending' OR (v.status = 'scheduled' AND v.publish_at <= ?)) ORDER BY v.publish_at LIMIT 3`
  ).bind(now()).all();
  for (const v of results) {
    const a = { channel_id: v.channel_id, title: v.ch_title, refresh_token: v.refresh_token, access_token: v.access_token, access_expires: v.access_expires };
    if (v.status === "scheduled") { await checkPublished(env, a, v); continue; }
    if (!(await canSpend(env, 1700))) continue; // not enough quota left today; try after the reset
    await env.DB.prepare("UPDATE yt_videos SET status = 'uploading', attempts = attempts + 1 WHERE id = ? AND status = 'pending'").bind(v.id).run();
    try {
      const obj = await env.MEDIA.head(v.media_key);
      if (!obj) throw new Error("uploaded video file is missing");
      const future = v.publish_at > now() + 120;
      const meta = {
        snippet: { title: v.title.slice(0, 100), description: v.description || "", tags: v.tags ? JSON.parse(v.tags) : [], categoryId: "22" },
        status: { privacyStatus: future ? "private" : "public", ...(future ? { publishAt: new Date(v.publish_at * 1000).toISOString() } : {}), selfDeclaredMadeForKids: false },
      };
      const tk = await token(env, a);
      const init = await fetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        method: "POST", headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": String(obj.size), "X-Upload-Content-Type": obj.httpMetadata?.contentType || "video/mp4" },
        body: JSON.stringify(meta) });
      const loc = init.headers.get("location");
      if (!init.ok || !loc) throw new Error(`upload init failed: ${(await init.text()).slice(0, 200)}`);
      // stream straight from R2 to Google with a fixed length (no buffering in memory, no chunked encoding)
      const fls = new FixedLengthStream(obj.size);
      const src = (await env.MEDIA.get(v.media_key)).body;
      const piping = src.pipeTo(fls.writable);
      const up = await fetch(loc, { method: "PUT", headers: { "Content-Type": obj.httpMetadata?.contentType || "video/mp4" }, body: fls.readable });
      await piping.catch(() => {});
      await spend(env, 1600);
      const res = await up.json().catch(() => ({}));
      if (!up.ok || !res.id) throw new Error(`upload failed: ${res.error?.message || up.status}`);

      let thumbNote = "";
      if (v.thumb_key) {
        try {
          const img = await env.MEDIA.get(v.thumb_key);
          await yt(env, a, "POST", `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${res.id}&uploadType=media`,
            { raw: await img.arrayBuffer(), units: 50 });
        } catch (e) {
          thumbNote = ` (thumbnail not set: ${e.message.slice(0, 100)})`;
          await logEvent(env, null, "warn", `YouTube thumbnail for "${v.title}" not set: ${e.message.slice(0, 160)}`);
        }
      }
      await env.DB.prepare("UPDATE yt_videos SET status = ?, video_id = ?, privacy = ?, error = NULL WHERE id = ?")
        .bind(future ? "scheduled" : "published", res.id, res.status?.privacyStatus || null, v.id).run();
      for (const k of [v.media_key, v.thumb_key].filter(Boolean)) { try { await env.MEDIA.delete(k); } catch {} }
      if (v.autoreply) {
        const r = JSON.parse(v.autoreply);
        await env.DB.prepare("INSERT OR IGNORE INTO yt_rules (channel_id, name, video_ids, title, keywords, link_url, replies, mode, active, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
          .bind(v.channel_id, r.name, JSON.stringify([res.id]), v.title, JSON.stringify(r.keywords), r.link_url || null, r.replies ? JSON.stringify(r.replies) : null, r.mode || "link", now()).run();
      }
      await logEvent(env, null, "info", `YouTube "${v.title}" uploaded → https://youtu.be/${res.id} (${future ? `goes public ${new Date(v.publish_at * 1000).toISOString()}` : "public now"})${thumbNote}`);
    } catch (e) {
      const final = v.attempts + 1 >= 3;
      await env.DB.prepare("UPDATE yt_videos SET status = ?, error = ? WHERE id = ?").bind(final ? "failed" : "pending", e.message.slice(0, 400), v.id).run();
      await logEvent(env, null, final ? "error" : "warn", `YouTube upload "${v.title}" attempt ${v.attempts + 1} failed: ${e.message.slice(0, 200)}`);
    }
  }
}

async function checkPublished(env, a, v) {
  try {
    const d = await yt(env, a, "GET", `videos?part=status&id=${v.video_id}`);
    const st = d.items?.[0]?.status;
    if (!st) throw new Error("video not found on YouTube");
    if (st.privacyStatus === "public") {
      await env.DB.prepare("UPDATE yt_videos SET status = 'published', privacy = 'public', error = NULL WHERE id = ?").bind(v.id).run();
      await logEvent(env, null, "info", `YouTube "${v.title}" is public → https://youtu.be/${v.video_id}`);
    } else if (now() - v.publish_at > 1800) {
      const msg = "Still private 30 min after its publish time. Uploads from an unaudited API project stay private until Google approves the project; publish it manually in YouTube Studio for now.";
      await env.DB.prepare("UPDATE yt_videos SET status = 'failed', privacy = ?, error = ? WHERE id = ?").bind(st.privacyStatus, msg, v.id).run();
      await alert(env, "error", `YouTube "${v.title}" didn't go public`, msg, `yt-private-${v.id}`);
    }
  } catch (e) {
    await logEvent(env, null, "warn", `YouTube publish check for "${v.title}" failed: ${e.message.slice(0, 160)}`);
  }
}

// ---------- stats ----------
const iso8601secs = (d) => { const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(d || ""); return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0; };

export async function refreshYtStats(env) {
  const { results: accts } = await env.DB.prepare("SELECT * FROM yt_accounts WHERE status = 'active'").all();
  let n = 0;
  for (const a of accts) {
    if (!a.uploads_playlist || !(await canSpend(env, 5, QUOTA_RESERVE))) continue;
    try {
      const pl = await yt(env, a, "GET", `playlistItems?part=contentDetails&playlistId=${a.uploads_playlist}&maxResults=25`);
      const ids = (pl.items || []).map((i) => i.contentDetails.videoId);
      if (!ids.length) continue;
      const vids = await yt(env, a, "GET", `videos?part=snippet,statistics,contentDetails&id=${ids.join(",")}`);
      let minutes = {};
      try {
        const end = new Date().toISOString().slice(0, 10), start = new Date(Date.now() - 365 * 86400e3).toISOString().slice(0, 10);
        const rep = await yt(env, a, "GET", `https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate=${start}&endDate=${end}&metrics=estimatedMinutesWatched&dimensions=video&filters=video==${ids.join(",")}`);
        minutes = Object.fromEntries((rep.rows || []).map(([id, m]) => [id, m]));
      } catch {}
      for (const v of vids.items || []) {
        await env.DB.prepare(
          `INSERT INTO yt_stats (video_id, channel_id, title, published, is_short, views, likes, comments, minutes, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (video_id) DO UPDATE SET title = excluded.title, views = excluded.views, likes = excluded.likes, comments = excluded.comments, minutes = excluded.minutes, updated = excluded.updated`
        ).bind(v.id, a.channel_id, v.snippet.title, Math.floor(Date.parse(v.snippet.publishedAt) / 1000), iso8601secs(v.contentDetails.duration) <= 180 ? 1 : 0,
          +v.statistics.viewCount || 0, +v.statistics.likeCount || 0, +v.statistics.commentCount || 0, Math.round(minutes[v.id] || 0) || null, now()).run();
        n++;
      }
    } catch (e) {
      await logEvent(env, null, "warn", `YouTube stats refresh for ${a.title} failed: ${e.message.slice(0, 160)}`);
    }
  }
  return n;
}

// put a link line at the top of an existing video's description (replaces an earlier "🔗 " first line)
export async function setDescriptionLink(env, a, videoId, line) {
  const d = await yt(env, a, "GET", `videos?part=snippet&id=${videoId}`);
  const v = d.items?.[0];
  if (!v) throw Object.assign(new Error("video not found on your channel"), { status: 404 });
  const s = v.snippet;
  const url = line.split(" ").pop();
  if ((s.description || "").includes(url)) return { changed: false };
  const rest = (s.description || "").replace(/^🔗 [^\n]*\n*/, "");
  const description = `${line}\n\n${rest}`.trim().slice(0, 5000);
  await yt(env, a, "PUT", "videos?part=snippet", { units: 50, body: { id: videoId, snippet: {
    title: s.title, categoryId: s.categoryId, description, tags: s.tags || [], ...(s.defaultLanguage ? { defaultLanguage: s.defaultLanguage } : {}) } } });
  await logEvent(env, null, "info", `YouTube "${s.title}": link added to description`);
  return { changed: true };
}

// video id from a URL / id
export function videoIdFrom(ref) {
  const s = String(ref || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = /(?:v=|youtu\.be\/|shorts\/|live\/|embed\/)([\w-]{11})/.exec(s);
  return m ? m[1] : null;
}

export async function ytAccount(env, ref) {
  const all = (await env.DB.prepare("SELECT * FROM yt_accounts").all()).results;
  const a = ref ? all.find((x) => x.channel_id === ref || x.handle === ref || x.handle === `@${ref}` || x.title === ref) : all.length === 1 ? all[0] : null;
  if (!a) throw Object.assign(new Error(ref ? `YouTube channel ${ref} not found` : all.length ? "several channels connected; pass --channel" : "no YouTube channel connected yet (./pa.py yt-connect)"), { status: 400 });
  return a;
}
