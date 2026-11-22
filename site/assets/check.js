// The check page: open a proof (from a link or an .ots file), complete it if it's still pending,
// verify it against Bitcoin, and compare a copy of the video with it. Files are read on this device.
import { OtsFile, OtsError, summarize, MAGIC, equalBytes } from "./ots.js";
import { upgrade, verifyFile, UPGRADE_CALENDARS } from "./net.js";
import { Sha256, toHex } from "./hashes.js";
import { readFragment, linkFragment, proofName, cleanName } from "./proofs.js";
import { CFG, $, h, track, fmtDateTime, fmtWhen, fmtBytes, copyText, downloadBytes } from "./common.js";

let current = null; // { file, name, size, stampedAt, source, changed }
const say = (el, cls, ...text) => {
  el.className = `check ${cls}`;
  el.replaceChildren(...text);
};

function fail(message) {
  $("#report").hidden = true;
  $("#opener").hidden = false;
  $("#error").textContent = message;
  $("#error").hidden = false;
  document.body.dataset.state = "error";
}

async function hashFile(file, onProgress) {
  const s = new Sha256();
  const CHUNK = 8 * 1024 * 1024;
  for (let off = 0; off < file.size; off += CHUNK) {
    s.update(new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer()));
    onProgress(Math.min(1, (off + CHUNK) / file.size));
    await new Promise((r) => setTimeout(r, 0));
  }
  return s.digest();
}

const isProof = async (f) => f.size >= MAGIC.length && f.size < 1_000_000 && equalBytes(new Uint8Array(await f.slice(0, MAGIC.length).arrayBuffer()), MAGIC);

// ---------- the report ----------

function renderBasics() {
  const { file, name, size, stampedAt } = current;
  $("#r-name").textContent = name || "Unnamed file";
  $("#r-meta").textContent = [size !== null ? fmtBytes(size) : null, stampedAt ? `stamped ${fmtDateTime(stampedAt)} by the stamper's device clock (not verified)` : null].filter(Boolean).join(" · ");
  $("#r-hash").textContent = toHex(file.digest);
  $("#r-hash-name").textContent = file.hashName.toUpperCase();
  $("#r-source").textContent = current.source;
  const { pending } = summarize(file);
  $("#r-calendars").replaceChildren(...(pending.length ? pending.map((p) => h("li", {}, p.uri.replace("https://", ""), UPGRADE_CALENDARS.includes(p.uri) ? "" : " (not contacted by this page: use the ots client)")) : [h("li", {}, "none left pending")]));
}

async function check() {
  const status = $("#r-status");
  document.body.dataset.status = "checking";
  say(status, "warn", "Checking the proof against Bitcoin…");
  $("#again").hidden = true;
  let { bitcoin } = summarize(current.file);
  if (!bitcoin.length) {
    const r = await upgrade(current.file);
    if (r.upgraded) {
      current.changed = true;
      bitcoin = summarize(current.file).bitcoin;
      renderBasics();
    }
  }
  if (!bitcoin.length) {
    document.body.dataset.status = "pending";
    say(status, "warn", h("b", {}, "Pending: not in Bitcoin yet. "),
      "This proof was sent to timestamp calendars, which add it to Bitcoin together with many others, usually within a few hours of stamping. Until then it doesn't prove a date. Check again later: the page asks the calendars for the finished proof each time.");
    $("#again").hidden = false;
    renderDownload();
    return;
  }
  const { results, earliest } = await verifyFile(current.file);
  if (earliest) {
    document.body.dataset.status = "complete";
    const when = fmtWhen(earliest.time * 1000);
    say(status, "ok", h("b", {}, `This file existed by ${when}.`), " ",
      `Its fingerprint is anchored in Bitcoin block ${earliest.height.toLocaleString()}, which was mined at that time (block times are accurate to within about two hours). `,
      `The block header came from ${earliest.explorers.join(" and ")}, and this page checked its proof of work and that the proof leads to it.`);
    $("#r-block").replaceChildren(
      h("li", {}, `Block ${earliest.height.toLocaleString()}: `, h("span", { class: "mono break" }, earliest.hash)),
      h("li", {}, `Block time: ${new Date(earliest.time * 1000).toISOString().replace(".000Z", " UTC")}`));
    $("#r-block-wrap").hidden = false;
    track("check_complete");
  } else {
    const reasons = results.map((r) => r.reason);
    if (reasons.every((r) => r === "unreachable")) {
      document.body.dataset.status = "unreachable";
      say(status, "warn", h("b", {}, "Couldn't reach the block explorers. "), "The proof contains a Bitcoin attestation, but this page couldn't fetch the block to check it. Try again in a moment, or verify it with the ots client.");
      $("#again").hidden = false;
    } else {
      document.body.dataset.status = "failed";
      say(status, "bad", h("b", {}, "This proof doesn't check out. "), results.map((r) => r.detail).filter(Boolean).join(" "), " Don't rely on it.");
    }
  }
  renderDownload();
}

function renderDownload() {
  $("#r-download").textContent = current.changed ? "Download the completed proof (.ots)" : "Download the proof (.ots)";
  const link = `${CFG.siteUrl}/check/#${linkFragment(current)}`;
  $("#r-link").value = link;
  $("#r-link-note").textContent = current.changed ? "The proof was completed on this page; this link carries the completed version." : "";
}

async function open(file, meta, source) {
  $("#error").hidden = true;
  current = { file, name: meta.name || "", size: meta.size ?? null, stampedAt: meta.stampedAt ?? null, source, changed: false };
  $("#opener").hidden = true;
  $("#report").hidden = false;
  $("#copy-result").hidden = true;
  document.body.dataset.state = "open";
  delete document.body.dataset.match;
  renderBasics();
  $("#r-name").focus();
  track("check_open");
  await check();
}

async function compareCopy(f) {
  const box = $("#copy-result");
  const bar = $("#copy-progress");
  box.hidden = true;
  if (current.file.hashName !== "sha256") {
    say(box, "warn", "This proof fingerprints files with an older hash this page doesn't compute. Use the ots client to compare the file.");
    box.hidden = false;
    return;
  }
  bar.hidden = false;
  bar.value = 0;
  const digest = await hashFile(f, (p) => { bar.value = p; });
  bar.hidden = true;
  const same = equalBytes(digest, current.file.digest);
  document.body.dataset.match = same ? "yes" : "no";
  if (same) {
    say(box, "ok", h("b", {}, `“${cleanName(f.name)}” is identical to the stamped file, `), "byte for byte. Whatever the proof shows above applies to this copy.");
  } else {
    say(box, "bad", h("b", {}, `“${cleanName(f.name)}” is not the stamped file. `),
      "Any change gives a different fingerprint: an edit, a trim, but also re-encoding, which most apps and platforms do when you upload or download a video. So a mismatch doesn't show the video was doctored; it shows this proof can't vouch for this copy. Ask for the original file.");
  }
  box.hidden = false;
  track(same ? "check_match" : "check_nomatch");
}

// ---------- ways in ----------

async function openFiles(files) {
  $("#error").hidden = true;
  let proof = null;
  let other = null;
  for (const f of files) {
    if (await isProof(f)) proof = proof || f;
    else other = other || f;
  }
  if (proof) {
    try {
      const file = OtsFile.parse(new Uint8Array(await proof.arrayBuffer()));
      await open(file, { name: cleanName(proof.name.replace(/\.ots$/i, "")) }, `file “${cleanName(proof.name)}”`);
    } catch (e) {
      return fail(e instanceof OtsError ? e.message : "This file couldn't be read as a timestamp proof.");
    }
    if (other) await compareCopy(other);
  } else if (other) {
    fail(current ? "" : "That looks like the video itself. Choose its proof (.ots file) too, or open the check link you were sent, then compare the video below.");
  }
}

function fromLocation() {
  if (!location.hash.includes("p=")) return;
  try {
    const meta = readFragment(location.hash.slice(1));
    open(meta.file, meta, "link");
  } catch (e) {
    fail(e instanceof OtsError ? e.message : "This link couldn't be opened.");
  }
}

$("#files").addEventListener("change", (e) => {
  openFiles([...e.target.files]);
  e.target.value = "";
});
$("#copy").addEventListener("change", (e) => {
  if (e.target.files[0]) compareCopy(e.target.files[0]);
  e.target.value = "";
});
for (const [zoneSel, handler] of [["#drop", (fs) => openFiles(fs)], ["#copy-drop", (fs) => fs[0] && compareCopy(fs[0])]]) {
  const zone = $(zoneSel);
  for (const name of ["dragenter", "dragover"]) {
    zone.addEventListener(name, (e) => {
      e.preventDefault();
      zone.classList.add("over");
    });
  }
  for (const name of ["dragleave", "drop"]) zone.addEventListener(name, () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    handler([...e.dataTransfer.files]);
  });
}
$("#again").addEventListener("click", check);
$("#r-download").addEventListener("click", () => {
  downloadBytes(proofName(current.name), current.file.serialize());
  track("proof_download");
});
$("#r-copy").addEventListener("click", (e) => copyText($("#r-link").value, e.currentTarget, $("#r-link")));
$("#another").addEventListener("click", () => {
  $("#report").hidden = true;
  $("#opener").hidden = false;
  history.replaceState(null, "", location.pathname);
  document.body.dataset.state = "empty";
  current = null;
});
window.addEventListener("hashchange", fromLocation);

document.body.dataset.state = "empty";
fromLocation();
document.body.dataset.ready = "1";
window.__existedBy = { current: () => current && Array.from(current.file.serialize()) };
