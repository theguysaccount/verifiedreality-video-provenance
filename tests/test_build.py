"""Build tests: python3 -m unittest discover -s tests -v

Builds the site into temporary folders (with today's date) and checks the output: every page and
link resolves, the security policy is on every page, the optional settings switch what they should.
Nothing here depends on launch-day content or counts.
"""
import importlib.util
import json
import os
import re
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build", ROOT / "pipeline" / "build.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class Refs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs, self.ld, self._in_ld, self.csp, self.canonical = [], [], False, None, None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for key in ("href", "src"):
            if a.get(key):
                self.refs.append(a[key])
        if tag == "script" and a.get("type") == "application/ld+json":
            self._in_ld = True
        if tag == "meta" and a.get("http-equiv") == "Content-Security-Policy":
            self.csp = a.get("content")
        if tag == "link" and a.get("rel") == "canonical":
            self.canonical = a.get("href")

    def handle_endtag(self, tag):
        self._in_ld = False

    def handle_data(self, data):
        if self._in_ld:
            self.ld.append(data)


def make(env=None):
    out = Path(tempfile.mkdtemp())
    with mock.patch.dict(os.environ, env or {}, clear=False):
        for k in ("SITE_URL", "MOVE_NOTICE_URL", "GOATCOUNTER_URL", "NEWSROOM_URL"):
            if k not in (env or {}):
                os.environ.pop(k, None)
        site = build.Site(out, build.dt.date.today()).build()
    return site, out


class BuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.site, cls.out = make()

    def pages(self):
        return sorted(self.out.rglob("*.html"))

    def test_every_page_is_built_and_in_the_sitemap(self):
        sitemap = (self.out / "sitemap.xml").read_text()
        locs = re.findall(r"<loc>([^<]+)</loc>", sitemap)
        self.assertEqual(len(locs), len(self.site.indexable))
        for path in self.site.indexable:
            self.assertTrue((self.out / (path + "index.html")).exists(), path)
            self.assertIn(f"{build.DEFAULT_SITE_URL}/{path}", locs)
        self.assertNotIn("404", sitemap)
        self.assertIn(f"Sitemap: {build.DEFAULT_SITE_URL}/sitemap.xml", (self.out / "robots.txt").read_text())
        self.assertEqual((self.out / f"{build.INDEXNOW_KEY}.txt").read_text(), build.INDEXNOW_KEY)
        self.assertEqual((self.out / "urls.txt").read_text().split(), [f"{build.DEFAULT_SITE_URL}/{p}" for p in self.site.indexable])

    def test_every_local_link_and_file_resolves(self):
        for page in self.pages():
            refs = Refs()
            refs.feed(page.read_text())
            for ref in refs.refs:
                if re.match(r"^(https?:|mailto:|#|data:)", ref) or ref.startswith("/verifiedreality-video-provenance/"):
                    continue
                clean = ref.split("#")[0].split("?")[0]
                target = (page.parent / clean).resolve() if clean else page
                if clean.endswith("/") or target.is_dir():
                    target = target / "index.html"
                self.assertTrue(target.exists(), f"{page.relative_to(self.out)} links to missing {ref}")

    def test_every_page_has_the_security_policy_metadata_and_no_placeholders(self):
        for page in self.pages():
            html = page.read_text()
            refs = Refs()
            refs.feed(html)
            connect = re.search(r"connect-src ([^;]*)", refs.csp).group(1).split()
            self.assertEqual(connect, build.CONNECT, page)
            self.assertIn("script-src 'self';", refs.csp, page)
            self.assertIn("worker-src 'self'", refs.csp, page)
            self.assertNotIn("{{", html, page)
            self.assertIn('<meta name="description"', html, page)
            self.assertIn('property="og:image"', html, page)
            for block in refs.ld:
                json.loads(block)
            rel = page.relative_to(self.out).as_posix()
            if rel != "404.html":
                self.assertEqual(refs.canonical, f"{build.DEFAULT_SITE_URL}/{rel[:-len('index.html')]}", page)

    def test_the_sample_link_carries_the_shipped_proof(self):
        import base64
        import hashlib
        home = (self.out / "index.html").read_text()
        frag = re.search(r'href="(?:\./)?check/#(v=1&amp;h=[^"]+)"', home).group(1).replace("&amp;", "&")
        params = dict(p.split("=", 1) for p in frag.split("&"))
        proof = (ROOT / "site" / "data" / "sample-clip.webm.ots").read_bytes()
        self.assertEqual(base64.urlsafe_b64decode(params["p"] + "=" * (-len(params["p"]) % 4)), proof)
        clip = (self.out / "sample" / "sample-clip.webm").read_bytes()
        self.assertEqual(params["h"], hashlib.sha256(clip).hexdigest())
        self.assertEqual(int(params["s"]), len(clip))
        self.assertEqual((self.out / "sample" / "sample-clip.webm.ots").read_bytes(), proof)

    def test_the_policy_allows_exactly_the_hosts_the_code_contacts(self):
        net = (ROOT / "site" / "assets" / "net.js").read_text()
        hosts = []
        for name in ("STAMP_CALENDARS", "UPGRADE_CALENDARS", "EXPLORERS"):
            block = re.search(name + r" = Object\.freeze\(\[(.*?)\]\);", net, re.S).group(1)
            hosts += ["/".join(u.split("/")[:3]) for u in re.findall(r'"(https://[^"]+)"', block)]
        self.assertEqual(sorted(set(hosts)), sorted(build.CONNECT))

    def test_the_worker_is_loaded_with_the_build_version(self):
        stamp = (self.out / "assets" / "stamp.js").read_text()
        self.assertIn(f'new URL("./hash-worker.js?v={self.site.ver}"', stamp)

    def test_imports_carry_the_build_version(self):
        for js in (self.out / "assets").glob("*.js"):
            for m in re.findall(r'from\s+"(\./[^"]+)"', js.read_text()):
                self.assertIn(f"?v={self.site.ver}", m, js.name)

    def test_optional_keys_switch_what_they_should(self):
        site, out = make({"GOATCOUNTER_URL": "https://example.goatcounter.com/count", "NEWSROOM_URL": "https://example.org/newsroom",
                          "SITE_URL": "https://stamp.example.org"})
        home = (out / "index.html").read_text()
        self.assertIn("https://gc.zgo.at", home)
        self.assertIn("https://mempool.space https://example.goatcounter.com", home)
        self.assertIn("GoatCounter", home)
        self.assertIn("https://example.org/newsroom", home)
        self.assertIn('<link rel="canonical" href="https://stamp.example.org/">', home)
        self.assertIn("Sitemap: https://stamp.example.org/sitemap.xml", (out / "robots.txt").read_text())
        self.assertIn('href="/assets/site.css', (out / "404.html").read_text())
        # Off by default: no analytics script, no money slot.
        default_home = (self.out / "index.html").read_text()
        self.assertNotIn("gc.zgo.at", default_home)
        self.assertNotIn("For newsrooms", default_home)
        self.assertIn('href="/verifiedreality-video-provenance/assets/site.css', (self.out / "404.html").read_text())

    def test_a_move_notice_appears_only_when_set(self):
        self.assertNotIn("move-notice", (self.out / "index.html").read_text())
        site, out = make({"MOVE_NOTICE_URL": "https://new.example.org/"})
        for page in (out / "index.html", out / "how-it-works" / "index.html"):
            html = page.read_text()
            self.assertIn('class="move-notice"', html)
            self.assertIn('href="https://new.example.org/"', html)
        with self.assertRaises(SystemExit):
            make({"MOVE_NOTICE_URL": "javascript:alert(1)"})


if __name__ == "__main__":
    unittest.main()
