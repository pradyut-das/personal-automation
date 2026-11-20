#!/usr/bin/env python3
"""Personal Automation CLI: Instagram, YouTube and LinkedIn automations + scheduling (Cloudflare Worker "personal-automation").

Accounts
  ./pa.py accounts                       list connected accounts
  ./pa.py connect                        login link to connect another Instagram account
  ./pa.py pause-account USER / resume-account USER

Automations  (comment / DM keyword / story reply / story mention -> DM -> link -> follow-up)
  ./pa.py auto-add --post https://www.instagram.com/reel/XXXX/ --keyword pdf --thing PDF --link ./guide.pdf --follow
      --post        a post link, "any" for every post (also posts you publish later), or omit for story/DM-only
      --on          triggers, comma-separated: comment,dm,story_reply,story_mention   (default comment,dm)
      --keyword     trigger word(s); "*" = any message (story replies / mentions)
      --thing       what you're sending, used in the copy: "Send me the PDF", "Here's your PDF 🎉"
      --link        https link, or a local file: PDFs open as a flipbook, other files download
      --follow      only followers get the link (others get "Open profile" + "I followed ✅")
      --button / --link-title / --opener / --link-text / --followup / --review   override the copy
      --followup-mins 60 | --no-followup      --reply "..." (repeat) custom public replies
  ./pa.py autos [--account USER]         ./pa.py auto-pause NAME / auto-resume NAME / auto-rm NAME

Scheduled posts (local files are uploaded; reels are checked/encoded to Instagram's top spec)
  ./pa.py post-add --at "2026-11-25 18:30" --type reel --media ./reel.mp4 --caption "..." [--cover ./cover.jpg]
      [automation flags above: --keyword ... --link ...]   -> automation goes live when it publishes
  ./pa.py calendar     ./pa.py posts     ./pa.py post-edit ID --caption "..." --at "..." --cover ./cover.jpg     ./pa.py post-rm ID     ./pa.py post-now ID
  (all times are your PA_TZ time, )

Files
  ./pa.py upload ./guide.pdf             permanent link (PDF -> flipbook page)

Monitoring
  ./pa.py stats [--refresh]   ./pa.py leads   ./pa.py log   ./pa.py queue   ./pa.py quota   ./pa.py dashboard
LinkedIn (personal profile)
  ./pa.py li-connect    ./pa.py li-accounts    ./pa.py li-posts    ./pa.py li-post-rm ID    ./pa.py li-post-now ID
  ./pa.py li-post-add --at "2026-11-25 09:00" --text-file post.txt [--media ./carousel.pdf | ./video.mp4 | ./a.jpg ./b.jpg] [--title "..."]
  ./pa.py li-post-edit ID --text-file post.txt --at "..."

YouTube
  ./pa.py yt-connect     ./pa.py yt-accounts     ./pa.py yt-stats [--refresh]     ./pa.py yt-replies     ./pa.py yt-poll
  ./pa.py yt-auto-add --video https://youtube.com/shorts/XXXX --keyword ai --link ./guide.pdf [--mode description] [--reply "..."]
  ./pa.py yt-post-add --at "2026-11-25 18:00" --media ./short.mp4 --title "..." --description-file desc.txt --tags a,b [--thumb t.jpg]
        --link ./guide.pdf [--link-label "Get the free guide"]      the link goes on the description's first line
        [--auto-reply --keyword ai]                                  optional comment replies (50 quota units each)
  ./pa.py yt-link https://youtu.be/XXXX --link ./guide.pdf [--label "..."]   add the link to a video that's already up
  ./pa.py yt-autos   ./pa.py yt-auto-rm NAME   ./pa.py yt-posts   ./pa.py yt-post-rm ID

  ./pa.py events [--retry ID]   webhook events: saved, processed, retried   ./pa.py alert-test [--summary]
"""
import argparse, json, os, re, secrets, shutil, subprocess, sys, tempfile, urllib.request, urllib.error, urllib.parse
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path

ROOT = Path(__file__).resolve().parent
def _cfg(key, default=None):
    v = os.environ.get(key)
    if v:
        return v
    f = Path(__file__).resolve().parent / ".env"
    if f.exists():
        for ln in f.read_text().splitlines():
            if ln.startswith(key + "="):
                return ln.split("=", 1)[1].strip()
    return default


WORKER = (_cfg("PA_WORKER") or "").rstrip("/")   # your Worker URL, e.g. https://personal-automation.<you>.workers.dev
PUBLIC = (_cfg("PA_PUBLIC") or WORKER).rstrip("/")   # where uploaded files are served (defaults to the Worker URL)
BUCKET = "personal-automation-media"
TRIGGERS = ["comment", "dm", "story_reply", "story_mention"]
TZ = ZoneInfo(_cfg("PA_TZ", "UTC"))   # timezone for every time you type and see (e.g. Asia/Kolkata, Europe/London)


def env():
    e = {}
    for ln in (ROOT / ".env").read_text().splitlines():
        if "=" in ln and not ln.startswith("#"):
            k, v = ln.split("=", 1)
            e[k.strip()] = v.strip()
    return e


def call(method, path, body=None, **params):
    if not WORKER or not _cfg("PA_ADMIN_KEY"):
        sys.exit("set PA_WORKER and PA_ADMIN_KEY in .env (see README)")
    url = f"{WORKER}/api/{path}"
    params = {k: v for k, v in params.items() if v is not None}
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None, headers={
        "Authorization": f"Bearer {_cfg('PA_ADMIN_KEY')}", "Content-Type": "application/json", "User-Agent": "pa-cli"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error")
        except Exception:
            msg = e.reason
        sys.exit(f"error: {msg}")


def fmt(ts):
    return datetime.fromtimestamp(ts, TZ).strftime("%d %b %H:%M") if ts else "-"


def parse_at(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=TZ)
    except ValueError:
        sys.exit('--at must be "YYYY-MM-DD HH:MM" (your PA_TZ time)')


# ---------- uploads (R2 via wrangler, so large videos skip the Worker's 100 MB limit) ----------
def slug(name):
    stem, ext = os.path.splitext(os.path.basename(name))
    return (re.sub(r"[^a-zA-Z0-9]+", "-", stem).strip("-")[:60] or "file") + ext.lower()


def r2_put(path, key):
    path = os.path.abspath(os.path.expanduser(path))   # wrangler runs from worker/, so relative paths must be resolved here
    size = os.path.getsize(path)
    if size > 300 * 1024 * 1024:
        sys.exit(f"{path} is {size / 1e6:.0f} MB; Instagram's limit is 300 MB")
    print(f"  uploading {os.path.basename(path)} ({size / 1e6:.1f} MB)…")
    r = subprocess.run(["npx", "--yes", "wrangler@4.165.0", "r2", "object", "put", f"{BUCKET}/{key}", "--file", path, "--remote"],
                       cwd=ROOT / "worker", capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"upload failed:\n{r.stderr[-800:] or r.stdout[-800:]}")
    return f"{PUBLIC}/m/{urllib.parse.quote(key)}"


def pdf_visual_diff(gs, a, b, workdir, min_psnr=34.0):
    """Render both PDFs page by page and compare. Returns the first page number that looks different, else None."""
    da, db = os.path.join(workdir, "va"), os.path.join(workdir, "vb")
    os.makedirs(da, exist_ok=True); os.makedirs(db, exist_ok=True)
    for src, d in ((a, da), (b, db)):
        subprocess.run([gs, "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=png16m", "-r50", "-dTextAlphaBits=4", "-dGraphicsAlphaBits=4",
                        f"-sOutputFile={d}/p%03d.png", src], capture_output=True)
    pages_a, pages_b = sorted(os.listdir(da)), sorted(os.listdir(db))
    if len(pages_a) != len(pages_b) or not pages_a:
        return 1
    for i, name in enumerate(pages_a, 1):
        r = subprocess.run(["ffmpeg", "-hide_banner", "-i", f"{da}/{name}", "-i", f"{db}/{name}", "-lavfi", "psnr", "-f", "null", "-"],
                           capture_output=True, text=True)
        m = re.search(r"average:([\d.]+|inf)", r.stderr)
        if not m or (m.group(1) != "inf" and float(m.group(1)) < min_psnr):
            return i
    return None


def compress_pdf(src, workdir):
    """Shrink a PDF with Ghostscript (text stays vector, images ~200 dpi: sharp on phones). Keeps the original if it's smaller."""
    gs = shutil.which("gs")
    if not gs:
        print("  (Ghostscript not installed: uploading the PDF uncompressed. `brew install ghostscript` to enable)")
        return src
    out = os.path.join(workdir, Path(src).stem + "-c.pdf")
    r = subprocess.run([gs, "-sDEVICE=pdfwrite", "-dCompatibilityLevel=1.5", "-dPDFSETTINGS=/ebook", "-dNOPAUSE", "-dQUIET", "-dBATCH",
                        "-dDetectDuplicateImages=true", "-dCompressFonts=true", "-dSubsetFonts=true",
                        "-dDownsampleColorImages=true", "-dColorImageResolution=200", "-dDownsampleGrayImages=true", "-dGrayImageResolution=200",
                        "-dMonoImageResolution=300", f"-sOutputFile={out}", src], capture_output=True, text=True)
    before, after = os.path.getsize(src), (os.path.getsize(out) if r.returncode == 0 and os.path.exists(out) else 0)
    if not after or after >= before:
        print(f"  PDF already compact ({before / 1e6:.2f} MB), uploading as is")
        return src
    bad = pdf_visual_diff(gs, src, out, workdir)
    if bad:
        print(f"  compression changed how page {bad} looks (glows/transparency), uploading the original instead")
        return src
    print(f"  compressed PDF {before / 1e6:.2f} MB → {after / 1e6:.2f} MB ({100 - round(100 * after / before)}% smaller)")
    return out


def upload_file(path, folder="files"):
    """Permanent file for DMs. PDFs are compressed and get a flipbook link."""
    p = Path(path).expanduser()
    if not p.is_file():
        sys.exit(f"file not found: {p}")
    key = f"{folder}/{secrets.token_hex(4)}-{slug(p.name)}"
    if p.suffix.lower() == ".pdf":
        tmp = tempfile.mkdtemp(prefix="ig-pdf-")
        try:
            raw = r2_put(compress_pdf(str(p), tmp), key)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        return f"{PUBLIC}/f/{urllib.parse.quote(key)}", key
    raw = r2_put(str(p), key)
    if p.suffix.lower() == ".pdf":
        return f"{PUBLIC}/f/{urllib.parse.quote(key)}", key
    return raw, key


def probe(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path], capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f"can't read {path} (is it a video/image?)")
    return json.loads(r.stdout)


def fps_of(s):
    num, _, den = (s.get("avg_frame_rate") or s.get("r_frame_rate") or "0/1").partition("/")
    try:
        return float(num) / float(den or 1)
    except ZeroDivisionError:
        return 0.0


def prepare_video(path, workdir):
    """Instagram reel spec: H.264 High, yuv420p, <=1080x1920 (9:16), 23-60 fps, <=25 Mbps VBR, AAC 48 kHz,
    closed GOP, moov atom first. Remux untouched if already compliant, otherwise re-encode at max quality."""
    info = probe(path)
    v = next((s for s in info["streams"] if s["codec_type"] == "video"), None)
    a = next((s for s in info["streams"] if s["codec_type"] == "audio"), None)
    if not v:
        sys.exit(f"{path}: no video stream")
    w, h, fps = int(v["width"]), int(v["height"]), fps_of(v)
    rate = int(v.get("bit_rate") or info["format"].get("bit_rate") or 0)
    ok = (v["codec_name"] == "h264" and v.get("pix_fmt") == "yuv420p" and w <= 1080 and h <= 1920 and 23 <= fps <= 60
          and rate <= 25_000_000 and (a is None or (a["codec_name"] == "aac" and int(a.get("sample_rate", 0)) == 48000)))
    out = os.path.join(workdir, Path(path).stem + "-ig.mp4")
    if ok:
        print(f"  video already in Instagram spec ({w}x{h}, {fps:.0f} fps, {rate / 1e6:.1f} Mbps): remuxing only, no quality loss")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-c", "copy", "-movflags", "+faststart", out]
    else:
        tfps = min(max(round(fps) or 30, 23), 60)
        print(f"  encoding to Instagram's top spec (was {v['codec_name']} {w}x{h} {fps:.0f} fps {rate / 1e6:.1f} Mbps)…")
        vf = f"scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps={tfps},format=yuv420p"
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-stats", "-i", path, "-vf", vf,
               "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-level", "4.2", "-crf", "16",
               "-maxrate", "25M", "-bufsize", "50M", "-g", str(tfps * 2), "-keyint_min", str(tfps), "-sc_threshold", "0",
               "-x264-params", "open-gop=0", "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2",
               "-movflags", "+faststart", out]
    if subprocess.run(cmd).returncode != 0:
        sys.exit("ffmpeg failed")
    return out


def prepare_image(path, workdir):
    """Instagram only accepts JPEG for image posts; keep max quality, <=1440 px wide."""
    if Path(path).suffix.lower() in (".jpg", ".jpeg"):
        return path
    out = os.path.join(workdir, Path(path).stem + "-ig.jpg")
    if subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", path, "-vf", "scale='min(1440,iw)':-2:flags=lanczos", "-q:v", "1", out]).returncode != 0:
        sys.exit(f"couldn't convert {path} to JPEG")
    return out


def stage_media(items, kind):
    """Local files -> uploaded https URLs (copied now, so you can delete the originals)."""
    urls, keys = [], []
    tmp = tempfile.mkdtemp(prefix="pa-")
    try:
        for m in items:
            if m.startswith("https://"):
                urls.append(m)
                continue
            p = str(Path(m).expanduser())
            if not os.path.isfile(p):
                sys.exit(f"file not found: {m}")
            is_vid = Path(p).suffix.lower() in (".mp4", ".mov", ".m4v", ".webm", ".mkv")
            ready = prepare_video(p, tmp) if is_vid else prepare_image(p, tmp)
            key = f"uploads/{datetime.now():%Y%m%d}/{secrets.token_hex(4)}-{slug(ready)}"
            urls.append(r2_put(ready, key))
            keys.append(key)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return urls, keys


# ---------- automation flags ----------
def auto_flags(s, required):
    s.add_argument("--keyword", required=required, help='trigger word(s), comma-separated; "*" = any')
    s.add_argument("--on", help="triggers: comment,dm,story_reply,story_mention (default comment,dm)")
    s.add_argument("--thing", help='what you send, e.g. "PDF", "workflow" (used in the copy)')
    s.add_argument("--link", help="https link or a local file (PDF -> flipbook)")
    s.add_argument("--button", help='first DM button, max 20 chars (default "Send me the {thing}")')
    s.add_argument("--link-title", help='link button, max 20 chars (default "Open {thing}")')
    s.add_argument("--link-text", help="text above the link button")
    s.add_argument("--opener", help="first DM text")
    s.add_argument("--follow", action="store_true", help="only followers get the link")
    s.add_argument("--followup", help="follow-up when they did NOT open the link")
    s.add_argument("--review", help='follow-up when they DID open it (asks "how was it?")')
    s.add_argument("--no-followup", action="store_true")
    s.add_argument("--followup-mins", type=int, default=60)
    s.add_argument("--reply", action="append", help="custom public reply (repeatable)")
    s.add_argument("--name")


def auto_body(a):
    if not a.link:
        sys.exit("--link is required")
    link = a.link
    if not link.startswith("https://"):
        link, _ = upload_file(link)
        print(f"  file link: {link}")
    triggers = [t.strip() for t in (a.on or "comment,dm").split(",") if t.strip()]
    bad = [t for t in triggers if t not in TRIGGERS]
    if bad:
        sys.exit(f"unknown trigger {bad}; use {', '.join(TRIGGERS)}")
    kws = [k.strip().lower() for k in (a.keyword or "").split(",") if k.strip()]
    if not kws and not set(triggers) <= {"story_reply", "story_mention"}:
        sys.exit("--keyword is required for comment/DM triggers")
    for label, v in (("--button", a.button), ("--link-title", a.link_title)):
        if v and len(v) > 20:
            sys.exit(f"{label} is {len(v)} chars; Instagram buttons allow 20")
    first = (kws[0] if kws and kws[0] != "*" else triggers[0]).replace("_", "-")
    return {
        "name": a.name or f"{first}-{datetime.now():%m%d-%H%M}",
        "triggers": triggers, "keywords": kws, "thing": a.thing, "require_follow": a.follow,
        "opener_text": a.opener, "ask_button": a.button, "link_text": a.link_text, "link_title": a.link_title, "link_url": link,
        "followup": not a.no_followup, "followup_text": a.followup, "review_text": a.review, "followup_mins": a.followup_mins,
        "public_replies": a.reply,
    }


# ---------- commands ----------
def c_accounts(a):
    rows = call("GET", "accounts")
    if not rows:
        print("no accounts")
    for r in rows:
        exp = f"token {int((r['token_expires'] - datetime.now().timestamp()) / 86400)}d left" if r.get("token_expires") else ""
        print(f"@{r['username']:24} {r['status']:12} {exp}  {r.get('error') or ''}")


def c_connect(a):
    u = call("GET", "accounts/connect-url")["url"]
    print("Open this while logged into the Instagram account you want to connect (valid 1 hour):\n")
    print(u)


def c_account_status(status):
    def f(a):
        call("PATCH", f"accounts/{urllib.parse.quote(a.user)}", {"status": status}); print(f"@{a.user} {status}")
    return f


def c_auto_add(a):
    body = {**auto_body(a), "account": a.account, "post": a.post}
    r = call("POST", "rules", body)
    where = "every post" if r["media"]["id"] == "*" else (r["media"].get("permalink") or r["media"]["id"])
    print(f"✅ {body['name']} live on {where} · triggers: {', '.join(body['triggers'])} · keywords: {', '.join(body['keywords']) or 'any'}")
    for c in r.get("clashes", []):
        print(f"note: keyword also used by {c['name']} on another post")


def c_autos(a):
    rows = call("GET", "rules", account=a.account)
    if not rows:
        print("no automations")
    for r in rows:
        kws = ",".join(json.loads(r["keywords"]))
        trig = ",".join(json.loads(r["triggers"])) if r.get("triggers") else "comment,dm"
        where = "every post" if "*" in json.loads(r["media_ids"]) else (r.get("permalink") or r["media_ids"])
        flags = ("follow-gate " if r["require_follow"] else "") + (f"followup {r['followup_mins']}m" if r["followup_mins"] else "")
        print(f"{'●' if r['active'] else '○'} {r['name']:22} @{r['username']:16} {kws:14} {r['leads']:>4} leads {r['links']:>4} links  {flags}")
        print(f"    {trig} · {where} → {r['link_url']}")


def c_auto_state(method, active=None):
    def f(a):
        call(method, f"rules/{urllib.parse.quote(a.name)}", {"active": active} if method == "PATCH" else None, account=a.account)
        print("done")
    return f


def c_post_add(a):
    at = parse_at(a.at)
    if at.timestamp() < datetime.now(TZ).timestamp() - 300:
        sys.exit(f"{a.at}  is in the past")
    autodm = auto_body(a) if a.keyword else None
    media, keys = stage_media(a.media, a.type)
    cover, ckeys = (stage_media([a.cover], "image") if a.cover else ([None], []))
    body = {"account": a.account, "publish_at": int(at.timestamp()), "type": a.type, "media": media,
            "caption": a.caption or "", "cover": cover[0], "uploads": keys + ckeys}
    if autodm:
        body["autodm"] = autodm
    r = call("POST", "posts", body)
    print(f"queued {r['id']}: {a.type} at {at:%d %b %H:%M} " + (f" with auto-DM {a.keyword.upper()}" if a.keyword else ""))
    if keys:
        print("  your local files are uploaded; you can delete them now")


def c_posts(a):
    rows = call("GET", "posts")
    if not rows:
        print("no posts")
    for p in rows:
        auto = json.loads(p["autodm"])["keywords"] if p.get("autodm") else []
        print(f"{p['id']}  {fmt(p['publish_at'])}  @{p['username']:16} {p['type']:8} {p['status']:10} "
              f"{('auto:' + ','.join(auto)) if auto else '':14} {p.get('permalink') or (p.get('error') or '')[:70]}")


def c_post_edit(a):
    body = {}
    if a.caption is not None:
        body["caption"] = a.caption
    if a.at:
        body["publish_at"] = int(parse_at(a.at).timestamp())
    if a.cover:
        urls, keys = stage_media([a.cover], "image")
        body["cover"], body["add_uploads"] = urls[0], keys
    if not body:
        sys.exit("nothing to change (use --caption, --at and/or --cover)")
    print(call("PATCH", f"posts/{a.id}", body))


def c_calendar(a):
    r = call("GET", "calendar", days_back=a.back, days_ahead=a.ahead)
    icon = {"published": "✅", "pending": "🕒", "processing": "⏳", "failed": "❌", "posted": "✅"}
    day = None
    for p in r:
        d = datetime.fromtimestamp(p["ts"], TZ)
        if d.date() != day:
            day = d.date()
            print(f"\n{d:%a %d %b}")
        title = (p.get("caption") or "(no caption)").split("\n")[0][:60]
        auto = f"  auto-DM: {','.join(p['keywords'])}" if p.get("keywords") else ""
        src = "" if p["source"] == "scheduler" else "  (posted outside the scheduler)"
        print(f"  {d:%H:%M}  {icon.get(p['status'], '·')} {p['status']:10} {p.get('type') or '':8} @{p['username']:14} {title}{auto}{src}")
        if p.get("permalink"):
            print(f"         {p['permalink']}")
    if not r:
        print("nothing in this range")


def c_upload(a):
    link, _ = upload_file(a.file)
    print(link)


def c_stats(a):
    if a.refresh:
        print(f"refreshed {call('POST', 'stats/refresh', {})['refreshed']} posts")
    rows = call("GET", "stats", account=a.account, limit=a.n)
    if not rows:
        print("no stats yet (run with --refresh)")
    print(f"{'post':44} {'views':>7} {'reach':>7} {'likes':>6} {'cmts':>5} {'trig':>5} {'links':>5} {'opened':>7} {'loved':>5}")
    for p in rows:
        cap = (p.get("caption") or "(no caption)").split("\n")[0][:42]
        op = f"{p['clicked'] or 0}" + (f" {round(100 * (p['clicked'] or 0) / p['links'])}%" if p.get("links") else "")
        print(f"{cap:44} {p['views'] or '-':>7} {p['reach'] or '-':>7} {p['likes'] or '-':>6} {p['comments'] or '-':>5} "
              f"{p['triggered'] or 0:>5} {p['links'] or 0:>5} {op:>7} {p['loved'] or 0:>5}")


def c_leads(a):
    for l in call("GET", "leads", limit=a.n):
        extra = (f" opened×{l['clicks']}" if l.get("clicks") else "") + (f" [{l['feedback']}]" if l.get("feedback") else "")
        print(f"{fmt(l['updated'])}  @{l['account']:14} {l['rule']:18} {('@' + l['username']) if l.get('username') else '-':20} {l['stage']:12}{extra}  {(l.get('comment_text') or '')[:30]!r}")


def c_log(a):
    for e in reversed(call("GET", "events", limit=a.n)):
        print(f"{fmt(e['ts'])}  {e['level']:5} {('@' + e['username']) if e.get('username') else '':16} {e['msg']}")


def c_queue(a):
    rows = call("GET", "outbox")
    print(f"{len(rows)} queued" if rows else "queue empty")
    for o in rows:
        print(f"  {fmt(o['created'])} → retry {fmt(o['next_try'])}  {o['kind']:5} {o.get('label') or ''}")


def c_events(a):
    r = call("GET", "webhook-events")
    print("webhook events: " + (", ".join(f"{x['status']} {x['n']}" for x in r["counts"]) or "none yet"))
    for e in r["problems"]:
        print(f"  #{e['id']} {fmt(e['received'])} {e['status']:10} tries {e['attempts']}  {(e.get('error') or '').splitlines()[0][:90] if e.get('error') else ''}")
    if a.retry:
        print(call("POST", f"webhook-events/{a.retry}/retry", {}))


def c_alert_test(a):
    print(call("POST", "alerts/summary" if a.summary else "alerts/test", {}))


def c_quota(a):
    q = call("GET", "quota", account=a.account)
    print(f"@{q['username']}: {q['quota_usage']}/{q['config']['quota_total']} API posts in the last 24h")


def c_import(a):
    print(call("POST", "accounts/import", {"token": env()["IG_ACCESS_TOKEN"]}))


# ---------- YouTube ----------
def yt_link(link):
    if not link:
        return None
    if link.startswith("https://"):
        return link
    url, _ = upload_file(link)
    print(f"  file link: {url}")
    return url


def c_yt_connect(a):
    print("Open this while signed into the Google account that owns the channel (valid 1 hour):\n")
    print(call("GET", "yt/connect-url")["url"])
    print("\nGoogle will warn that the app is unverified: click Advanced → Go to Automation (it's your own app).")


def c_yt_accounts(a):
    r = call("GET", "yt/accounts")
    for x in r["accounts"]:
        print(f"▶ {x['title']:30} {x.get('handle') or '':20} {x['status']}  {x.get('error') or ''}")
    if not r["accounts"]:
        print("no YouTube channel connected (./pa.py yt-connect)")
    print(f"API quota used today: {r['quota_used_today']:,} / {r['quota_limit']:,} (resets midnight Pacific = 13:30 )")


def yt_rule_body(a):
    kws = [k.strip().lower() for k in a.keyword.split(",") if k.strip()]
    if a.mode != "description" and not a.link:
        sys.exit("--link is required (or --mode description to point people at the description)")
    return {"name": a.name or f"yt-{kws[0]}-{datetime.now(TZ):%m%d-%H%M}", "keywords": kws, "link_url": yt_link(a.link),
            "replies": a.reply, "mode": a.mode}


def c_yt_auto_add(a):
    body = {**yt_rule_body(a), "channel": a.channel, "video": a.video}
    r = call("POST", "yt/rules", body)
    print(f"✅ {body['name']} live on {'every video' if r['video'] == '*' else 'https://youtu.be/' + r['video']} for {', '.join(body['keywords'])}")
    print("   (comments are checked every 3 minutes; each reply uses 50 of your 10,000 daily API units)")


def c_yt_autos(a):
    rows = call("GET", "yt/rules")
    if not rows:
        print("no YouTube automations")
    for r in rows:
        vids = json.loads(r["video_ids"])
        print(f"{'●' if r['active'] else '○'} {r['name']:24} {','.join(json.loads(r['keywords'])):12} {r['replied']:>4} replied {r['failed']:>3} failed  "
              f"{'every video' if '*' in vids else ' '.join('https://youtu.be/' + v for v in vids)}")
        print(f"    {'points to description' if r['mode'] == 'description' else r.get('link_url') or ''}")


def c_yt_replies(a):
    for x in call("GET", "yt/replies", limit=a.n):
        print(f"{fmt(x['created'])}  {x['status']:13} {x.get('rule') or '':20} {x['author'][:22]:22} {x['text'][:50]!r}  {x.get('error') or ''}")


def c_yt_post_add(a):
    at = parse_at(a.at)
    p = Path(a.media).expanduser()
    if not p.is_file():
        sys.exit(f"file not found: {p}")
    desc = Path(a.description_file).expanduser().read_text() if a.description_file else (a.description or "")
    link_url = yt_link(a.link) if a.link else None
    if link_url:   # the link goes on the first line of the description (visible above "...more")
        desc = f"🔗 {a.link_label}: {link_url}\n\n{desc}".rstrip()
    if a.auto_reply and not (a.keyword and link_url or a.keyword and a.mode == "description"):
        sys.exit("--auto-reply needs --keyword (and --link)")
    if len(a.title) > 100:
        sys.exit(f"title is {len(a.title)} chars; YouTube allows 100")
    key = f"uploads/yt/{datetime.now():%Y%m%d}/{secrets.token_hex(4)}-{slug(p.name)}"
    r2_put(str(p), key)   # original file: YouTube does its own encoding, so no quality is lost here
    thumb_key = None
    if a.thumb:
        tmp = tempfile.mkdtemp(prefix="yt-")
        try:
            t = Path(a.thumb).expanduser()
            out = os.path.join(tmp, "thumb.jpg")
            # YouTube thumbnails: JPEG/PNG, max 2 MB; 1280x720 recommended for videos
            q = 2
            while True:
                subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(t), "-vf", "scale='min(1280,iw)':-2:flags=lanczos", "-q:v", str(q), out], check=True)
                if os.path.getsize(out) <= 2 * 1024 * 1024 or q >= 10:
                    break
                q += 2
            thumb_key = f"uploads/yt/{datetime.now():%Y%m%d}/{secrets.token_hex(4)}-thumb.jpg"
            r2_put(out, thumb_key)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    body = {"channel": a.channel, "title": a.title, "description": desc, "tags": [x.strip() for x in (a.tags or "").split(",") if x.strip()],
            "media_key": key, "thumb_key": thumb_key, "publish_at": int(at.timestamp())}
    if a.auto_reply:   # optional: also reply to keyword comments (50 quota units per reply)
        kws = [k.strip().lower() for k in a.keyword.split(",") if k.strip()]
        body["autoreply"] = {"name": a.name or f"yt-{kws[0]}-{datetime.now(TZ):%m%d-%H%M}", "keywords": kws, "link_url": link_url,
                             "replies": a.reply, "mode": a.mode}
    r = call("POST", "yt/videos", body)
    print(f"queued {r['id']}: \"{a.title}\" goes public {at:%d %b %H:%M} " + (" · link in description" if link_url else "") + (f" · auto-reply {a.keyword.upper()}" if a.auto_reply else ""))
    print("  it uploads to YouTube within a minute as private, and YouTube publishes it at that time")


def c_yt_link(a):
    url = yt_link(a.link)
    r = call("POST", "yt/describe", {"channel": a.channel, "video": a.video, "line": f"🔗 {a.label}: {url}"})
    print(("✅ added to the description of " if r.get("changed") else "already in the description of ") + f"https://youtu.be/{r['video']}")


def c_yt_posts(a):
    rows = call("GET", "yt/videos")
    if not rows:
        print("no YouTube uploads")
    for v in rows:
        print(f"{v['id']}  {fmt(v['publish_at'])}  {v['status']:10} {v['title'][:50]:50} {'https://youtu.be/' + v['video_id'] if v.get('video_id') else ''}  {(v.get('error') or '')[:80]}")


def c_yt_stats(a):
    if a.refresh:
        print(f"refreshed {call('POST', 'yt/stats/refresh', {})['refreshed']} videos")
    rows = call("GET", "yt/stats", limit=a.n)
    print(f"{'video':52} {'views':>8} {'likes':>6} {'cmts':>5} {'mins':>6} {'replies':>7}")
    for s in rows:
        print(f"{('[S] ' if s['is_short'] else '') + (s['title'] or '')[:48]:52} {s['views'] or 0:>8} {s['likes'] or 0:>6} {s['comments'] or 0:>5} {s['minutes'] or '-':>6} {s['replies'] or 0:>7}")


# ---------- LinkedIn (personal profile) ----------
def c_li_connect(a):
    print("Open this while signed into LinkedIn (valid 1 hour):\n")
    print(call("GET", "li/connect-url")["url"])


def c_li_accounts(a):
    for x in call("GET", "li/accounts"):
        print(f"in {x['name']:28} {x.get('email') or '':30} {x['status']}  sign-in expires {fmt(x['expires'])}   {x.get('error') or ''}")


def c_li_post_add(a):
    at = parse_at(a.at)
    text = Path(a.text_file).expanduser().read_text().strip() if a.text_file else (a.text or "")
    if not text:
        sys.exit("--text or --text-file is required")
    files = [Path(m).expanduser() for m in (a.media or [])]
    for f in files:
        if not f.is_file():
            sys.exit(f"file not found: {f}")
    exts = {f.suffix.lower() for f in files}
    if not files:
        kind = "text"
    elif exts <= {".pdf"} and len(files) == 1:
        kind = "document"
    elif exts <= {".mp4", ".mov", ".m4v"} and len(files) == 1:
        kind = "video"
    elif exts <= {".jpg", ".jpeg", ".png", ".gif"}:
        kind = "image" if len(files) == 1 else "images"
    else:
        sys.exit("media must be: 1 PDF (carousel), 1 video, or 1-20 images")
    media = []
    tmp = tempfile.mkdtemp(prefix="li-")
    try:
        for f in files:
            src = str(f)
            if kind == "document":
                src = compress_pdf(src, tmp)
            key = f"uploads/li/{datetime.now():%Y%m%d}/{secrets.token_hex(4)}-{slug(f.name)}"
            r2_put(src, key)
            typ = {".pdf": "application/pdf", ".mp4": "video/mp4", ".mov": "video/quicktime", ".m4v": "video/mp4", ".png": "image/png", ".gif": "image/gif"}.get(f.suffix.lower(), "image/jpeg")
            media.append({"key": key, "size": os.path.getsize(src), "type": typ, "title": a.title or f.stem.replace("-", " ").replace("_", " ")})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    r = call("POST", "li/posts", {"account": a.account, "text": text, "kind": kind, "media": media, "publish_at": int(at.timestamp())})
    print(f"queued {r['id']}: LinkedIn {kind} post at {at:%d %b %H:%M} ")


def c_li_posts(a):
    rows = call("GET", "li/posts")
    if not rows:
        print("no LinkedIn posts")
    for p in rows:
        print(f"{p['id']}  {fmt(p['publish_at'])}  {p['kind']:8} {p['status']:10} {p['text'].splitlines()[0][:50]:50} {p.get('permalink') or (p.get('error') or '')[:80]}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sp = ap.add_subparsers(dest="cmd", required=True)
    sp.add_parser("accounts").set_defaults(f=c_accounts)
    sp.add_parser("connect").set_defaults(f=c_connect)
    sp.add_parser("import-env-token", help="connect the account whose token is in .env").set_defaults(f=c_import)
    for n, st in (("pause-account", "paused"), ("resume-account", "active")):
        s = sp.add_parser(n); s.add_argument("user"); s.set_defaults(f=c_account_status(st))

    s = sp.add_parser("auto-add"); s.add_argument("--account"); s.add_argument("--post", help='post link, "any", or omit for story/DM-only')
    auto_flags(s, False); s.set_defaults(f=c_auto_add)
    s = sp.add_parser("autos"); s.add_argument("--account"); s.set_defaults(f=c_autos)
    for n, fn in (("auto-pause", c_auto_state("PATCH", False)), ("auto-resume", c_auto_state("PATCH", True)), ("auto-rm", c_auto_state("DELETE"))):
        s = sp.add_parser(n); s.add_argument("name"); s.add_argument("--account"); s.set_defaults(f=fn)

    s = sp.add_parser("post-add", aliases=["add"])
    s.add_argument("--account"); s.add_argument("--at", required=True)
    s.add_argument("--type", required=True, choices=["image", "reel", "carousel", "story"])
    s.add_argument("--media", nargs="+", required=True, help="local files or https URLs"); s.add_argument("--caption"); s.add_argument("--cover")
    auto_flags(s, False); s.set_defaults(f=c_post_add)
    sp.add_parser("posts").set_defaults(f=c_posts)
    s = sp.add_parser("post-edit", help="change caption/time of a scheduled post"); s.add_argument("id"); s.add_argument("--caption"); s.add_argument("--at"); s.add_argument("--cover", help="cover image (local file or https URL)"); s.set_defaults(f=c_post_edit)
    s = sp.add_parser("calendar", help="what's been posted and what's coming up"); s.add_argument("--back", type=int, default=7); s.add_argument("--ahead", type=int, default=21); s.set_defaults(f=c_calendar)
    s = sp.add_parser("post-rm"); s.add_argument("id"); s.set_defaults(f=lambda a: print(call("DELETE", f"posts/{a.id}")))
    s = sp.add_parser("post-now"); s.add_argument("id"); s.set_defaults(f=lambda a: print(call("POST", f"posts/{a.id}/now", {})))

    s = sp.add_parser("upload"); s.add_argument("file"); s.set_defaults(f=c_upload)
    s = sp.add_parser("stats"); s.add_argument("--refresh", action="store_true"); s.add_argument("--account"); s.add_argument("-n", type=int, default=20); s.set_defaults(f=c_stats)
    s = sp.add_parser("leads"); s.add_argument("-n", type=int, default=30); s.set_defaults(f=c_leads)
    s = sp.add_parser("log"); s.add_argument("-n", type=int, default=30); s.set_defaults(f=c_log)
    sp.add_parser("queue").set_defaults(f=c_queue)
    s = sp.add_parser("events", help="stored webhook events, failures and retries"); s.add_argument("--retry", type=int, help="re-run event ID"); s.set_defaults(f=c_events)
    s = sp.add_parser("alert-test", help="send a test alert email (or --summary for the daily summary)"); s.add_argument("--summary", action="store_true"); s.set_defaults(f=c_alert_test)
    s = sp.add_parser("quota"); s.add_argument("--account"); s.set_defaults(f=c_quota)
    # YouTube
    sp.add_parser("yt-connect", help="link to connect a YouTube channel").set_defaults(f=c_yt_connect)
    sp.add_parser("yt-accounts").set_defaults(f=c_yt_accounts)
    def yt_rule_flags(s, required=True):
        s.add_argument("--keyword", required=required); s.add_argument("--link", help="https link or local file (PDF -> flipbook)")
        s.add_argument("--reply", action="append", help="custom reply template, {name} and {link} (repeatable)")
        s.add_argument("--mode", choices=["link", "description"], default="link"); s.add_argument("--name"); s.add_argument("--channel")
    s = sp.add_parser("yt-auto-add", help="auto-reply to YouTube comments with a keyword"); s.add_argument("--video", default="any", help='video URL/id or "any"'); yt_rule_flags(s); s.set_defaults(f=c_yt_auto_add)
    sp.add_parser("yt-autos").set_defaults(f=c_yt_autos)
    for n, fn in (("yt-auto-pause", lambda a: print(call("PATCH", f"yt/rules/{urllib.parse.quote(a.name)}", {"active": False}))),
                  ("yt-auto-resume", lambda a: print(call("PATCH", f"yt/rules/{urllib.parse.quote(a.name)}", {"active": True}))),
                  ("yt-auto-rm", lambda a: print(call("DELETE", f"yt/rules/{urllib.parse.quote(a.name)}")))):
        s = sp.add_parser(n); s.add_argument("name"); s.set_defaults(f=fn)
    s = sp.add_parser("yt-replies"); s.add_argument("-n", type=int, default=30); s.set_defaults(f=c_yt_replies)
    sp.add_parser("yt-poll", help="check YouTube comments now").set_defaults(f=lambda a: print(call("POST", "yt/poll-now", {})))
    s = sp.add_parser("yt-post-add", help="schedule a YouTube video/Short (YouTube publishes it at --at)")
    s.add_argument("--at", required=True); s.add_argument("--media", required=True); s.add_argument("--title", required=True)
    s.add_argument("--description"); s.add_argument("--description-file"); s.add_argument("--tags"); s.add_argument("--thumb")
    yt_rule_flags(s, required=False)
    s.add_argument("--link-label", default="Get the free guide", help="text before the link on the description's first line")
    s.add_argument("--auto-reply", action="store_true", help="also auto-reply to --keyword comments (off by default: 50 quota units each)")
    s.set_defaults(f=c_yt_post_add)
    s = sp.add_parser("yt-link", help="put a link on the first line of an existing video's description")
    s.add_argument("video", help="video URL or id"); s.add_argument("--link", required=True); s.add_argument("--label", default="Get the free guide"); s.add_argument("--channel")
    s.set_defaults(f=c_yt_link)
    sp.add_parser("yt-posts").set_defaults(f=c_yt_posts)
    s = sp.add_parser("yt-post-rm"); s.add_argument("id"); s.set_defaults(f=lambda a: print(call("DELETE", f"yt/videos/{a.id}")))
    s = sp.add_parser("yt-stats"); s.add_argument("--refresh", action="store_true"); s.add_argument("-n", type=int, default=20); s.set_defaults(f=c_yt_stats)
    # LinkedIn
    sp.add_parser("li-connect", help="link to connect your LinkedIn profile (renew every 60 days)").set_defaults(f=c_li_connect)
    sp.add_parser("li-accounts").set_defaults(f=c_li_accounts)
    s = sp.add_parser("li-post-add", help="schedule a LinkedIn post (text, image(s), video or PDF carousel)")
    s.add_argument("--at", required=True); s.add_argument("--text"); s.add_argument("--text-file")
    s.add_argument("--media", nargs="+", help="1 PDF (carousel) | 1 video | 1-20 images"); s.add_argument("--title", help="title for a PDF/video")
    s.add_argument("--account"); s.set_defaults(f=c_li_post_add)
    sp.add_parser("li-posts").set_defaults(f=c_li_posts)
    s = sp.add_parser("li-post-edit"); s.add_argument("id"); s.add_argument("--text"); s.add_argument("--text-file"); s.add_argument("--at")
    s.set_defaults(f=lambda a: print(call("PATCH", f"li/posts/{a.id}", {k: v for k, v in {"text": Path(a.text_file).expanduser().read_text().strip() if a.text_file else a.text, "publish_at": int(parse_at(a.at).timestamp()) if a.at else None}.items() if v})))
    s = sp.add_parser("li-post-now"); s.add_argument("id"); s.set_defaults(f=lambda a: print(call("PATCH", f"li/posts/{a.id}", {"publish_at": int(datetime.now(TZ).timestamp())})))
    s = sp.add_parser("li-post-rm"); s.add_argument("id"); s.set_defaults(f=lambda a: print(call("DELETE", f"li/posts/{a.id}")))
    sp.add_parser("dashboard").set_defaults(f=lambda a: print(f"{WORKER}/  (password: VIEW_PASSWORD in .env)"))
    a = ap.parse_args(); a.f(a)


if __name__ == "__main__":
    main()
