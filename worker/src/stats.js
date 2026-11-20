// Per-post analytics: Instagram insights + our funnel (triggered -> DM -> link -> click -> follow-up -> feedback)
import { ig, now, logEvent } from "./ig.js";

const METRIC_SETS = [["views", "reach", "saved", "shares"], ["reach", "saved", "shares"], ["reach"]];

async function insights(token, mediaId) {
  for (const set of METRIC_SETS) {
    try {
      const d = await ig(token, "GET", `${mediaId}/insights`, { metric: set.join(",") });
      return Object.fromEntries(d.data.map((x) => [x.name, x.values?.[0]?.value ?? x.total_value?.value ?? null]));
    } catch {}
  }
  return {};
}

export async function refreshStats(env, onlyAcct) {
  const { results: accts } = await env.DB.prepare("SELECT * FROM accounts WHERE status = 'active'").all();
  let n = 0;
  for (const a of accts) {
    if (onlyAcct && a.ig_user_id !== onlyAcct) continue;
    try {
      // recent posts + anything with an automation or leads in the last 30 days
      const recent = await ig(a.token, "GET", `${a.ig_user_id}/media`, { fields: "id", limit: 25 });
      const ids = new Set(recent.data.map((m) => m.id));
      const { results: extra } = await env.DB.prepare(
        `SELECT DISTINCT media_id FROM leads WHERE ig_user_id = ? AND media_id IS NOT NULL AND created > ?
         UNION SELECT media_id FROM posts WHERE ig_user_id = ? AND media_id IS NOT NULL AND publish_at > ?`
      ).bind(a.ig_user_id, now() - 30 * 86400, a.ig_user_id, now() - 30 * 86400).all();
      extra.forEach((r) => ids.add(r.media_id));
      const { results: rules } = await env.DB.prepare("SELECT media_ids FROM rules WHERE ig_user_id = ?").bind(a.ig_user_id).all();
      rules.forEach((r) => JSON.parse(r.media_ids).filter((x) => x !== "*").forEach((x) => ids.add(x)));

      for (const id of ids) {
        let m;
        try { m = await ig(a.token, "GET", id, { fields: "id,permalink,caption,media_type,media_product_type,timestamp,like_count,comments_count" }); }
        catch { continue; } // stories expire, deleted posts...
        const ins = await insights(a.token, id);
        await env.DB.prepare(
          `INSERT INTO post_stats (media_id, ig_user_id, permalink, caption, media_type, posted, views, reach, likes, comments, shares, saves, updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (media_id) DO UPDATE SET permalink = excluded.permalink, caption = excluded.caption, views = excluded.views,
             reach = excluded.reach, likes = excluded.likes, comments = excluded.comments, shares = excluded.shares, saves = excluded.saves, updated = excluded.updated`
        ).bind(id, a.ig_user_id, m.permalink || null, (m.caption || "").slice(0, 300), m.media_product_type || m.media_type,
          m.timestamp ? Math.floor(Date.parse(m.timestamp) / 1000) : null, ins.views ?? null, ins.reach ?? null,
          m.like_count ?? null, m.comments_count ?? null, ins.shares ?? null, ins.saved ?? null, now()).run();
        n++;
      }
    } catch (e) {
      await logEvent(env, a.ig_user_id, "warn", `post stats refresh failed: ${e.message.slice(0, 150)}`);
    }
  }
  return n;
}

// rows for dashboard / CLI
export async function postAnalytics(env, acctId, limit = 30) {
  const f = acctId ? "WHERE s.ig_user_id = ?" : "";
  const { results } = await env.DB.prepare(
    `SELECT s.*, a.username,
       COUNT(l.id) AS triggered,
       SUM(l.stage NOT IN ('new','error')) AS dms,
       SUM(l.stage IN ('link_sent','followed_up')) AS links,
       SUM(l.clicks > 0) AS clicked,
       SUM(l.stage = 'followed_up') AS followups,
       SUM(l.feedback = 'loved') AS loved, SUM(l.feedback = 'help') AS help
     FROM post_stats s JOIN accounts a ON a.ig_user_id = s.ig_user_id
     LEFT JOIN leads l ON l.media_id = s.media_id
     ${f} GROUP BY s.media_id ORDER BY s.posted DESC LIMIT ?`
  ).bind(...(acctId ? [acctId] : []), limit).all();
  return results;
}
