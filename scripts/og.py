"""Render the 1200x630 share cards in site/assets/og/ with headless Chrome: python3 scripts/og.py"""
import html
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "assets" / "og"
CHROME = os.environ.get("CHROME") or next(
    (c for c in [shutil.which("google-chrome"), shutil.which("chromium"),
                 "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] if c and Path(c).exists()), None)
CARD = """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;width:1200px;height:630px;overflow:hidden}}
body{{background:#0f1720;color:#e9eef3;font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;
 display:flex;flex-direction:column;justify-content:space-between;padding:64px 76px;box-sizing:border-box}}
.top{{font:700 34px/1 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;gap:14px}}
.dot{{width:22px;height:22px;border:5px solid #f2a900;border-top-color:transparent;border-radius:50%;display:inline-block;transform:rotate(45deg)}}
h1{{font-size:84px;line-height:1.04;margin:0;max-width:1000px;letter-spacing:-.01em}}
.typed{{font:30px/1.3 ui-monospace,Menlo,monospace;color:#9fb0c0;margin:26px 0 0}}
.typed b{{color:#f2a900;font-weight:400}}
.caret{{display:none}}
p.sub{{font:30px/1.3 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#f2b53a;margin:0}}
</style></head><body>
<div class="top"><span class="dot"></span>Existed By</div>
<div><h1>{title}</h1><div class="typed">{typed}<span class="caret"></span></div></div>
<p class="sub">{sub}</p>
</body></html>"""


def render(name, title, typed, sub, work):
    page = work / f"{name}.html"
    page.write_text(CARD.format(title=html.escape(title), typed=typed, sub=html.escape(sub)), encoding="utf-8")
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars", f"--user-data-dir={work / 'p'}",
                    "--window-size=1200,630", "--virtual-time-budget=2000", f"--screenshot={OUT / (name + '.png')}", page.as_uri()],
                   check=True, capture_output=True)
    print(OUT / f"{name}.png")


if __name__ == "__main__":
    if not CHROME:
        raise SystemExit("Chrome not found; set CHROME")
    OUT.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp())
    try:
        render("home", "Prove a video existed by a date.", "sha256 3bd9 395f fd67 51ce … <b>→ Bitcoin block</b>",
               "Fingerprinted on your device. Never uploaded. Free.", work)
        render("check", "Check a timestamp proof.", "existed by: <b>block time</b> · your copy: <b>identical</b>",
               "A timestamp proves a file existed by a date, not that it is true.", work)
    finally:
        shutil.rmtree(work, ignore_errors=True)
