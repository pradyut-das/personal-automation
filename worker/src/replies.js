// Public comment replies: one is picked at random for every automation
// (never the same one twice in a row on an account) unless a rule sets its own list.
export const GENERIC_REPLIES = [
  "Thanks! Please check your DMs 🙌",
  "Sent it to your DMs ✨",
  "Check your DMs 📩",
  "Just DM'd you 🚀",
  "It's in your inbox now 👀",
  "Done! Look in your DMs 💌",
  "Sliding into your DMs 😄",
  "Sent! Check your messages 🙏",
  "On its way to your DMs ⚡",
  "Check your inbox 🔥",
  "Sent you a DM, enjoy! 🎉",
  "You've got a DM 📬",
  "Dropped it in your DMs 🙌",
  "Thanks for commenting! Check your DMs ✨",
  "Sent 💫 Check your messages",
  "DM sent, have fun with it! 😊",
  "Just messaged you 👋",
  "Check your requests folder if you don't see it 📩",
  "Sent it over! 🚀",
  "Your DM is waiting 👀",
  "Delivered to your inbox ✅",
  "Thank you! It's in your DMs 💙",
  "Sent! Let me know what you think 🙌",
  "Check your DMs, sent it just now ⚡",
  "Hope it helps! Check your DMs 🤝",
];

// DM copy. Placeholders: {name} = their @username (or "there"), {account} = your @username,
// {thing} = what you're sending ("workflow", "PDF"...). Rules can override any of these.
export const DEFAULTS = {
  thing: "link",

  opener:
    "Hey {name} 👋\n\n" +
    "Thanks for the comment 🙌\n\n" +
    "Your {thing} is ready. Tap the button below and I'll send it right over 👇",

  opener_follow:
    "Hey {name} 👋\n\n" +
    "Thanks for the comment 🙌\n\n" +
    "Your {thing} is ready! Just make sure you're following @{account}, then tap the button below 👇",

  opener_story:
    "Hey {name} 👋\n\n" +
    "Thanks for the reply on my story 🙌\n\n" +
    "Tap below and I'll send you the {thing} 👇",

  opener_mention:
    "Hey {name} 👋\n\n" +
    "Thanks so much for the shoutout 🙏\n\n" +
    "Here's a little something for you, tap below 👇",

  ask_button: "Send me the {thing}",

  not_following:
    "Almost there! 👀\n\n" +
    "Looks like you're not following @{account} yet.\n\n" +
    "1️⃣ Tap Open profile and hit Follow\n" +
    "2️⃣ Come back here and tap I followed ✅",
  profile_button: "Open profile",
  retry_button: "I followed ✅",

  link_text:
    "Here's your {thing} 🎉\n\n" +
    "Tap below to open it 👇",
  link_title: "Open {thing}",

  // follow-up when they never opened the link
  followup:
    "Hey {name} 👋\n\n" +
    "Looks like you haven't opened the {thing} yet 👀\n\n" +
    "Here it is again, it only takes a minute 👇",
  // follow-up when they did open it
  review:
    "Hey {name} 👋\n\n" +
    "Hope you liked the {thing} 🙌\n\n" +
    "How was it?",
  review_options: [
    { title: "Loved it 🔥", value: "loved" },
    { title: "It was okay 👍", value: "okay" },
    { title: "Need help 🙋", value: "help" },
  ],
  review_thanks: {
    loved: "Love to hear that! 🔥\n\nMore coming soon, stay tuned 🚀",
    okay: "Thanks for the honest feedback 🙏\n\nI'll keep making it better!",
    help: "Got you 🙌\n\nReply here with your question and I'll get back to you personally.",
  },
  followup_mins: 60,
};

export function fill(text, vars) {
  return String(text || "").replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null && vars[k] !== "" ? vars[k] : m === "{name}" ? "there" : ""));
}
