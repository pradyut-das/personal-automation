// LinkedIn personal profile: connect (OpenID + w_member_social), scheduled posts (text, image(s), video, PDF document).
// LinkedIn's API has no scheduling, so the every-minute cron publishes at publish_at.
// Upload state machine: pending -> uploading (assets) -> processing (video/document readiness) -> published.
import { now, logEvent, hmacHex, safeEqual } from "./ig.js";
import { alert } from "./alerts.js";

const REST = "https://api.linkedin.com/rest";
const SCOPES = "openid profile email w_member_social";
const redirect = (env) => `${(env.PUBLIC_URL || "").replace(/\/$/, "")}/li/oauth/callback`;
const hdrs = (env, tok, json = true) => ({
  Authorization: `Bearer ${tok}`, "LinkedIn-Version": env.LI_VERSION || "202610", "X-Restli-Protocol-Version": "2.0.0",
  ...(json ? { "Content-Type": "application/json" } : {}),
});

// LinkedIn "little text": reserved characters must be escaped or the post breaks/truncates. #words become real hashtags.
export function littleText(s) {
  const esc = String(s || "").replace(/[\\|{}@[\]()<>*_~]/g, (c) => `\\${c}`);
  return esc.replace(/(^|[^\w\\])#([\p{L}\p{N}_]+)/gu, (m, pre, tag) => `${pre}{hashtag|\\#|${tag}}`).replace(/(^|[^{|\\])#/g, "$1\\#");
}

// ---------- connect ----------
export async function liConnectUrl(env) {
  if (!env.LI_CLIENT_ID) throw Object.assign(new Error("LI_CLIENT_ID secret is not set"), { status: 400 });
  const ts = String(now());
  const state = `${ts}.${(await hmacHex(env.ADMIN_KEY, `li:${ts}`)).slice(0, 32)}`;
  return `https://www.linkedin.com/oauth/v2/authorization?${new URLSearchParams({ response_type: "code", client_id: env.LI_CLIENT_ID, redirect_uri: redirect(env), state, scope: SCOPES })}`;
}

export async function liOauthCallback(env, url) {
  const page = (t, m) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${t}</title>
<body style="font:16px system-ui;max-width:520px;margin:15vh auto;padding:0 16px;color:#002B36;background:#F3FCFE"><h2>${t}</h2><p>${m}</p></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } });
  const [ts, sig] = (url.searchParams.get("state") || "").split(".");
  const expect = ts ? (await hmacHex(env.ADMIN_KEY, `li:${ts}`)).slice(0, 32) : "";
  if (!sig || !safeEqual(sig, expect) || now() - Number(ts) > 3600) return page("Link expired", "Run ./pa.py li-connect for a new link.");
  if (url.searchParams.get("error")) return page("Not connected", (url.searchParams.get("error_description") || "LinkedIn sign-in was cancelled.").replace(/</g, "&lt;"));

  const r = await fetch("https://www.linkedin.com/oauth/v2/accessToken", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: redirect(env),
      client_id: env.LI_CLIENT_ID, client_secret: env.LI_CLIENT_SECRET }) });
  const t = await r.json();
  if (!t.access_token) return page("Not connected", `LinkedIn said: ${String(t.error_description || t.error || "unknown error").replace(/</g, "&lt;")}`);
  const me = await (await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
  if (!me.sub) return page("Not connected", "Couldn't read your LinkedIn profile.");
  const urn = `urn:li:person:${me.sub}`;
  await env.DB.prepare(
    `INSERT INTO li_accounts (person_urn, name, email, access_token, expires, status, created) VALUES (?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT (person_urn) DO UPDATE SET name = excluded.name, email = excluded.email, access_token = excluded.access_token,
       expires = excluded.expires, status = 'active', error = NULL`
  ).bind(urn, me.name || null, me.email || null, t.access_token, now() + (t.expires_in || 5184000), now()).run();
  await logEvent(env, null, "info", `LinkedIn ${me.name || urn} connected (sign-in valid 60 days)`);
  return page("LinkedIn connected ✅", `${(me.name || "Your profile").replace(/</g, "&lt;")} is connected. You can close this tab.`);
}

// daily: tokens can't be refreshed on self-serve apps, so warn before they lapse
export async function checkLiTokens(env) {
  const { results } = await env.DB.prepare("SELECT * FROM li_accounts").all();
  for (const a of results) {
    const days = Math.floor((a.expires - now()) / 86400);
    if (days < 0 && a.status !== "expired") {
      await env.DB.prepare("UPDATE li_accounts SET status = 'expired' WHERE person_urn = ?").bind(a.person_urn).run();
      await alert(env, "urgent", `LinkedIn ${a.name} is disconnected`, "The 60-day sign-in expired. Reconnect with ./pa.py li-connect; scheduled posts wait until then.", `li-exp-${a.person_urn}`);
    } else if (days >= 0 && days <= 7) {
      await alert(env, "error", `LinkedIn sign-in for ${a.name} expires in ${days} days`, "Run ./pa.py li-connect to renew it (LinkedIn doesn't allow automatic renewal).", `li-soon-${a.person_urn}-${days}`);
    }
  }
}

// ---------- upload helpers ----------
async function li(env, tok, method, path, body) {
  const r = await fetch(path.startsWith("http") ? path : `${REST}/${path}`, { method, headers: hdrs(env, tok), body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let d = {};
  try { d = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) throw new Error(`${method} ${path.split("?")[0]}: ${d.message || text.slice(0, 200) || r.status}`);
  return { d, headers: r.headers };
}

async function putBytes(url, tok, body, contentType) {
  const r = await fetch(url, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, "Content-Type": contentType || "application/octet-stream" }, body });
  if (!r.ok) throw new Error(`upload failed: ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.headers.get("etag");
}

async function uploadImage(env, a, m) {
  const { d } = await li(env, a.access_token, "POST", "images?action=initializeUpload", { initializeUploadRequest: { owner: a.person_urn } });
  const obj = await env.MEDIA.get(m.key);
  await putBytes(d.value.uploadUrl, a.access_token, await obj.arrayBuffer(), m.type);
  return d.value.image;
}

async function uploadDocument(env, a, m) {
  const { d } = await li(env, a.access_token, "POST", "documents?action=initializeUpload", { initializeUploadRequest: { owner: a.person_urn } });
  const obj = await env.MEDIA.get(m.key);
  await putBytes(d.value.uploadUrl, a.access_token, await obj.arrayBuffer(), "application/pdf");
  return d.value.document;
}

async function uploadVideo(env, a, m) {
  const { d } = await li(env, a.access_token, "POST", "videos?action=initializeUpload",
    { initializeUploadRequest: { owner: a.person_urn, fileSizeBytes: m.size, uploadCaptions: false, uploadThumbnail: false } });
  const v = d.value, etags = [];
  for (const part of v.uploadInstructions) {                // LinkedIn splits videos into ~4 MB parts
    const len = part.lastByte - part.firstByte + 1;
    const obj = await env.MEDIA.get(m.key, { range: { offset: part.firstByte, length: len } });
    etags.push(await putBytes(part.uploadUrl, a.access_token, await obj.arrayBuffer(), "application/octet-stream"));
  }
  await li(env, a.access_token, "POST", "videos?action=finalizeUpload",
    { finalizeUploadRequest: { video: v.video, uploadToken: v.uploadToken || "", uploadedPartIds: etags } });
  return v.video;
}

async function assetReady(env, a, urn) {
  const kind = urn.includes(":video:") ? "videos" : urn.includes(":document:") ? "documents" : "images";
  const { d } = await li(env, a.access_token, "GET", `${kind}/${encodeURIComponent(urn)}`);
  if (d.status === "PROCESSING_FAILED") throw new Error(`LinkedIn couldn't process the ${kind.slice(0, -1)}`);
  return d.status === "AVAILABLE";
}

// ---------- cron ----------
export async function runLinkedIn(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, a.access_token, a.name, a.status AS acct_status FROM li_posts p JOIN li_accounts a ON a.person_urn = p.person_urn
     WHERE a.status = 'active' AND ((p.status = 'pending' AND p.publish_at <= ? + 900) OR p.status IN ('processing')) ORDER BY p.publish_at LIMIT 5`
  ).bind(now()).all();   // media starts uploading up to 15 min early so videos are processed by publish time
  for (const p of results) {
    const a = { person_urn: p.person_urn, access_token: p.access_token, name: p.name };
    const media = p.media ? JSON.parse(p.media) : [];
    try {
      if (p.status === "pending") {
        const claimed = await env.DB.prepare("UPDATE li_posts SET status = 'uploading', attempts = attempts + 1, started = ? WHERE id = ? AND status = 'pending'").bind(now(), p.id).run();
        if (!claimed.meta.changes) continue;
        const assets = [];
        for (const m of media) {
          if (p.kind === "video") assets.push(await uploadVideo(env, a, m));
          else if (p.kind === "document") assets.push(await uploadDocument(env, a, m));
          else assets.push(await uploadImage(env, a, m));
        }
        await env.DB.prepare("UPDATE li_posts SET status = 'processing', assets = ? WHERE id = ?").bind(JSON.stringify(assets), p.id).run();
        continue; // publish on a later tick (time + processing)
      }
      // processing: wait for assets + publish time
      if (p.publish_at > now()) continue;
      const assets = p.assets ? JSON.parse(p.assets) : [];
      for (const u of assets) if (!(await assetReady(env, a, u))) {
        if (now() - p.started > 45 * 60) throw new Error("media still processing on LinkedIn after 45 min");
        assets.pending = true;
      }
      if (assets.pending) continue;

      const post = {
        author: a.person_urn, commentary: littleText(p.text), visibility: "PUBLIC", lifecycleState: "PUBLISHED", isReshareDisabledByAuthor: false,
        distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      };
      if (p.kind === "image" || p.kind === "video" || p.kind === "document") post.content = { media: { id: assets[0], ...(media[0]?.title ? { title: media[0].title } : {}) } };
      if (p.kind === "images") post.content = { multiImage: { images: assets.map((id) => ({ id })) } };
      const { headers } = await li(env, a.access_token, "POST", "posts", post);
      const urn = headers.get("x-restli-id") || headers.get("x-linkedin-id");
      const link = urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
      await env.DB.prepare("UPDATE li_posts SET status = 'published', post_urn = ?, permalink = ?, error = NULL WHERE id = ?").bind(urn, link, p.id).run();
      for (const m of media) { try { await env.MEDIA.delete(m.key); } catch {} }
      await logEvent(env, null, "info", `LinkedIn post ${p.id} published${link ? ` → ${link}` : ""}`);
    } catch (e) {
      const final = (p.attempts + (p.status === "pending" ? 1 : 0)) >= 3 || /401|403|Unauthorized|ACCESS_DENIED/i.test(e.message);
      await env.DB.prepare("UPDATE li_posts SET status = ?, error = ?, assets = CASE WHEN ? THEN assets ELSE NULL END WHERE id = ?")
        .bind(final ? "failed" : "pending", e.message.slice(0, 400), p.status === "processing" ? 1 : 0, p.id).run();
      await logEvent(env, null, final ? "error" : "warn", `LinkedIn post ${p.id} ${final ? "failed" : "will retry"}: ${e.message.slice(0, 200)}`);
      if (/401|Unauthorized|expired/i.test(e.message)) {
        await env.DB.prepare("UPDATE li_accounts SET status = 'expired', error = ? WHERE person_urn = ?").bind(e.message.slice(0, 200), p.person_urn).run();
        await alert(env, "urgent", `LinkedIn ${a.name} needs reconnecting`, "LinkedIn rejected the saved sign-in. Run ./pa.py li-connect.", `li-401-${p.person_urn}`);
      }
    }
  }
}

export async function liAccount(env, ref) {
  const all = (await env.DB.prepare("SELECT * FROM li_accounts").all()).results;
  const a = ref ? all.find((x) => x.person_urn === ref || x.name === ref || x.email === ref) : all.length === 1 ? all[0] : null;
  if (!a) throw Object.assign(new Error(all.length ? "several LinkedIn accounts; pass --account" : "no LinkedIn account connected yet (./pa.py li-connect)"), { status: 400 });
  return a;
}
