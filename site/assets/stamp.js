// The stamp page: fingerprint a file on this device, send a blinded fingerprint to the public
// OpenTimestamps calendars, and hand back the proof and a check link. The file never leaves.
import { startProof } from "./ots.js";
import { submit, upgrade, STAMP_CALENDARS } from "./net.js";
import { Sha256, fromHex, toHex } from "./hashes.js";
import { linkFragment, proofName, saveStamp, loadStamps, updateStamp, removeStamp, fileOf, isComplete } from "./proofs.js";
import { CFG, $, h, track, fmtDateTime, fmtBytes, copyText, downloadBytes } from "./common.js";

const UPGRADE_AFTER_MS = 2 * 60 * 60 * 1000; // calendars need a few hours to reach Bitcoin
let current = null; // { id, name, size, type, digest, file, stampedAt }

const checkUrl = (file, s) => `${CFG.siteUrl}/check/#${linkFragment({ file, name: s.name, size: s.size, stampedAt: s.stampedAt })}`;

function show(...ids) {
  for (const id of ["#drop", "#work", "#result"]) $(id).hidden = !ids.includes(id);
}

// ---------- hashing ----------

async function hashOnPage(file, onProgress) {
  const s = new Sha256();
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < file.size; off += CHUNK) {
    s.update(new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer()));
    onProgress(Math.min(1, (off + CHUNK) / file.size));
    await new Promise((r) => setTimeout(r, 0));
  }
  return toHex(s.digest());
}

function hashFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./hash-worker.js", import.meta.url), { type: "module" });
    } catch {
      hashOnPage(file, onProgress).then(resolve, reject);
      return;
    }
    let started = false;
    worker.onmessage = (e) => {
      started = true;
      if (e.data.progress !== undefined) onProgress(e.data.progress);
      else if (e.data.digest) {
        worker.terminate();
        resolve(e.data.digest);
      } else if (e.data.error) {
        worker.terminate();
        reject(new Error(e.data.error));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      if (!started) hashOnPage(file, onProgress).then(resolve, reject);
      else reject(new Error("The file couldn't be read."));
    };
    worker.postMessage({ file });
  });
}

// ---------- stamping ----------

function calendarItems() {
  $("#cal-list").replaceChildren(...STAMP_CALENDARS.map((c) => h("li", { "data-cal": c }, h("span", { class: "state" }, "…"), " ", c.replace("https://", ""))));
}

async function stamp(file) {
  const id = toHex(crypto.getRandomValues(new Uint8Array(8)));
  current = { id, name: file.name, size: file.size, type: file.type };
  $("#w-name").textContent = file.name || "Unnamed file";
  $("#w-size").textContent = fmtBytes(file.size);
  $("#w-error").hidden = true;
  $("#s-hash").className = "doing";
  $("#s-send").className = "";
  $("#progress").value = 0;
  calendarItems();
  show("#work");
  track("stamp_start");
  try {
    current.digest = await hashFile(file, (p) => { $("#progress").value = p; });
  } catch (e) {
    return fail(`The file couldn't be read on this device (${e.message}). Try again, or try another browser.`);
  }
  $("#progress").value = 1;
  $("#s-hash").className = "done";
  $("#w-hash").textContent = current.digest;
  await send();
}

async function send() {
  $("#s-send").className = "doing";
  $("#w-error").hidden = true;
  const { file, tip } = startProof(fromHex(current.digest), crypto.getRandomValues(new Uint8Array(16)));
  const results = await submit(tip);
  for (const r of results) {
    const li = $(`[data-cal="${r.calendar}"]`);
    li.className = r.ok ? "done" : "failed";
    li.querySelector(".state").textContent = r.ok ? "✓" : "✗";
    if (!r.ok) li.append(h("span", { class: "small" }, ` (${r.error})`));
  }
  const ok = results.filter((r) => r.ok).length;
  if (!ok) return fail("None of the timestamp calendars answered. Check your connection and try again; your file is already fingerprinted.", true);
  $("#s-send").className = "done";
  current.file = file;
  current.stampedAt = Date.now();
  const saved = saveStamp(current);
  showResult(ok, saved);
  renderMine();
  track("stamp_done");
}

function fail(message, canRetry = false) {
  const box = $("#w-error");
  box.replaceChildren(message, canRetry ? h("span", {}, " ", h("button", { type: "button", class: "btn small", onclick: send }, "Try again")) : "");
  box.hidden = false;
  $("#s-send").className = canRetry ? "failed" : $("#s-send").className;
  document.body.dataset.stamp = "failed";
}

function showResult(ok, saved) {
  const link = checkUrl(current.file, current);
  $("#r-status").textContent = `Submitted to ${ok} of ${STAMP_CALENDARS.length} timestamp calendars at ${fmtDateTime(current.stampedAt)}. They add it to Bitcoin together with everyone else's, usually within a few hours. Until then the proof is pending; it completes when you, or anyone with the proof, checks it again later.`;
  $("#r-hash").textContent = current.digest;
  $("#r-link").value = link;
  $("#r-saved").textContent = saved
    ? "A copy is kept in this browser's list below. Still download the proof: browser storage gets cleared."
    : "This browser can't keep a copy (private mode or storage switched off). Download the proof now.";
  $("#r-share").hidden = !navigator.share;
  show("#result");
  $("#result h2").focus();
  document.body.dataset.stamp = "done";
  window.__existedBy = { lastProof: Array.from(current.file.serialize()), lastLink: link, digest: current.digest };
}

// ---------- the list of earlier stamps ----------

function renderMine() {
  const list = loadStamps();
  $("#mine-wrap").hidden = list.length === 0;
  $("#mine").replaceChildren(...list.map((s) => {
    let file = null;
    try {
      file = fileOf(s);
    } catch {
      /* a damaged entry is shown without actions */
    }
    const done = file && isComplete(file);
    const status = h("span", { class: `pill ${done ? "ok" : "wait"}` }, done ? "In Bitcoin" : "Pending");
    const actions = file ? [
      h("button", { type: "button", class: "btn small secondary", onclick: () => { downloadBytes(proofName(s.name), file.serialize()); track("proof_download"); } }, "Download proof"),
      h("a", { class: "btn small secondary", href: checkUrl(file, s) }, done ? "Check" : "Check now"),
      h("button", { type: "button", class: "btn small quiet", onclick: (e) => confirmRemove(e.currentTarget, s.id) }, "Remove"),
    ] : [h("span", { class: "small" }, "This entry is damaged.")];
    return h("li", { "data-id": s.id },
      h("div", {}, h("b", {}, s.name || "Unnamed file"), " ", status),
      h("div", { class: "small" }, `${Number.isFinite(s.size) ? fmtBytes(s.size) + " · " : ""}stamped ${fmtDateTime(s.stampedAt)} · fingerprint ${s.sha256.slice(0, 16)}…`),
      h("div", { class: "btn-row tight" }, ...actions));
  }));
}

function confirmRemove(button, id) {
  if (button.dataset.armed) {
    removeStamp(id);
    renderMine();
    return;
  }
  button.dataset.armed = "1";
  button.textContent = "Remove from this list? Click again";
}

/** Pending stamps older than a couple of hours: ask their calendars once, quietly. */
async function completeOld() {
  const due = loadStamps().filter((s) => Date.now() - s.stampedAt > UPGRADE_AFTER_MS).slice(0, 5);
  let changed = false;
  for (const s of due) {
    try {
      const file = fileOf(s);
      if (isComplete(file)) continue;
      const r = await upgrade(file);
      if (r.upgraded) changed = updateStamp(s.id, file) || changed;
    } catch {
      /* stays pending */
    }
  }
  if (changed) renderMine();
}

// ---------- wiring ----------

$("#file").addEventListener("change", (e) => {
  if (e.target.files[0]) stamp(e.target.files[0]);
  e.target.value = "";
});
const zone = $("#drop");
for (const name of ["dragenter", "dragover"]) {
  zone.addEventListener(name, (e) => {
    e.preventDefault();
    zone.classList.add("over");
  });
}
for (const name of ["dragleave", "drop"]) zone.addEventListener(name, () => zone.classList.remove("over"));
zone.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files[0]) stamp(e.dataTransfer.files[0]);
});
$("#r-download").addEventListener("click", () => {
  downloadBytes(proofName(current.name), current.file.serialize());
  track("proof_download");
});
$("#r-copy").addEventListener("click", (e) => {
  copyText($("#r-link").value, e.currentTarget, $("#r-link"));
  track("link_copy");
});
$("#r-share").addEventListener("click", async () => {
  try {
    await navigator.share({ title: "Timestamp proof", text: `Check that "${current.name}" existed by the time it was stamped:`, url: $("#r-link").value });
    track("link_share");
  } catch { /* cancelled */ }
});
$("#r-another").addEventListener("click", () => {
  show("#drop");
  $("#file").focus();
});

renderMine();
show("#drop");
document.body.dataset.ready = "1";
completeOld();
