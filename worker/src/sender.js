// Every outgoing DM / public reply goes through here.
// - Per-account hourly budget (DM_PER_HOUR / REPLY_PER_HOUR); over budget -> queued in `outbox`
// - Meta rate-limit errors -> queued with backoff
// - Button template rejected -> plain-text fallback
// - `after` = DB side effects to run only once the message really went out
import { ig, now, logEvent } from "./ig.js";

const RATE_CODES = new Set([4, 17, 32, 613]);
const isRateLimit = (e) => RATE_CODES.has(e.code) || /rate|limit|too many/i.test(e.message || "");

const limitFor = (env, kind) => Number(kind === "reply" ? env.REPLY_PER_HOUR || 100 : env.DM_PER_HOUR || 190);

async function usedLastHour(env, acctId, kind) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM sends WHERE ig_user_id = ? AND kind = ? AND ts > ?")
    .bind(acctId, kind, now() - 3600).first();
  return r?.n || 0;
}

async function deliver(env, acct, job) {
  if (job.kind === "reply") {
    await ig(acct.token, "POST", `${job.comment_id}/replies`, { message: job.text });
  } else {
    try {
      await ig(acct.token, "POST", `${acct.ig_user_id}/messages`, { recipient: job.recipient, message: job.message });
    } catch (e) {
      if (!job.fallback || !job.message.attachment || isRateLimit(e) || /thread owner/i.test(e.message)) throw e;
      await logEvent(env, acct.ig_user_id, "warn", `button message rejected, sent text instead (${e.message.slice(0, 120)})`);
      await ig(acct.token, "POST", `${acct.ig_user_id}/messages`, { recipient: job.recipient, message: { text: job.fallback } });
    }
  }
  await env.DB.prepare("INSERT INTO sends (ig_user_id, kind, ts) VALUES (?, ?, ?)").bind(acct.ig_user_id, job.kind, now()).run();
  for (const [sql, ...b] of job.after || []) await env.DB.prepare(sql).bind(...b).run();
}

async function enqueue(env, acct, job, delaySec, reason) {
  await env.DB.prepare("INSERT INTO outbox (ig_user_id, kind, payload, label, next_try, created) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(acct.ig_user_id, job.kind, JSON.stringify(job), job.label || null, now() + delaySec, now()).run();
  await logEvent(env, acct.ig_user_id, "warn", `${job.label || job.kind} queued (${reason})`);
  return { queued: true };
}

// job: { kind: "dm", recipient, message, fallback?, after?, label? } | { kind: "reply", comment_id, text, after?, label? }
export async function send(env, acct, job) {
  if ((await usedLastHour(env, acct.ig_user_id, job.kind)) >= limitFor(env, job.kind)) {
    return enqueue(env, acct, job, 60, `hourly ${job.kind} limit reached`);
  }
  try {
    await deliver(env, acct, job);
    return { sent: true };
  } catch (e) {
    if (isRateLimit(e)) return enqueue(env, acct, job, 300, `Meta rate limit: ${e.message.slice(0, 80)}`);
    throw e;
  }
}

// cron: drain the queue oldest-first within each account's budget
export async function drainOutbox(env) {
  const { results } = await env.DB.prepare(
    `SELECT o.*, a.token, a.username FROM outbox o JOIN accounts a ON a.ig_user_id = o.ig_user_id
     WHERE o.next_try <= ? AND a.status = 'active' ORDER BY o.id LIMIT 50`
  ).bind(now()).all();
  const budget = {};
  for (const o of results) {
    const key = `${o.ig_user_id}:${o.kind}`;
    budget[key] ??= limitFor(env, o.kind) - (await usedLastHour(env, o.ig_user_id, o.kind));
    if (budget[key] <= 0) continue;
    const acct = { ig_user_id: o.ig_user_id, token: o.token, username: o.username };
    const job = JSON.parse(o.payload);
    try {
      await deliver(env, acct, job);
      budget[key]--;
      await env.DB.prepare("DELETE FROM outbox WHERE id = ?").bind(o.id).run();
      await logEvent(env, o.ig_user_id, "info", `${o.label || o.kind} sent from queue`);
    } catch (e) {
      const attempts = o.attempts + 1;
      if (attempts >= 5 || !isRateLimit(e)) {
        await env.DB.prepare("DELETE FROM outbox WHERE id = ?").bind(o.id).run();
        await logEvent(env, o.ig_user_id, "error", `${o.label || o.kind} dropped from queue: ${e.message.slice(0, 160)}`);
      } else {
        await env.DB.prepare("UPDATE outbox SET attempts = ?, next_try = ? WHERE id = ?").bind(attempts, now() + 300 * attempts, o.id).run();
      }
    }
  }
}
