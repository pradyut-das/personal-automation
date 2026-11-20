# AGENTS.md: running Personal Automation from a chat

You are operating the owner's Instagram, YouTube and LinkedIn through `pa.py` (this repo's CLI), which talks to their deployed Cloudflare Worker. The owner talks to you in plain language. You turn that into `pa.py` commands, show what you're about to do, and report back.

## Before you act
- Run from the repo root. `pa.py` reads `PA_WORKER`, `PA_ADMIN_KEY` and `PA_TZ` from `.env`. All times the owner types and sees are in `PA_TZ`.
- **Anything that publishes or messages people is outward-facing.** Before scheduling or publishing a post, adding a comment → DM automation, or editing a live video's description, show the owner the exact caption/text, time, files and link, and wait for a yes.
- Never invent claims in captions or DMs (numbers, results, client names). Ask if something isn't known.
- Never print or commit secrets (`.env`, tokens, API keys).

## Translate requests like these
| Owner says | You run |
|---|---|
| "Schedule this reel tomorrow 6pm, people who comment GUIDE get the PDF" | `./pa.py post-add --at "YYYY-MM-DD 18:00" --type reel --media <file> --caption "..." --keyword guide --thing guide --link <pdf> --follow` |
| "Post these 5 reels, one at 10am and one at 6pm" | one `post-add` per reel, alternating 10:00 / 18:00 from the next free slot; check `./pa.py calendar` first |
| "Add an AI → DM automation to my last reel" | `./pa.py auto-add --post <reel url> --keyword ai --thing workflow --link <url or pdf>` |
| "DM anyone who mentions me in a story" | `./pa.py auto-add --on story_mention --thing "free guide" --link <...>` |
| "Change the caption / time of tomorrow's post" | `./pa.py posts` → `./pa.py post-edit <id> --caption "..." --at "..."` |
| "Use this image as the reel cover" | `./pa.py post-edit <id> --cover <image>` (queued posts only) |
| "Put this on YouTube Friday 5pm with the guide link" | `./pa.py yt-post-add --at "..." --media <file> --title "..." --description-file <txt> --link <pdf>` |
| "Add the link to my YouTube video" | `./pa.py yt-link <video url> --link <url or pdf>` |
| "Post this carousel on LinkedIn Monday 9am" | `./pa.py li-post-add --at "..." --text-file <txt> --media <pdf>` |
| "What's coming up / what did I post?" | `./pa.py calendar` |
| "How did my reels do?" | `./pa.py stats --refresh` (+ `./pa.py yt-stats --refresh`) and summarise: views, reach, leads, link opens |
| "Who asked for the guide?" / "anything broken?" | `./pa.py leads`, `./pa.py log`, `./pa.py events`, `./pa.py queue` |
| "Stop that automation" | `./pa.py autos` → `./pa.py auto-pause <name>` (or `auto-rm`) |

`./pa.py --help` and `./pa.py <command> --help` list every option.

## Good to know
- Local files are uploaded for you. Reels are checked against Instagram's spec and re-encoded only if needed. PDFs open as a flipbook link.
- Instagram buttons max 20 characters ("Send me the {thing}"). Keep `--thing` short.
- One flow per person per automation. DMs only within 24h of the person's last message (the follow-up is timed to fit).
- YouTube: 10,000 quota units/day (upload 1,600, comment reply 50). Prefer `--link` in the description over comment replies.
- LinkedIn sign-in lasts 60 days. If `li-accounts` shows it near expiry, tell the owner to run `./pa.py li-connect`.
- If DMs fail with `not the thread owner`, another tool still owns that conversation (see README).
