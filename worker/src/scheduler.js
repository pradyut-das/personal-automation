// Cloud post scheduler. A small state machine advanced by the every-minute cron,
// so long video processing never blocks a single run:
//   pending -> (create containers) -> processing -> (containers FINISHED) -> publish -> published
import { ig, now, logEvent } from "./ig.js";
import { insertRule } from "./index.js";

const isVideo = (u) => /\.(mp4|mov)(\?|$)/i.test(u);

async function status(token, id) {
  const d = await ig(token, "GET", id, { fields: "status_code,status" });
  if (["ERROR", "EXPIRED"].includes(d.status_code)) throw new Error(`container ${d.status_code}: ${d.status || ""}`);
  return d.status_code === "FINISHED" || d.status_code === "PUBLISHED";
}

async function create(acct, params) {
  return (await ig(acct.token, "POST", `${acct.ig_user_id}/media`, params)).id;
}

async function step(env, acct, p) {
  const media = JSON.parse(p.media);
  const upd = (sql, ...b) => env.DB.prepare(`UPDATE posts SET ${sql} WHERE id = ?`).bind(...b, p.id).run();

  if (p.status === "pending") {
    if (p.type === "carousel") {
      const kids = [];
      for (const m of media) {
        kids.push(await create(acct, isVideo(m)
          ? { media_type: "VIDEO", video_url: m, is_carousel_item: true }
          : { image_url: m, is_carousel_item: true }));
      }
      return upd("status = 'processing', children = ?, started = ?", JSON.stringify(kids), now());
    }
    let params;
    if (p.type === "image") params = { image_url: media[0], caption: p.caption || "" };
    else if (p.type === "reel") params = { media_type: "REELS", video_url: media[0], caption: p.caption || "", share_to_feed: true, ...(p.cover ? { cover_url: p.cover } : {}) };
    else if (p.type === "story") params = { media_type: "STORIES", [isVideo(media[0]) ? "video_url" : "image_url"]: media[0] };
    else throw new Error(`unknown type ${p.type}`);
    return upd("status = 'processing', container_id = ?, started = ?", await create(acct, params), now());
  }

  // processing
  if (now() - p.started > 30 * 60) throw new Error("media still processing after 30 min");
  if (p.type === "carousel" && !p.container_id) {
    const kids = JSON.parse(p.children);
    for (const k of kids) if (!(await status(acct.token, k))) return; // try again next minute
    const id = await create(acct, { media_type: "CAROUSEL", children: kids.join(","), caption: p.caption || "" });
    return upd("container_id = ?", id);
  }
  if (!(await status(acct.token, p.container_id))) return;

  const { id: mediaId } = await ig(acct.token, "POST", `${acct.ig_user_id}/media_publish`, { creation_id: p.container_id });
  const { permalink } = await ig(acct.token, "GET", mediaId, { fields: "permalink" });
  await upd("status = 'published', media_id = ?, permalink = ?, error = NULL", mediaId, permalink || null);
  await logEvent(env, acct.ig_user_id, "info", `post ${p.id} published → ${permalink}`);

  if (p.autodm) {
    const r = JSON.parse(p.autodm);
    try {
      await insertRule(env, acct.ig_user_id, r, [mediaId], permalink);
      await logEvent(env, acct.ig_user_id, "info", `automation ${r.name} is live on post ${p.id}`);
    } catch (e) {
      await logEvent(env, acct.ig_user_id, "error", `post ${p.id} published but automation ${r.name} wasn't created: ${e.message}`);
    }
  }
  // uploaded files are only needed until Instagram has fetched them
  for (const key of p.uploads ? JSON.parse(p.uploads) : []) {
    try { await env.MEDIA.delete(key); } catch {}
  }
}

export async function runScheduler(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.*, a.token, a.username FROM posts p JOIN accounts a ON a.ig_user_id = p.ig_user_id
     WHERE a.status = 'active' AND (p.status = 'processing' OR (p.status = 'pending' AND p.publish_at <= ?))
     ORDER BY p.publish_at LIMIT 10`
  ).bind(now()).all();
  for (const p of results) {
    const acct = { ig_user_id: p.ig_user_id, token: p.token, username: p.username };
    try {
      await step(env, acct, p);
    } catch (e) {
      const attempts = (p.attempts || 0) + 1;
      const final = attempts >= 3;
      await env.DB.prepare(
        "UPDATE posts SET status = ?, attempts = ?, error = ?, children = NULL, container_id = NULL, started = NULL WHERE id = ?"
      ).bind(final ? "failed" : "pending", attempts, e.message.slice(0, 500), p.id).run();
      await logEvent(env, p.ig_user_id, final ? "error" : "warn", `post ${p.id} attempt ${attempts} failed${final ? " (giving up)" : ""}: ${e.message.slice(0, 200)}`);
    }
  }
}
