// Records the site's sample clip: a 4-second animation drawn on a canvas, captured with the
// browser's MediaRecorder in headless Chrome. Made by this project, so it can be shipped freely.
//   node scripts/make_sample_clip.mjs  ->  site/data/sample-clip.webm
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serve } from "./cdp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(ROOT, ".clip-"));
fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html><canvas id="c" width="480" height="270"></canvas><script>
const c = document.getElementById("c"), g = c.getContext("2d");
let t0 = performance.now();
function draw(now) {
  const t = (now - t0) / 1000;
  g.fillStyle = "#0f1720"; g.fillRect(0, 0, 480, 270);
  g.strokeStyle = "#f2a900"; g.lineWidth = 6;
  g.beginPath(); g.arc(240, 135, 70, -Math.PI / 2, -Math.PI / 2 + Math.min(1, t / 3.6) * Math.PI * 2); g.stroke();
  g.fillStyle = "#e9eef3"; g.font = "bold 26px sans-serif"; g.textAlign = "center";
  g.fillText("Sample clip", 240, 128); g.font = "18px sans-serif"; g.fillText((Math.min(t, 4)).toFixed(1) + " s", 240, 158);
  g.font = "14px sans-serif"; g.fillStyle = "#9fb0c0"; g.fillText("Existed By sample, recorded 2026-11-22", 240, 250);
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
window.record = () => new Promise((resolve) => {
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: "video/webm;codecs=vp8", videoBitsPerSecond: 400000 });
  const parts = [];
  rec.ondataavailable = (e) => parts.push(e.data);
  rec.onstop = async () => {
    const buf = new Uint8Array(await new Blob(parts, { type: "video/webm" }).arrayBuffer());
    let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    resolve(btoa(s));
  };
  t0 = performance.now(); rec.start(); setTimeout(() => rec.stop(), 4000);
});
</script>`);
const srv = await serve(dir);
const b = await launch();
const p = await b.newPage();
await p.goto(srv.url, { wait: "canvas" });
const b64 = await p.eval("window.record()");
await b.close();
await srv.close();
fs.rmSync(dir, { recursive: true, force: true });
const out = path.join(ROOT, "site", "data", "sample-clip.webm");
fs.writeFileSync(out, Buffer.from(b64, "base64"));
console.log(`wrote ${path.relative(ROOT, out)} (${fs.statSync(out).size} bytes)`);
