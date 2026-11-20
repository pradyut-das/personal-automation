// Durable webhook handling: every signed event is saved to D1 before we answer Meta,
// processed right away, and retried by the cron (1, 5, 15, 60 min) if processing crashes.
// Re-deliveries of the exact same body are ignored (sha256 dedupe).
import { now, logEvent, getAccount } from "./ig.js";
import { onComment, onMessaging } from "./automation.js";
import { alert } from "./alerts.js";

const BACKOFF = [60, 300, 900, 3600];
const MAX_ATTEMPTS = 5;

// DMs/taps arrive in entry.messaging (or entry.standby), but Meta can also wrap them in entry.changes
export const MSG_FIELDS = new Set(["standby", "messages", "messaging_postbacks", "message_reactions", "messaging_seen", "message_edit", "messaging_referral"]);
export const messagingOf = (entry) => [
  ...(entry.messaging || []),
  ...(entry.standby || []).map((m) => ({ ...m, _standby: true })),
  ...(entry.changes || []).filter((c) => MSG_FIELDS.has(c.field) && c.value).map((c) => c.value),
];

async function sha256(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// returns the stored event id, or null if it's a duplicate delivery
export async function storeEvent(env, raw) {
  const r = await env.DB.prepare(
    "INSERT OR IGNORE INTO webhook_events (hash, received, body, status, attempts, next_try) VALUES (?, ?, ?, 'processing', 1, ?)"
  ).bind(await sha256(raw), now(), raw, now() + 300).run();
  return r.meta.changes ? r.meta.last_row_id : null;
}

async function handle(env, body) {
  if (body.object !== "instagram") return;
  for (const entry of body.entry || []) {
    const acct = await getAccount(env, String(entry.id));
    if (!acct || acct.status !== "active") {
      if (entry.id === "0") await logEvent(env, null, "info", "Meta dashboard test event received, ignored");
      continue;
    }
    for (const ch of entry.changes || []) if (ch.field === "comments") await onComment(env, acct, ch.value);
    for (const m of messagingOf(entry)) await onMessaging(env, acct, m);
  }
}

export async function processEvent(env, id, raw) {
  try {
    await handle(env, JSON.parse(raw));
    await env.DB.prepare("UPDATE webhook_events SET status = 'done', done_at = ?, error = NULL WHERE id = ?").bind(now(), id).run();
  } catch (e) {
    const ev = await env.DB.prepare("SELECT attempts FROM webhook_events WHERE id = ?").bind(id).first();
    const attempts = ev?.attempts || 1;
    const dead = attempts >= MAX_ATTEMPTS;
    await env.DB.prepare("UPDATE webhook_events SET status = ?, error = ?, next_try = ? WHERE id = ?")
      .bind(dead ? "dead" : "failed", String(e.stack || e).slice(0, 1000), now() + BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)], id).run();
    console.log("webhook event failed", id, e.stack || e);
    if (dead) await alert(env, "error", `A webhook event failed ${MAX_ATTEMPTS} times and was dropped`, `Event #${id}: ${String(e.message || e).slice(0, 300)}`);
  }
}

// cron: retry failed events + events stuck in "processing" (Worker died mid-way)
export async function retryEvents(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, body, status FROM webhook_events WHERE status IN ('failed', 'processing') AND next_try <= ? ORDER BY id LIMIT 20"
  ).bind(now()).all();
  for (const ev of results) {
    const claimed = await env.DB.prepare(
      "UPDATE webhook_events SET status = 'processing', attempts = attempts + 1, next_try = ? WHERE id = ? AND status = ?"
    ).bind(now() + 300, ev.id, ev.status).run();
    if (claimed.meta.changes) await processEvent(env, ev.id, ev.body);
  }
}
