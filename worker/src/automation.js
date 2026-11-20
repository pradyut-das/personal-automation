// Triggers (comment / DM keyword / story reply / story mention)
//   -> public reply (comments) -> opener DM with button [+ Open profile]
//   -> (follow check) -> tracked link -> follow-up: "haven't opened it" OR "how was it?"
import { ig, now, buttons, postback, weblink, logEvent } from "./ig.js";
import { GENERIC_REPLIES, DEFAULTS, fill } from "./replies.js";
import { send } from "./sender.js";
import { alert } from "./alerts.js";

// ---------- helpers ----------
const norm = (t) => ` ${(t || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
const hasKeyword = (text, kws) => kws.includes("*") || kws.some((k) => norm(k).trim() && norm(text).includes(norm(k)));
const token = () => [...crypto.getRandomValues(new Uint8Array(10))].map((b) => (b % 36).toString(36)).join("");

export function parseRule(r) {
  const triggers = r.triggers ? JSON.parse(r.triggers) : ["comment", ...(r.dm_trigger ? ["dm"] : [])];
  return { ...r, media_ids: JSON.parse(r.media_ids), keywords: JSON.parse(r.keywords), triggers };
}

async function rulesFor(env, acctId, trigger) {
  const { results } = await env.DB.prepare("SELECT * FROM rules WHERE ig_user_id = ? AND active = 1 ORDER BY id").bind(acctId).all();
  const rules = results.map(parseRule).filter((r) => r.triggers.includes(trigger));
  // post-specific rules win over "every post" rules
  return [...rules.filter((r) => !r.media_ids.includes("*")), ...rules.filter((r) => r.media_ids.includes("*"))];
}

const vars = (acct, rule, lead) => ({
  name: lead?.username ? `@${lead.username}` : "",
  account: acct.username,
  thing: rule.thing || DEFAULTS.thing,
});
export const linkUrl = (env, lead) => `${(env.PUBLIC_URL || "").replace(/\/$/, "")}/r/${lead.token}`;
const profileBtn = (acct) => weblink(DEFAULTS.profile_button, `https://www.instagram.com/${acct.username}/`);
const stage = (leadId, s, due = null) => ["UPDATE leads SET stage = ?, followup_due = ?, updated = ? WHERE id = ?", s, due, now(), leadId];
const runSql = (env, q) => env.DB.prepare(q[0]).bind(...q.slice(1)).run();

async function pickReply(env, acct, rule) {
  const custom = rule.public_replies ? JSON.parse(rule.public_replies) : null;
  const list = custom?.length ? custom : GENERIC_REPLIES;
  let i = Math.floor(Math.random() * list.length);
  if (!custom && list.length > 1 && i === acct.last_reply_idx) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
  if (!custom) await env.DB.prepare("UPDATE accounts SET last_reply_idx = ? WHERE ig_user_id = ?").bind(i, acct.ig_user_id).run();
  return list[i];
}

async function createLead(env, acct, rule, igsid, f) {
  let username = f.username || null;
  if (!username) {
    try { username = (await ig(acct.token, "GET", igsid, { fields: "username" })).username || null; } catch {}
  }
  const t = now();
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO leads (ig_user_id, rule_id, igsid, username, comment_id, comment_text, source, media_id, token, stage, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`
  ).bind(acct.ig_user_id, rule.id, igsid, username, f.comment_id || null, (f.text || "").slice(0, 500), f.source, f.media_id || null, token(), t, t).run();
  if (!r.meta.changes) return null;
  return env.DB.prepare("SELECT * FROM leads WHERE id = ?").bind(r.meta.last_row_id).first();
}

function openerText(rule, source) {
  if (rule.opener_text) return rule.opener_text;
  if (source === "story_mention") return DEFAULTS.opener_mention;
  if (source === "story_reply") return DEFAULTS.opener_story;
  return rule.require_follow ? DEFAULTS.opener_follow : DEFAULTS.opener;
}

async function sendOpener(env, acct, rule, lead, recipient) {
  const v = vars(acct, rule, lead);
  const text = fill(openerText(rule, lead.source), v);
  const btns = [postback(fill(rule.ask_button || DEFAULTS.ask_button, v).slice(0, 20), `L:${lead.id}`)];
  if (rule.require_follow) btns.push(profileBtn(acct));
  return send(env, acct, {
    kind: "dm", recipient, message: buttons(text, btns),
    fallback: `${text}\n\nReply "yes" here and I'll send it 👇`,
    after: [stage(lead.id, "opened")], label: `${rule.name}: opener to ${v.name || lead.igsid}`,
  });
}

async function sendLink(env, acct, rule, lead, igsid, schedule) {
  const v = vars(acct, rule, lead);
  const text = fill(rule.link_text || DEFAULTS.link_text, v);
  const url = linkUrl(env, lead);
  const due = schedule && rule.followup_mins > 0 ? now() + rule.followup_mins * 60 : null;
  return send(env, acct, {
    kind: "dm", recipient: { id: igsid },
    message: buttons(text, [weblink(fill(rule.link_title || DEFAULTS.link_title, v).slice(0, 20), url)]),
    fallback: `${text}\n${url}`,
    after: schedule ? [stage(lead.id, "link_sent", due)] : [],
    label: `${rule.name}: link to ${v.name || igsid}`,
  });
}

// true / false / null (couldn't check)
async function follows(env, acct, igsid) {
  try {
    const d = await ig(acct.token, "GET", igsid, { fields: "is_user_follow_business" });
    return d.is_user_follow_business === true;
  } catch (e) {
    await logEvent(env, acct.ig_user_id, "warn", `follow check failed: ${e.message.slice(0, 150)}`);
    return null;
  }
}

async function advance(env, acct, rule, lead, sender, isTap) {
  const who = lead.username ? `@${lead.username}` : sender;
  if (["link_sent", "followed_up"].includes(lead.stage)) {
    if (isTap) await sendLink(env, acct, rule, lead, sender, false); // tapped an old button again
    return;
  }
  if (rule.require_follow) {
    const f = await follows(env, acct, sender);
    // not following -> ask; couldn't check -> ask once, then let them through
    if (f === false || (f === null && lead.stage !== "asked_follow")) {
      const t = fill(DEFAULTS.not_following, vars(acct, rule, lead));
      await send(env, acct, {
        kind: "dm", recipient: { id: sender },
        message: buttons(t, [profileBtn(acct), postback(DEFAULTS.retry_button, `L:${lead.id}`)]),
        fallback: `${t}\n\nReply "done" once you've followed.`,
        after: [stage(lead.id, "asked_follow")], label: `${rule.name}: follow ask to ${who}`,
      });
      return logEvent(env, acct.ig_user_id, "info", `${rule.name}: ${who} isn't following yet → asked to follow`);
    }
  }
  await sendLink(env, acct, rule, lead, sender, true);
  await logEvent(env, acct.ig_user_id, "info", `${rule.name}: ${who} → link sent${rule.followup_mins > 0 ? `, follow-up in ${rule.followup_mins} min` : ""}`);
}

async function startFlow(env, acct, rule, igsid, f, recipient) {
  const lead = await createLead(env, acct, rule, igsid, f);
  if (!lead) return null; // already went through this automation
  try {
    await sendOpener(env, acct, rule, lead, recipient);
  } catch (e) {
    await runSql(env, stage(lead.id, "error"));
    await logEvent(env, acct.ig_user_id, "error", `${rule.name}: DM to ${lead.username ? "@" + lead.username : igsid} failed: ${e.message.slice(0, 200)}`);
    return null;
  }
  return lead;
}

// ---------- webhook entry points ----------
export async function onComment(env, acct, v) {
  const from = v.from || {};
  if (!v.id || !from.id) return;
  if (from.id === acct.ig_user_id || from.id === acct.app_scoped_id || from.username === acct.username) return;

  const rule = (await rulesFor(env, acct.ig_user_id, "comment")).find(
    (r) => (r.media_ids.includes("*") || r.media_ids.includes(v.media?.id)) && hasKeyword(v.text, r.keywords)
  );
  if (!rule) return;

  const lead = await startFlow(env, acct, rule, from.id,
    { username: from.username, comment_id: v.id, text: v.text, source: "comment", media_id: v.media?.id }, { comment_id: v.id });
  if (!lead) return;
  try {
    await send(env, acct, { kind: "reply", comment_id: v.id, text: await pickReply(env, acct, rule), label: `${rule.name}: public reply to @${from.username}` });
  } catch (e) {
    await logEvent(env, acct.ig_user_id, "warn", `${rule.name}: public reply to @${from.username} failed: ${e.message.slice(0, 200)}`);
  }
  await logEvent(env, acct.ig_user_id, "info", `${rule.name}: @${from.username} commented "${(v.text || "").slice(0, 60)}" → replied + DM sent`);
}

export async function onMessaging(env, acct, m) {
  const sender = m.sender?.id;
  if (!sender || m.message?.is_echo || m.is_self || sender === acct.ig_user_id || sender === acct.app_scoped_id) return;
  if (m.message?.is_deleted || m.read || m.reaction || m.message_edit) return;
  if (m._standby) {
    // Another app still owns this chat (left over from an older tool), so Instagram won't let us reply.
    // If they were waiting for a link, email you so you can send it by hand.
    const p = m.postback?.payload || m.message?.quick_reply?.payload;
    const lead = p?.startsWith("L:")
      ? await env.DB.prepare("SELECT l.*, r.name AS rule_name, r.link_url FROM leads l JOIN rules r ON r.id = l.rule_id WHERE l.id = ? AND l.ig_user_id = ?").bind(Number(p.slice(2)), acct.ig_user_id).first()
      : m.message?.text
        ? await env.DB.prepare("SELECT l.*, r.name AS rule_name, r.link_url FROM leads l JOIN rules r ON r.id = l.rule_id WHERE l.ig_user_id = ? AND l.igsid = ? AND l.stage IN ('opened','asked_follow') ORDER BY l.updated DESC LIMIT 1").bind(acct.ig_user_id, sender).first()
        : null;
    if (!lead) return logEvent(env, acct.ig_user_id, "warn", `standby event from ${sender}: another app owns this chat, can't reply`);
    const who = lead.username ? `@${lead.username}` : sender;
    await env.DB.prepare("UPDATE leads SET stage = 'error', updated = ? WHERE id = ?").bind(now(), lead.id).run();
    await logEvent(env, acct.ig_user_id, "warn", `${lead.rule_name}: ${who} asked for the link but their chat is owned by another app, send it manually`);
    await alert(env, "urgent", `Send ${who} the link by hand`,
      `${who} tapped for the link (${lead.rule_name}), but Instagram still gives control of this chat to an older app, so the automation can't reply.\n\nOpen their DM on @${acct.username} and send:\n${lead.link_url}`,
      `manual-${lead.id}`);
    return;
  }

  const payload = m.postback?.payload || m.message?.quick_reply?.payload;
  const text = m.message?.text || "";

  // 1) button taps / quick replies
  if (payload?.startsWith("L:")) {
    const lead = await env.DB.prepare("SELECT * FROM leads WHERE id = ? AND ig_user_id = ?").bind(Number(payload.slice(2)), acct.ig_user_id).first();
    return lead && continueLead(env, acct, lead, sender, true);
  }
  if (payload?.startsWith("FB:")) return onFeedback(env, acct, payload, sender);

  // 2) story mention
  if ((m.message?.attachments || []).some((a) => a.type === "story_mention")) {
    const rule = (await rulesFor(env, acct.ig_user_id, "story_mention"))[0];
    if (!rule) return;
    const lead = await startFlow(env, acct, rule, sender, { source: "story_mention", text: "(story mention)" }, { id: sender });
    if (lead) await logEvent(env, acct.ig_user_id, "info", `${rule.name}: ${lead.username ? "@" + lead.username : sender} mentioned you in a story → DM sent`);
    return;
  }

  // 3) story reply
  const story = m.message?.reply_to?.story;
  if (story) {
    const rule = (await rulesFor(env, acct.ig_user_id, "story_reply")).find(
      (r) => (r.media_ids.includes("*") || r.media_ids.includes(String(story.id))) && hasKeyword(text, r.keywords)
    );
    if (rule) {
      const lead = await startFlow(env, acct, rule, sender, { source: "story_reply", text, media_id: story.id }, { id: sender });
      if (lead) await logEvent(env, acct.ig_user_id, "info", `${rule.name}: story reply "${text.slice(0, 40)}" → DM sent`);
      return;
    }
  }

  if (!text) return;

  // 4) a typed reply while we're waiting for their tap
  const waiting = await env.DB.prepare(
    "SELECT * FROM leads WHERE ig_user_id = ? AND igsid = ? AND stage IN ('opened', 'asked_follow') ORDER BY updated DESC LIMIT 1"
  ).bind(acct.ig_user_id, sender).first();
  if (waiting) return continueLead(env, acct, waiting, sender, false);

  // 5) DM keyword
  const rule = (await rulesFor(env, acct.ig_user_id, "dm")).find((r) => hasKeyword(text, r.keywords.filter((k) => k !== "*")));
  if (rule) {
    const lead = await startFlow(env, acct, rule, sender, { source: "dm", text }, { id: sender });
    if (lead) await logEvent(env, acct.ig_user_id, "info", `${rule.name}: DM keyword "${text.slice(0, 40)}" → DM sent`);
  }
}

async function continueLead(env, acct, lead, sender, isTap) {
  if (lead.igsid !== sender) await env.DB.prepare("UPDATE OR IGNORE leads SET igsid = ? WHERE id = ?").bind(sender, lead.id).run();
  const row = await env.DB.prepare("SELECT * FROM rules WHERE id = ?").bind(lead.rule_id).first();
  if (!row) return;
  try {
    await advance(env, acct, parseRule(row), lead, sender, isTap);
  } catch (e) {
    await logEvent(env, acct.ig_user_id, "error", `${row.name}: DM to ${lead.username ? "@" + lead.username : sender} failed: ${e.message.slice(0, 200)}`);
  }
}

async function onFeedback(env, acct, payload, sender) {
  const [, id, value] = payload.split(":");
  const lead = await env.DB.prepare("SELECT l.*, r.name AS rule_name FROM leads l JOIN rules r ON r.id = l.rule_id WHERE l.id = ? AND l.ig_user_id = ?")
    .bind(Number(id), acct.ig_user_id).first();
  if (!lead) return;
  await env.DB.prepare("UPDATE leads SET feedback = ?, updated = ? WHERE id = ?").bind(value, now(), lead.id).run();
  const who = lead.username ? `@${lead.username}` : sender;
  await send(env, acct, { kind: "dm", recipient: { id: sender }, message: { text: DEFAULTS.review_thanks[value] || "Thank you 🙏" }, label: `${lead.rule_name}: thanks to ${who}` });
  await logEvent(env, acct.ig_user_id, value === "help" ? "warn" : "info",
    value === "help" ? `🙋 ${who} needs help with ${lead.rule_name}, reply to them in Instagram` : `${lead.rule_name}: ${who} rated it "${value}"`);
}

// ---------- cron: follow-ups ----------
export async function runFollowups(env) {
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT l.*, r.name AS rule_name, r.followup_text, r.review_text, r.link_title, r.thing,
            a.token, a.username AS acct_username
     FROM leads l JOIN rules r ON r.id = l.rule_id JOIN accounts a ON a.ig_user_id = l.ig_user_id
     WHERE l.stage = 'link_sent' AND l.followup_due IS NOT NULL AND l.followup_due <= ? AND a.status = 'active' LIMIT 40`
  ).bind(t).all();
  for (const l of results) {
    const acct = { ig_user_id: l.ig_user_id, token: l.token, username: l.acct_username };
    const v = vars(acct, { thing: l.thing }, l);
    const who = v.name || l.igsid;
    const done = stage(l.id, "followed_up");
    if (t - l.updated > 23 * 3600) { // Instagram only allows messages within 24h of their last message
      await runSql(env, done);
      await logEvent(env, l.ig_user_id, "warn", `${l.rule_name}: follow-up to ${who} skipped (outside 24h window)`);
      continue;
    }
    let job;
    if (l.clicks > 0) {
      job = {
        kind: "dm", recipient: { id: l.igsid },
        message: {
          text: fill(l.review_text || DEFAULTS.review, v),
          quick_replies: DEFAULTS.review_options.map((o) => ({ content_type: "text", title: o.title, payload: `FB:${l.id}:${o.value}` })),
        },
        after: [done], label: `${l.rule_name}: "how was it?" to ${who}`,
      };
    } else {
      const text = fill(l.followup_text || DEFAULTS.followup, v);
      const url = linkUrl(env, l);
      job = {
        kind: "dm", recipient: { id: l.igsid },
        message: buttons(text, [weblink(fill(l.link_title || DEFAULTS.link_title, v).slice(0, 20), url)]),
        fallback: `${text}\n${url}`, after: [done], label: `${l.rule_name}: "haven't opened it" to ${who}`,
      };
    }
    try {
      const r = await send(env, acct, job);
      if (r.sent) await logEvent(env, l.ig_user_id, "info", `${job.label} sent`);
    } catch (e) {
      await runSql(env, done);
      await logEvent(env, l.ig_user_id, "error", `${l.rule_name}: follow-up to ${who} failed: ${e.message.slice(0, 200)}`);
    }
  }
}

// ---------- click tracking ----------
export async function trackClick(env, tok, ua) {
  const lead = await env.DB.prepare(
    "SELECT l.id, l.ig_user_id, l.username, l.clicks, r.link_url, r.name FROM leads l JOIN rules r ON r.id = l.rule_id WHERE l.token = ?"
  ).bind(tok).first();
  if (!lead) return null;
  if (!/facebookexternalhit|Facebot|bot\b|crawler|preview/i.test(ua || "")) {
    await env.DB.prepare("UPDATE leads SET clicks = clicks + 1, first_click = COALESCE(first_click, ?) WHERE id = ?").bind(now(), lead.id).run();
    if (!lead.clicks) await logEvent(env, lead.ig_user_id, "info", `${lead.name}: ${lead.username ? "@" + lead.username : "someone"} opened the link`);
  }
  return lead.link_url;
}
