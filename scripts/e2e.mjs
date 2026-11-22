// End-to-end test of the real pages in headless Chrome, against the real calendars and explorers.
//   node scripts/e2e.mjs                 # serve dist/ locally and test it
//   node scripts/e2e.mjs https://host/x/ # test a live site
//   node scripts/e2e.mjs --screens [url] # also save screenshots to docs/screens/
// MIN_CALENDARS (default 1): how many of the three calendars must accept the test stamp.
// Stamps a generated file, opens its check link, compares a matching and a different copy, verifies
// a complete proof against Bitcoin (the OpenTimestamps project's own example, fetched at test time),
// rejects a tampered proof, opens the sample, and checks for console errors, requests to hosts the
// page shouldn't contact, and phone-width overflow.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch, serve, sleep } from "./cdp.mjs";
import { OtsFile, summarize, OP } from "../site/assets/ots.js";
import { STAMP_CALENDARS, UPGRADE_CALENDARS, EXPLORERS } from "../site/assets/net.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const screens = args.includes("--screens");
const MIN_CALENDARS = Number(process.env.MIN_CALENDARS || 1);
let base = args.find((a) => !a.startsWith("--"));
let server = null;
if (!base) {
  server = await serve(path.join(ROOT, "dist"));
  base = server.url;
}
if (!base.endsWith("/")) base += "/";
const origin = new URL(base).origin;
const allowedHosts = new Set([...STAMP_CALENDARS, ...UPGRADE_CALENDARS, ...EXPLORERS.map((x) => x.base)].map((u) => new URL(u).origin));
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
const shot = (page, name, opts) => (screens ? page.screenshot(path.join(ROOT, "docs", "screens", `${name}.png`), opts) : null);
const log = (...m) => console.log(...m);
// Calendars answer "not ready yet" without CORS headers, so the browser logs each pending check as a
// blocked request. Those are expected; every other console error fails the test.
const realErrors = (errors) => errors.filter((e) => !/calendar\.opentimestamps\.org|calendar\.eternitywall\.com|calendar\.catallaxy\.com|ERR_FAILED|CORS policy/.test(e));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "existedby-e2e-"));
const clip = path.join(tmp, "test-clip.webm");
fs.writeFileSync(clip, crypto.randomBytes(3 * 1024 * 1024 + 17));
const other = path.join(tmp, "re-encoded-copy.webm");
fs.writeFileSync(other, crypto.randomBytes(1024 * 1024));

const browser = await launch();
const failures = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
    log(`FAIL ${name}: ${e.stack || e.message}`);
  }
}

const page = await browser.newPage();
await page.viewport(1280, 900);
let link = "";

await step("home page states the promise and the limit", async () => {
  await page.goto(base);
  await page.eval("localStorage.clear()");
  await page.goto(base);
  const h1 = await page.eval("document.querySelector('h1').textContent");
  assert.match(h1, /Prove a video existed by a date/);
  assert.match(await page.eval("document.querySelector('.limits').textContent"), /doesn't prove/);
  await shot(page, "home-desktop", { fullPage: true });
});

await step("stamp: the file is fingerprinted here and only a blinded digest goes to the calendars", async () => {
  const before = page.requests.length;
  await page.setFile("#file", clip);
  await page.waitFor("document.body.dataset.stamp", "the stamp to finish", 90000);
  assert.equal(await page.eval("document.body.dataset.stamp"), "done", await page.eval("document.querySelector('#w-error').textContent"));
  const got = await page.eval("window.__existedBy");
  assert.equal(got.digest, sha256(fs.readFileSync(clip)), "fingerprint = SHA-256 of the file");
  const proof = OtsFile.parse(Uint8Array.from(got.lastProof));
  assert.equal(Buffer.from(proof.digest).toString("hex"), got.digest);
  const pending = summarize(proof).pending.map((p) => p.uri);
  assert.ok(pending.length >= MIN_CALENDARS, `pending at ${pending.length} calendars, need ${MIN_CALENDARS}`);
  assert.ok(pending.every((u) => UPGRADE_CALENDARS.includes(u)), "every calendar in the proof is one the page can complete it from");
  // Only the calendars were contacted, and the file's own fingerprint was never sent.
  const sent = page.requests.slice(before).filter((u) => !u.startsWith(origin));
  assert.ok(sent.length >= 1 && sent.every((u) => STAMP_CALENDARS.some((c) => u.startsWith(c + "/digest"))), JSON.stringify(sent));
  assert.ok(!sent.some((u) => u.includes(got.digest)));
  link = got.lastLink;
  assert.ok(link.includes("/check/#v=1&h=" + got.digest), link);
  assert.match(await page.eval("document.querySelector('#mine').textContent"), /test-clip\.webm.*Pending/s);
  await shot(page, "stamped-desktop", { fullPage: true });
});

await step("list: an exported list of stamps imports into a fresh browser", async () => {
  const got = await page.eval("window.__existedBy");
  const { exportList } = await import("../site/assets/proofs.js");
  const { toBase64Url } = await import("../site/assets/proofs.js");
  const listFile = path.join(tmp, "existed-by-stamps.json");
  fs.writeFileSync(listFile, exportList([{ id: "abcdef0123456789", name: "moved-clip.webm", size: 12, type: "video/webm", stampedAt: Date.now(), ots: toBase64Url(Uint8Array.from(got.lastProof)) }]));
  const fresh = await browser.newPage();
  await fresh.goto(base);
  await fresh.eval("localStorage.clear()");
  await fresh.goto(base);
  await fresh.setFile("#import-list", listFile);
  await fresh.waitFor("/Added 1 stamp/.test(document.querySelector('#import-msg').textContent)", "the import");
  assert.match(await fresh.eval("document.querySelector('#mine').textContent"), /moved-clip\.webm/);
});

await step("check link: opens the proof as pending and compares copies", async () => {
  await page.goto(base + "check/" + link.slice(link.indexOf("#")));
  await page.waitFor("['pending','complete'].includes(document.body.dataset.status)", "the status", 60000);
  assert.equal(await page.eval("document.body.dataset.status"), "pending");
  assert.equal(await page.eval("document.querySelector('#r-name').textContent"), "test-clip.webm");
  await page.setFile("#copy", clip);
  await page.waitFor("document.body.dataset.match", "the comparison", 30000);
  assert.equal(await page.eval("document.body.dataset.match"), "yes");
  await page.setFile("#copy", other);
  await page.waitFor("document.body.dataset.match === 'no'", "the mismatch", 30000);
  assert.match(await page.eval("document.querySelector('#copy-result').textContent"), /re-encoding/);
  await shot(page, "check-pending-desktop", { fullPage: true });
});

// The OpenTimestamps client's own example of a complete proof (Bitcoin block 358391, 28 May 2015).
const EX = "https://raw.githubusercontent.com/opentimestamps/opentimestamps-client/master/examples/hello-world.txt";
const exText = path.join(tmp, "hello-world.txt");
const exProof = path.join(tmp, "hello-world.txt.ots");
await step("complete proof: verified against Bitcoin, with the file compared", async () => {
  for (const [url, file] of [[EX, exText], [EX + ".ots", exProof]]) {
    const r = await fetch(url);
    assert.ok(r.ok, `${url}: ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  await page.goto(base + "check/");
  await page.setFile("#files", exProof);
  await page.waitFor("['complete','failed','unreachable'].includes(document.body.dataset.status)", "verification", 60000);
  assert.equal(await page.eval("document.body.dataset.status"), "complete", await page.eval("document.querySelector('#r-status').textContent"));
  const status = await page.eval("document.querySelector('#r-status').textContent");
  assert.match(status, /existed by .*2015/);
  assert.match(status, /358,391|358391/);
  await page.setFile("#copy", exText);
  await page.waitFor("document.body.dataset.match", "the comparison", 30000);
  assert.equal(await page.eval("document.body.dataset.match"), "yes");
  await shot(page, "check-complete-desktop", { fullPage: true });
});

await step("tampered proof: a changed path step is caught", async () => {
  const proof = OtsFile.parse(new Uint8Array(fs.readFileSync(exProof)));
  // Change the argument of the last append/prepend on the way to the block.
  let node = proof.timestamp;
  let last = null;
  while (node.ops.size) {
    for (const op of node.ops.values()) if (op.tag === OP.APPEND || op.tag === OP.PREPEND) last = op;
    node = [...node.ops.values()][0].stamp;
  }
  assert.ok(last, "the example has an append or prepend");
  last.arg = Uint8Array.from(last.arg);
  last.arg[0] ^= 0xff;
  // Rebuild the subtree under the changed step so the file stays well formed.
  const bytes = proof.serialize();
  const reparsed = OtsFile.parse(bytes);
  const bad = path.join(tmp, "tampered.txt.ots");
  fs.writeFileSync(bad, reparsed.serialize());
  await page.goto(base + "check/");
  await page.setFile("#files", bad);
  await page.waitFor("['complete','failed','unreachable','pending'].includes(document.body.dataset.status)", "verification", 60000);
  assert.equal(await page.eval("document.body.dataset.status"), "failed", await page.eval("document.querySelector('#r-status').textContent"));
});

await step("sample: the clip on the site matches its proof", async () => {
  await page.goto(base);
  const href = await page.eval("[...document.querySelectorAll('a')].find(a => /sample proof/i.test(a.textContent)).getAttribute('href')");
  await page.goto(new URL(href, base).href);
  await page.waitFor("['pending','complete'].includes(document.body.dataset.status)", "the sample status", 60000);
  const r = await fetch(new URL("sample/sample-clip.webm", base));
  assert.ok(r.ok);
  const sample = path.join(tmp, "sample-clip.webm");
  fs.writeFileSync(sample, Buffer.from(await r.arrayBuffer()));
  await page.setFile("#copy", sample);
  await page.waitFor("document.body.dataset.match", "the comparison", 30000);
  assert.equal(await page.eval("document.body.dataset.match"), "yes");
  log(`     sample proof is ${await page.eval("document.body.dataset.status")}`);
});

await step("errors: a damaged link and a lone video are explained", async () => {
  await page.goto(base + "check/#v=1&p=AAAAbroken");
  await page.waitFor("document.body.dataset.state === 'error'", "the error");
  assert.match(await page.eval("document.querySelector('#error').textContent"), /damaged|cut short/);
  await page.goto(base + "check/");
  await page.setFile("#files", other);
  await page.waitFor("document.body.dataset.state === 'error'", "the error");
  assert.match(await page.eval("document.querySelector('#error').textContent"), /proof \(\.ots file\)/);
});

await step("every page: canonical, no unexpected console errors, no requests to other hosts", async () => {
  const robots = await (await fetch(base + "robots.txt")).text();
  const site = robots.match(/Sitemap: (\S+)\/sitemap\.xml/)[1];
  const urls = [...(await (await fetch(base + "sitemap.xml")).text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(urls.length >= 6, "sitemap lists the pages");
  for (const u of urls) {
    await page.goto(base + u.slice(site.length + 1), { wait: "main" });
    assert.equal(await page.eval("document.querySelector('link[rel=canonical]').href"), u);
  }
  const foreign = page.requests.filter((u) => !u.startsWith(origin) && !u.startsWith("data:") && !u.startsWith("blob:") && !allowedHosts.has(new URL(u).origin));
  assert.deepEqual(foreign, [], "requests to hosts outside the policy");
  assert.deepEqual(realErrors(page.errors), [], "console errors");
});

await step("phone width: no page scrolls sideways", async () => {
  const phone = await browser.newPage();
  await phone.viewport(390, 844, true);
  const wide = [];
  for (const t of ["", "check/", "how-it-works/", "guides/", "guides/verify-an-opentimestamps-proof/", "check/" + link.slice(link.indexOf("#"))]) {
    await phone.goto(base + t, { wait: "main" });
    if (t.includes("#")) await phone.waitFor("['pending','complete'].includes(document.body.dataset.status)", "the status", 60000);
    await sleep(200);
    const w = await phone.eval("document.documentElement.scrollWidth");
    if (w > 391) wide.push(`${t || "home"}: ${w}px`);
    if (screens && t === "") await phone.screenshot(path.join(ROOT, "docs", "screens", "home-phone.png"), { fullPage: true });
    if (screens && t.includes("#")) await phone.screenshot(path.join(ROOT, "docs", "screens", "check-phone.png"), { fullPage: true });
  }
  assert.deepEqual(wide, []);
  assert.deepEqual(realErrors(phone.errors), []);
});

fs.rmSync(tmp, { recursive: true, force: true });
await browser.close();
if (server) await server.close();
if (failures.length) {
  log(`\n${failures.length} failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
log(`\nall end-to-end checks passed on ${base}`);
