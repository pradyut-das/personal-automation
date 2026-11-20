// Instagram Graph API helpers + shared utilities.
import { alert } from "./alerts.js";
export const API = "https://graph.instagram.com/v23.0";
export const now = () => Math.floor(Date.now() / 1000);

export async function ig(token, method, path, params) {
  const url = new URL(path.startsWith("http") ? path : `${API}/${path}`);
  const init = { method, headers: { Authorization: `Bearer ${token}` } };
  if (method === "GET") {
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  } else if (params) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(params);
  }
  const r = await fetch(url, init);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) {
    const err = new Error(`${method} ${url.pathname}: ${d.error?.message || r.status}`);
    err.code = d.error?.code;
    throw err;
  }
  return d;
}

export const buttons = (text, btns) => ({
  attachment: { type: "template", payload: { template_type: "button", text, buttons: btns } },
});
export const postback = (title, payload) => ({ type: "postback", title, payload });
export const weblink = (title, url) => ({ type: "web_url", title, url });

// Send a DM; if the button template is rejected, send plain text instead.
export async function sendDM(env, acct, recipient, message, fallbackText) {
  try {
    return await ig(acct.token, "POST", `${acct.ig_user_id}/messages`, { recipient, message });
  } catch (e) {
    if (!fallbackText || !message.attachment) throw e;
    await logEvent(env, acct.ig_user_id, "warn", `button message rejected, sent text instead (${e.message.slice(0, 120)})`);
    return ig(acct.token, "POST", `${acct.ig_user_id}/messages`, { recipient, message: { text: fallbackText } });
  }
}

export async function logEvent(env, acctId, level, msg) {
  console.log(`[${level}] ${acctId || "-"} ${msg}`);
  await env.DB.prepare("INSERT INTO events (ig_user_id, ts, level, msg) VALUES (?, ?, ?, ?)")
    .bind(acctId || null, now(), level, String(msg).slice(0, 1000)).run();
  // errors and "needs help" replies also go to email (grouped, see alerts.js)
  const m = String(msg);
  if (level === "error" || m.includes("🙋")) {
    const acct = acctId ? await env.DB.prepare("SELECT username FROM accounts WHERE ig_user_id = ?").bind(acctId).first() : null;
    await alert(env, m.includes("🙋") ? "urgent" : "error", `${acct ? `@${acct.username}: ` : ""}${m.slice(0, 200)}`);
  }
}

export async function getAccount(env, id) {
  return env.DB.prepare("SELECT * FROM accounts WHERE ig_user_id = ? OR app_scoped_id = ? OR username = ?")
    .bind(id, id, id).first();
}

// Connect (or reconnect) an account from a long-lived token.
export async function upsertAccount(env, token, expiresIn) {
  const me = await ig(token, "GET", "me", { fields: "user_id,username,id" });
  await ig(token, "POST", "me/subscribed_apps?subscribed_fields=comments,messages,messaging_postbacks");
  const t = now();
  await env.DB.prepare(
    `INSERT INTO accounts (ig_user_id, app_scoped_id, username, token, token_expires, token_refreshed, status, created)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
     ON CONFLICT (ig_user_id) DO UPDATE SET app_scoped_id = excluded.app_scoped_id, username = excluded.username,
       token = excluded.token, token_expires = excluded.token_expires, token_refreshed = excluded.token_refreshed,
       status = 'active', error = NULL`
  ).bind(String(me.user_id), String(me.id), me.username, token, expiresIn ? t + expiresIn : null, t, t).run();
  await logEvent(env, String(me.user_id), "info", `account @${me.username} connected and subscribed to webhooks`);
  return { ig_user_id: String(me.user_id), username: me.username };
}

export async function refreshTokens(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM accounts WHERE status != 'paused' AND (token_refreshed IS NULL OR token_refreshed < ?)"
  ).bind(now() - 7 * 86400).all();
  for (const a of results) {
    try {
      const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${a.token}`);
      const d = await r.json();
      if (!d.access_token) throw new Error(d.error?.message || "no token returned");
      await env.DB.prepare("UPDATE accounts SET token = ?, token_expires = ?, token_refreshed = ?, status = 'active', error = NULL WHERE ig_user_id = ?")
        .bind(d.access_token, now() + (d.expires_in || 0), now(), a.ig_user_id).run();
      await logEvent(env, a.ig_user_id, "info", "token refreshed");
    } catch (e) {
      await env.DB.prepare("UPDATE accounts SET status = 'token_error', error = ? WHERE ig_user_id = ?").bind(e.message, a.ig_user_id).run();
      await logEvent(env, a.ig_user_id, "error", `token refresh failed, reconnect @${a.username}: ${e.message}`);
    }
  }
}

// Find a post's media id from a URL / shortcode / id.
export async function resolveMedia(acct, ref) {
  if (/^\d+$/.test(ref)) {
    const m = await ig(acct.token, "GET", ref, { fields: "id,permalink" });
    return { id: m.id, permalink: m.permalink };
  }
  const code = ref.replace(/\/+$/, "").split("/").pop().split("?")[0];
  let url = `${acct.ig_user_id}/media`;
  let params = { fields: "id,permalink", limit: 50 };
  for (let i = 0; i < 4 && url; i++) {
    const d = await ig(acct.token, "GET", url, params);
    const hit = d.data.find((m) => code && (m.permalink || "").includes(`/${code}`));
    if (hit) return { id: hit.id, permalink: hit.permalink };
    url = d.paging?.next;
    params = undefined;
  }
  throw new Error(`post ${ref} not found in @${acct.username}'s last 200 posts`);
}

export async function hmacHex(secret, text) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
