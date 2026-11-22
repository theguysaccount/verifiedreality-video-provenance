// Check links and the list of stamps kept in this browser. A check link carries the whole proof
// after the "#", which browsers never send to a server.
import { OtsFile, OtsError, summarize } from "./ots.js";
import { toHex } from "./hashes.js";

export const LINK_VERSION = "1";
const MAX_NAME = 200;

export function toBase64Url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new OtsError("This link is damaged: it contains characters a check link never has.");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const cleanName = (s) => String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_NAME);

/** The part of a check link after "#". */
export function linkFragment({ file, name = "", size = null, stampedAt = null }) {
  const p = new URLSearchParams();
  p.set("v", LINK_VERSION);
  p.set("h", toHex(file.digest));
  p.set("p", toBase64Url(file.serialize()));
  if (cleanName(name)) p.set("n", cleanName(name));
  if (Number.isSafeInteger(size) && size >= 0) p.set("s", String(size));
  if (Number.isFinite(stampedAt)) p.set("t", String(Math.round(stampedAt / 1000)));
  return p.toString();
}

/** Read a check link's fragment. Throws OtsError with a message a person can act on. */
export function readFragment(fragment) {
  const p = new URLSearchParams(fragment.replace(/^#/, ""));
  if (!p.has("p")) throw new OtsError("This link doesn't contain a proof. It may have been cut short: ask for the .ots file instead.");
  if (p.get("v") && p.get("v") !== LINK_VERSION) throw new OtsError("This link was made by a newer version of this site. Reload the page and try again.");
  let file;
  try {
    file = OtsFile.parse(fromBase64Url(p.get("p")));
  } catch (e) {
    throw new OtsError(e instanceof OtsError && /damaged: it contains/.test(e.message) ? e.message : "This link's proof is damaged or was cut short. Ask for the .ots file instead.");
  }
  if (p.has("h") && p.get("h") !== toHex(file.digest)) throw new OtsError("This link is inconsistent: its fingerprint doesn't match its proof.");
  const size = p.has("s") && /^\d{1,16}$/.test(p.get("s")) ? Number(p.get("s")) : null;
  const t = p.has("t") && /^\d{1,12}$/.test(p.get("t")) ? Number(p.get("t")) * 1000 : null;
  return { file, name: cleanName(p.get("n")), size, stampedAt: t };
}

export const proofName = (name) => `${(cleanName(name) || "file").replace(/[\\/:*?"<>|]+/g, "_")}.ots`;

// ---------- stamps kept in this browser ----------

const KEY = "existedby.stamps.v1";
const MAX_STAMPS = 200;

export function loadStamps() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(list) ? list.filter((s) => s && typeof s.ots === "string" && typeof s.id === "string") : [];
  } catch {
    return [];
  }
}

function saveAll(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_STAMPS)));
    return true;
  } catch {
    return false;
  }
}

export function saveStamp({ id, name, size, type, file, stampedAt }) {
  const list = loadStamps().filter((s) => s.id !== id);
  list.unshift({ id, name: cleanName(name), size, type: String(type || "").slice(0, 100), sha256: toHex(file.digest), stampedAt, ots: toBase64Url(file.serialize()) });
  return saveAll(list);
}

export function updateStamp(id, file) {
  const list = loadStamps();
  const s = list.find((x) => x.id === id);
  if (!s) return false;
  s.ots = toBase64Url(file.serialize());
  return saveAll(list);
}

export function removeStamp(id) {
  return saveAll(loadStamps().filter((s) => s.id !== id));
}

export const fileOf = (stamp) => OtsFile.parse(fromBase64Url(stamp.ots));

export function isComplete(file) {
  return summarize(file).bitcoin.length > 0;
}
