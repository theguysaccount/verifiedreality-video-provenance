"""Build the Existed By static site into dist/. Standard library only (Python 3.9+).

    python3 pipeline/build.py [--out dist]

Pages are HTML fragments in site/pages/ that start with a JSON block in an HTML comment (path, title,
description, ...). This script wraps each in the shared layout and writes the sitemap, robots.txt,
the IndexNow key file, 404.html, build.json and urls.txt.

Optional environment (GitHub repository variables in CI; see OPERATIONS.md):
    SITE_URL          canonical origin + path, no trailing slash (default: the GitHub Pages URL)
    GOATCOUNTER_URL   e.g. https://existedby.goatcounter.com/count -> cookieless page counts on
    NEWSROOM_URL      link to a paid newsroom/API offer on other hosting -> money slot shown
    BUILD_DATE        YYYY-MM-DD, to reproduce a build
    GITHUB_SHA        recorded in build.json so health checks can tell which commit is live
"""
import argparse
import base64
import datetime as dt
import hashlib
import html
import json
import os
import re
import shutil
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SITE_URL = "https://theguysaccount.github.io/verifiedreality-video-provenance"
REPO_URL = "https://github.com/theguysaccount/verifiedreality-video-provenance"
BRAND = "Existed By"
THEME = "#b7791f"
INDEXNOW_KEY = (ROOT / "site" / "indexnow-key.txt").read_text().strip()
NAV = [("", "Stamp"), ("check/", "Check a proof"), ("guides/", "Guides"), ("how-it-works/", "How it works")]
FOOT = [("", "Stamp a video"), ("check/", "Check a proof"), ("guides/", "Guides"), ("how-it-works/", "How it works and its limits")]
# Every host a page may contact: the calendars that take new digests, the calendars that finish
# pending proofs, and the block explorers that supply block headers. Nothing else.
CONNECT = ["https://a.pool.opentimestamps.org", "https://b.pool.opentimestamps.org", "https://a.pool.eternitywall.com",
           "https://alice.btc.calendar.opentimestamps.org", "https://bob.btc.calendar.opentimestamps.org",
           "https://finney.calendar.eternitywall.com", "https://btc.calendar.catallaxy.com",
           "https://blockstream.info", "https://mempool.space"]
e = html.escape


def attr(s):
    return html.escape(str(s), quote=True)


def read_page(path):
    """Split a page file into its JSON front matter and its HTML body."""
    text = path.read_text(encoding="utf-8")
    m = re.match(r"\s*<!--\s*(\{.*?\})\s*-->\s*", text, re.S)
    if not m:
        raise SystemExit(f"{path}: missing the JSON block at the top")
    meta = json.loads(m.group(1))
    meta["source"] = path.name
    return meta, text[m.end():]


class Site:
    def __init__(self, out, today):
        self.out, self.today = Path(out), today
        self.site_url = os.environ.get("SITE_URL", "").strip().rstrip("/") or DEFAULT_SITE_URL
        self.goatcounter = os.environ.get("GOATCOUNTER_URL", "").strip()
        self.newsroom = os.environ.get("NEWSROOM_URL", "").strip()
        move = os.environ.get("MOVE_NOTICE_URL", "").strip()
        if move and not re.match(r'^https://[a-z0-9.-]+\.[a-z]{2,}(/[^\s"<>]*)?$', move, re.I):
            raise SystemExit(f"MOVE_NOTICE_URL must be an https address, got {move!r}")
        self.move_notice = move
        self.commit = os.environ.get("GITHUB_SHA", "").strip() or "local"
        h = hashlib.sha1()
        for p in sorted((ROOT / "site").rglob("*")):
            if p.is_file():
                h.update(p.relative_to(ROOT).as_posix().encode() + b"\0" + p.read_bytes())
        self.ver = h.hexdigest()[:10]
        self.pages = [read_page(p) for p in sorted((ROOT / "site" / "pages").glob("*.html"))]
        self.indexable = []

    # ----- helpers -----
    def move_banner(self):
        """Shown on every page while MOVE_NOTICE_URL is set, a few weeks before a domain move."""
        if not self.move_notice:
            return ""
        url = attr(self.move_notice)
        return '<aside class="move-notice" role="note"><p>' + 'Existed By is moving to <a href="{url}">{url}</a>. The list of stamps on the home page is kept in your browser for this address only. Use “Export my list” there (or download each proof), then import the list at the new address. Proofs and check links you already have keep working.'.replace("{url}", url) + '</p></aside>\n'

    def sample_proof(self):
        return (ROOT / "site" / "data" / "sample-clip.webm.ots").read_bytes()

    def sample_digest(self):
        ots = self.sample_proof()
        return ots[33:65]  # magic (31 bytes), version 1 (1), sha256 op (1), then the 32-byte digest

    def sample_fragment(self):
        p = base64.urlsafe_b64encode(self.sample_proof()).decode().rstrip("=")
        size = (ROOT / "site" / "data" / "sample-clip.webm").stat().st_size
        return f"v=1&h={self.sample_digest().hex()}&p={p}&n=sample-clip.webm&s={size}"

    def url(self, path):
        return f"{self.site_url}/{path}"

    def write(self, path, text):
        f = self.out / path
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")

    def csp(self):
        """Pages load only their own files, and may contact only the calendars and block explorers."""
        script, connect, img = "'self'", " ".join(CONNECT), "'self' data:"
        if self.goatcounter:
            origin = "{0.scheme}://{0.netloc}".format(urlparse(self.goatcounter))
            script += " https://gc.zgo.at"
            connect += " " + origin
            img += " " + origin
        return (f"default-src 'none'; script-src {script}; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src {img}; "
                f"media-src 'self' blob:; connect-src {connect}; form-action 'none'; base-uri 'none'")

    def privacy_line(self):
        if self.goatcounter:
            return ("Page visits are counted with GoatCounter (no cookies, no personal data). "
                    "Your files are fingerprinted on your device and never uploaded.")
        return "No accounts, no cookies, no analytics. Your files are fingerprinted on your device and never uploaded."

    def fill(self, text, root, extra=None):
        values = {"root": root, "site_url": self.site_url, "repo_url": REPO_URL, "brand": BRAND,
                  "check_url": self.url("check/"), "privacy_line": self.privacy_line(), "csp": e(self.csp()),
                  "sample_link": e(f"{root}check/#{self.sample_fragment()}"), "sample_hash": self.sample_digest().hex(),
                  "sample_size": f"{(ROOT / 'site' / 'data' / 'sample-clip.webm').stat().st_size:,}"}
        values.update(extra or {})
        out = re.sub(r"\{\{(\w+)\}\}", lambda m: str(values[m.group(1)]) if m.group(1) in values else m.group(0), text)
        left = re.findall(r"\{\{\w+\}\}", out)
        if left:
            raise SystemExit(f"unfilled placeholders: {sorted(set(left))}")
        return out

    def layout(self, meta, body):
        path = meta["path"]
        if path == "404.html":
            after = self.site_url.split("://", 1)[1]
            root = "/" + after.split("/", 1)[1] + "/" if "/" in after else "/"
        else:
            root = "../" * path.count("/") or "./"
        here = ' aria-current="page"'
        current = meta.get("nav")
        nav = "".join(f'<a href="{root}{p}"{here if p == current else ""}>{e(t)}</a>' for p, t in NAV)
        foot = "".join(f'<a href="{root}{p}">{e(t)}</a>' for p, t in FOOT)
        extra = {}
        faq = meta.get("faq")
        if faq:
            extra["faq_html"] = '<div class="faq">' + "".join(
                f"<details><summary>{e(q)}</summary><p>{e(a)}</p></details>" for q, a in faq) + "</div>"
        extra["money_slot"] = (
            '<section class="card money"><h2>For newsrooms</h2><p>Stamping footage in bulk, or from your own systems? '
            f'<a href="{attr(self.newsroom)}" rel="noopener">See the newsroom version</a></p></section>'
            if self.newsroom else "")
        body = self.fill(body, root, extra)
        ld = ""
        for block in meta.get("jsonld", []):
            if faq and block.get("@type") == "FAQPage":
                block = dict(block, mainEntity=[{"@type": "Question", "name": q, "acceptedAnswer": {"@type": "Answer", "text": a}}
                                                for q, a in faq])
            text = self.fill(json.dumps(block, ensure_ascii=False), root, {"date": self.today.isoformat()})
            ld += '<script type="application/ld+json">%s</script>\n' % text.replace("</", "<\\/")
        cfg = json.dumps({"root": root, "siteUrl": self.site_url})
        scripts = f'<script type="application/json" id="site-config">{cfg}</script>\n' + "".join(
            f'<script type="module" src="{root}assets/{name}?v={self.ver}"></script>\n' for name in meta.get("scripts", []))
        gc = (f'<script data-goatcounter="{attr(self.goatcounter)}" async src="https://gc.zgo.at/count.js"></script>\n'
              if self.goatcounter else "")
        title, description = meta["title"], meta["description"]
        canonical = self.url("" if path == "404.html" else path)
        robots = '<meta name="robots" content="noindex">\n' if meta.get("noindex") else ""
        return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="{attr(self.csp())}">
<meta name="referrer" content="no-referrer">
<title>{e(title)}</title>
<meta name="description" content="{attr(description)}">
<link rel="canonical" href="{canonical}">
{robots}<meta property="og:type" content="website">
<meta property="og:site_name" content="{BRAND}">
<meta property="og:title" content="{attr(title)}">
<meta property="og:description" content="{attr(description)}">
<meta property="og:url" content="{canonical}">
<meta property="og:image" content="{self.site_url}/assets/og/{meta.get('og', 'home')}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="{THEME}">
<link rel="icon" href="{root}favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="{root}assets/site.css?v={self.ver}">
{ld}{scripts}{gc}</head>
<body class="{attr(meta.get('body_class', 'doc'))}">
<a class="skip" href="#main">Skip to content</a>
<header class="site-head"><div class="wrap">
<a class="logo" href="{root}"><span class="mark" aria-hidden="true"></span>{BRAND}</a>
<nav class="nav" aria-label="Main">{nav}</nav>
</div></header>
<main id="main" class="wrap">
{self.move_banner()}{body}
</main>
<footer class="site-foot"><div class="wrap">
<nav aria-label="Footer">{foot}<a href="{REPO_URL}">Source code</a></nav>
<p>A timestamp proves a file existed by a date. It doesn't prove what the file shows is true.</p>
<p>{e(self.privacy_line())}</p>
</div></footer>
</body>
</html>
"""

    # ----- outputs -----
    def assets(self):
        shutil.copytree(ROOT / "site" / "assets", self.out / "assets")
        shutil.copy(ROOT / "site" / "favicon.svg", self.out / "favicon.svg")
        (self.out / "sample").mkdir(parents=True, exist_ok=True)
        for name in ("sample-clip.webm", "sample-clip.webm.ots"):
            shutil.copy(ROOT / "site" / "data" / name, self.out / "sample" / name)
        # Every import carries the build version, so a returning visitor never mixes old and new files.
        for f in (self.out / "assets").glob("*.js"):
            src = f.read_text(encoding="utf-8")
            src = re.sub(r'(from\s+"\./[\w.-]+\.js)"', rf'\1?v={self.ver}"', src)
            src = re.sub(r'(import\(\s*"\./[\w.-]+\.js)"', rf'\1?v={self.ver}"', src)
            src = re.sub(r'(new URL\(\s*"\./[\w.-]+\.js)"', rf'\1?v={self.ver}"', src)
            f.write_text(src, encoding="utf-8")

    def build(self):
        if self.out.exists():
            shutil.rmtree(self.out)
        self.out.mkdir(parents=True)
        self.assets()
        for meta, body in self.pages:
            path = meta["path"]
            target = path if path.endswith(".html") else path + "index.html"
            self.write(target, self.layout(meta, body))
            if not meta.get("noindex") and path != "404.html":
                self.indexable.append(path)
        lastmod = self.today.isoformat()
        urls = "".join(f"<url><loc>{self.url(p)}</loc><lastmod>{lastmod}</lastmod></url>\n" for p in self.indexable)
        self.write("sitemap.xml", '<?xml version="1.0" encoding="UTF-8"?>\n'
                   f'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n{urls}</urlset>\n')
        self.write("robots.txt", f"User-agent: *\nAllow: /\nSitemap: {self.site_url}/sitemap.xml\n")
        self.write(f"{INDEXNOW_KEY}.txt", INDEXNOW_KEY)
        self.write(".nojekyll", "")
        self.write("urls.txt", "".join(self.url(p) + "\n" for p in self.indexable))
        self.write("build.json", json.dumps({"commit": self.commit, "built": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                             "version": self.ver}) + "\n")
        return self


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "dist"))
    args = ap.parse_args()
    today = dt.date.fromisoformat(os.environ["BUILD_DATE"]) if os.environ.get("BUILD_DATE") else dt.datetime.now(dt.timezone.utc).date()
    site = Site(args.out, today).build()
    print(f"built {len(site.pages)} pages ({len(site.indexable)} in the sitemap) into {args.out}, version {site.ver}")


if __name__ == "__main__":
    main()
