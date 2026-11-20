// Files in R2 (bucket personal-automation-media), uploaded by pa.py:
//   uploads/...  scheduled-post media, deleted after the post publishes
//   files/...    PDFs / downloads you share in DMs, kept
// GET /m/<key>  raw file (Range support, so Instagram can fetch large videos)
// GET /f/<key>  PDF flipbook viewer

const TYPES = { mp4: "video/mp4", mov: "video/quicktime", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", pdf: "application/pdf" };
const typeOf = (key) => TYPES[key.split(".").pop().toLowerCase()] || "application/octet-stream";

export async function serveMedia(req, env, key) {
  const range = req.headers.get("range");
  const head = await env.MEDIA.head(key);
  if (!head) return new Response("not found", { status: 404 });
  const size = head.size;
  const base = { "content-type": head.httpMetadata?.contentType || typeOf(key), "accept-ranges": "bytes", "cache-control": key.startsWith("files/") && !new URL(req.url).searchParams.get("v") ? "public, max-age=300" : "public, max-age=31536000, immutable", etag: head.httpEtag };

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (m && !m[1] && m[2]) { start = size - Number(m[2]); end = size - 1; }
    if (start >= size || end >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const obj = await env.MEDIA.get(key, { range: { offset: start, length: end - start + 1 } });
    return new Response(obj.body, { status: 206, headers: { ...base, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
  }
  if (req.method === "HEAD") return new Response(null, { headers: { ...base, "content-length": String(size) } });
  const obj = await env.MEDIA.get(key);
  return new Response(obj.body, { headers: { ...base, "content-length": String(size) } });
}

export function flipbookPage(key, title, version = "") {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // versioned URL: replacing the file (same link) never serves a stale cached copy
  const src = `/m/${key.split("/").map(encodeURIComponent).join("/")}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
<style>
:root{--bg:#00222b;--ink:#E6FBFF;--dim:#8fb5bd;--accent:#00F5FF;--btn:#0b3b47}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);font:15px/1.4 system-ui,-apple-system,sans-serif;-webkit-tap-highlight-color:transparent}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px}
h1{font-size:16px;font-weight:600;margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
a.dl{color:var(--bg);background:var(--accent);padding:8px 14px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px;white-space:nowrap}
#stage{display:flex;align-items:center;justify-content:center;padding:4px 12px 8px;height:calc(100% - 130px)}
#book{margin:0 auto}
.page{background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.35)}
.page img{width:100%;height:100%;object-fit:contain;display:block;background:#fff}
footer{display:flex;align-items:center;justify-content:center;gap:14px;padding:10px 16px calc(14px + env(safe-area-inset-bottom))}
footer button{background:var(--btn);color:var(--ink);border:0;border-radius:999px;width:44px;height:44px;font-size:20px;cursor:pointer}
footer button:disabled{opacity:.35}
#count{color:var(--dim);min-width:80px;text-align:center;font-variant-numeric:tabular-nums}
#loading{position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--bg);color:var(--dim)}
#bar{width:180px;height:4px;background:var(--btn);border-radius:4px;overflow:hidden}#bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .2s}
#err{display:none;text-align:center;padding:40px 16px}
</style></head><body>
<header><h1>${esc(title)}</h1><a class="dl" href="${src}" download>Download</a></header>
<div id="stage"><div id="book"></div></div>
<footer><button id="prev" aria-label="Previous page">‹</button><span id="count"></span><button id="next" aria-label="Next page">›</button></footer>
<div id="loading"><div>Opening…</div><div id="bar"><i></i></div></div>
<div id="err">Couldn't open this file. <a class="dl" href="${src}">Open the PDF</a></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/page-flip@2.0.7/dist/js/page-flip.browser.js"></script>
<script>
(async () => {
  const bar = document.querySelector("#bar i");
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument(${JSON.stringify(src)}).promise;
    const first = await pdf.getPage(1);
    const vp1 = first.getViewport({ scale: 1 });
    const ratio = vp1.height / vp1.width;
    const stage = document.getElementById("stage");
    const mobile = innerWidth < 760;
    const availW = stage.clientWidth - 24, availH = stage.clientHeight;
    let w = mobile ? availW : availW / 2;
    if (w * ratio > availH) w = availH / ratio;
    w = Math.floor(w); const h = Math.floor(w * ratio);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const imgs = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = i === 1 ? first : await pdf.getPage(i);
      const vp = page.getViewport({ scale: (w * dpr) / page.getViewport({ scale: 1 }).width });
      const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
      imgs.push(c.toDataURL("image/jpeg", 0.88));
      bar.style.width = Math.round((100 * i) / pdf.numPages) + "%";
    }
    // two-page spreads: an odd page count would leave a blank white page at the end, so fill that slot with background colour
    if (!mobile && pdf.numPages % 2) {
      const c = document.createElement("canvas"); c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      const x = c.getContext("2d"), W = c.width, H = c.height;
      x.fillStyle = getComputedStyle(document.body).backgroundColor || "#00222b"; x.fillRect(0, 0, W, H); // invisible filler, blends into the background
      imgs.push(c.toDataURL("image/jpeg", 0.92));
    }
    const book = new St.PageFlip(document.getElementById("book"), {
      width: w, height: h, size: "fixed", showCover: false, usePortrait: true,
      maxShadowOpacity: 0.4, mobileScrollSupport: false, flippingTime: 700,
    });
    book.loadFromImages(imgs);
    const count = document.getElementById("count"), prev = document.getElementById("prev"), next = document.getElementById("next");
    const last = imgs.length - 1;
    const upd = () => { const i = book.getCurrentPageIndex(); count.textContent = Math.min(i + 1, pdf.numPages) + " / " + pdf.numPages; prev.disabled = i === 0; next.disabled = i >= last - (mobile ? 0 : 1); };
    book.on("flip", upd); upd();
    prev.onclick = () => book.flipPrev(); next.onclick = () => book.flipNext();
    addEventListener("keydown", (e) => { if (e.key === "ArrowLeft") book.flipPrev(); if (e.key === "ArrowRight") book.flipNext(); });
    document.getElementById("loading").remove();
  } catch (e) {
    console.error(e);
    document.getElementById("loading").remove();
    document.getElementById("err").style.display = "block";
  }
})();
</script></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" } });
}
