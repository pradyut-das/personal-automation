// Content calendar: scheduled posts (pending / processing / published / failed) plus anything posted
// outside the scheduler (from post_stats), with the automation keywords attached to each post.
export async function calendarItems(env, from, to, acctId = null) {
  const af = acctId ? " AND p.ig_user_id = ?" : "";
  const sf = acctId ? " AND s.ig_user_id = ?" : "";
  const ab = acctId ? [acctId] : [];
  const { results: posts } = await env.DB.prepare(
    `SELECT p.id, p.ig_user_id, p.publish_at AS ts, p.status, p.type, p.caption, p.permalink, p.media_id, p.autodm, p.error, a.username
     FROM posts p JOIN accounts a ON a.ig_user_id = p.ig_user_id WHERE p.publish_at BETWEEN ? AND ?${af}`
  ).bind(from, to, ...ab).all();
  const { results: outside } = await env.DB.prepare(
    `SELECT s.media_id, s.ig_user_id, s.posted AS ts, 'posted' AS status, LOWER(s.media_type) AS type, s.caption, s.permalink, a.username
     FROM post_stats s JOIN accounts a ON a.ig_user_id = s.ig_user_id
     WHERE s.posted BETWEEN ? AND ?${sf} AND s.media_id NOT IN (SELECT media_id FROM posts WHERE media_id IS NOT NULL)`
  ).bind(from, to, ...ab).all();
  const { results: rules } = await env.DB.prepare("SELECT media_ids, keywords FROM rules WHERE active = 1").all();
  const kwByMedia = {};
  for (const r of rules) for (const m of JSON.parse(r.media_ids)) (kwByMedia[m] ||= []).push(...JSON.parse(r.keywords));

  const items = [
    ...posts.map((p) => ({ ...p, source: "scheduler", keywords: p.media_id && kwByMedia[p.media_id] ? kwByMedia[p.media_id] : p.autodm ? JSON.parse(p.autodm).keywords : [] })),
    ...outside.map((p) => ({ ...p, type: (p.type || "").replace("reels", "reel").replace("feed", "post"), source: "outside", keywords: kwByMedia[p.media_id] || [] })),
  ];
  // YouTube: scheduled/uploaded videos + anything else on the channel (from stats)
  if (!acctId) {
    const { results: ytv } = await env.DB.prepare(
      `SELECT v.publish_at AS ts, v.status, v.title AS caption, v.video_id, v.error, a.title AS username
       FROM yt_videos v JOIN yt_accounts a ON a.channel_id = v.channel_id WHERE v.publish_at BETWEEN ? AND ?`).bind(from, to).all();
    const { results: yts } = await env.DB.prepare(
      `SELECT s.published AS ts, 'posted' AS status, s.title AS caption, s.video_id, s.is_short, a.title AS username
       FROM yt_stats s JOIN yt_accounts a ON a.channel_id = s.channel_id
       WHERE s.published BETWEEN ? AND ? AND s.video_id NOT IN (SELECT video_id FROM yt_videos WHERE video_id IS NOT NULL)`).bind(from, to).all();
    const { results: ytr } = await env.DB.prepare("SELECT video_ids, keywords FROM yt_rules WHERE active = 1").all();
    const ytKw = {};
    for (const r of ytr) for (const m of JSON.parse(r.video_ids)) (ytKw[m] ||= []).push(...JSON.parse(r.keywords));
    for (const v of [...ytv, ...yts]) {
      items.push({ ...v, platform: "youtube", type: v.is_short ? "short" : "video", source: v.status === "posted" ? "outside" : "scheduler",
        status: v.status === "scheduled" || v.status === "uploading" ? "pending" : v.status,
        permalink: v.video_id ? `https://youtu.be/${v.video_id}` : null, keywords: (v.video_id && ytKw[v.video_id]) || [] });
    }
  }
  if (!acctId) {
    const { results: lip } = await env.DB.prepare(
      `SELECT p.publish_at AS ts, p.status, p.text AS caption, p.kind AS type, p.permalink, p.error, a.name AS username
       FROM li_posts p JOIN li_accounts a ON a.person_urn = p.person_urn WHERE p.publish_at BETWEEN ? AND ?`).bind(from, to).all();
    for (const p of lip) items.push({ ...p, platform: "linkedin", source: "scheduler", keywords: [],
      status: ["uploading", "processing"].includes(p.status) ? "pending" : p.status });
  }
  return items.map((i) => ({ platform: "instagram", ...i })).sort((a, b) => a.ts - b.ts);
}
