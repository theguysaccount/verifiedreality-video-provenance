// Talking to the public OpenTimestamps calendars and to Bitcoin block explorers. Only digests (a
// hash of the file's hash and a random nonce) and block heights are sent; never the file. Every
// function takes `fetch` so tests can supply answers.
import { Timestamp, summarize, OtsError, equalBytes } from "./ots.js";
import { sha256, toHex, fromHex } from "./hashes.js";

// Calendars that accept new digests from a browser (they answer with CORS headers).
export const STAMP_CALENDARS = Object.freeze([
  "https://a.pool.opentimestamps.org",
  "https://b.pool.opentimestamps.org",
  "https://a.pool.eternitywall.com",
]);
// Calendars a pending attestation may point to, which this page will ask for the finished path.
// Proofs naming any other address are left for the `ots` client: the page never contacts a server
// a proof file names unless it is on this list.
export const UPGRADE_CALENDARS = Object.freeze([
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com",
  "https://btc.calendar.catallaxy.com",
]);
export const EXPLORERS = Object.freeze([
  { name: "Blockstream", base: "https://blockstream.info/api" },
  { name: "mempool.space", base: "https://mempool.space/api" },
]);
// A block header must carry at least this much proof of work. Bitcoin's difficulty has been above
// 4×10^10 since before OpenTimestamps existed (2016), so a header below it can't be a real
// timestamping block, and forging one above it costs days of industrial mining.
export const MIN_DIFFICULTY = 10_000_000_000n;
const MAX_TARGET = 0xffffn << 208n; // difficulty 1

async function timed(fetchFn, url, init, ms) {
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  try {
    return await fetchFn(url, { ...init, signal: ctl?.signal, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Send `tip.msg` to the calendars and merge their answers into `tip`. Returns one result per
 * calendar: { calendar, ok, error }. A calendar that fails is simply left out of the proof.
 */
export async function submit(tip, { fetch: fetchFn = globalThis.fetch, calendars = STAMP_CALENDARS, timeoutMs = 25_000 } = {}) {
  return Promise.all(calendars.map(async (calendar) => {
    try {
      const res = await timed(fetchFn, `${calendar}/digest`, {
        method: "POST",
        // A CORS-safelisted type, so the browser sends it without a preflight (calendars don't answer OPTIONS).
        headers: { Accept: "application/vnd.opentimestamps.v1", "Content-Type": "application/x-www-form-urlencoded" },
        body: tip.msg,
      }, timeoutMs);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const answer = Timestamp.fromBytes(new Uint8Array(await res.arrayBuffer()), tip.msg);
      tip.merge(answer);
      return { calendar, ok: true };
    } catch (e) {
      return { calendar, ok: false, error: e.name === "AbortError" ? "timed out" : e.message };
    }
  }));
}

/**
 * Ask each calendar named by a pending attestation whether its commitment has reached Bitcoin,
 * and merge the answer into the proof. Returns { asked, upgraded, skipped }.
 * Browsers can't read the calendars' "not yet" answers (they carry no CORS header), so a calendar
 * that isn't ready looks the same as one that is unreachable: both just leave the proof pending.
 */
export async function upgrade(file, { fetch: fetchFn = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  const { pending } = summarize(file);
  let asked = 0;
  let upgraded = 0;
  const skipped = [];
  await Promise.all(pending.map(async ({ uri, msg }) => {
    if (!UPGRADE_CALENDARS.includes(uri)) {
      skipped.push(uri);
      return;
    }
    asked++;
    try {
      const res = await timed(fetchFn, `${uri}/timestamp/${toHex(msg)}`, { headers: { Accept: "application/vnd.opentimestamps.v1" } }, timeoutMs);
      if (!res.ok) return;
      const answer = Timestamp.fromBytes(new Uint8Array(await res.arrayBuffer()), msg);
      const node = file.timestamp.find(msg);
      if (node && answer.all().some((x) => x.attestation.kind === "bitcoin")) {
        node.merge(answer);
        upgraded++;
      }
    } catch {
      /* not ready yet, or unreachable: the proof stays pending */
    }
  }));
  return { asked, upgraded, skipped };
}

const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Check an 80-byte block header: its own proof of work, and pull out the fields a proof needs. */
export function readHeader(header) {
  if (header.length !== 80) throw new OtsError("A block header is 80 bytes.");
  const hash = sha256(sha256(header));
  const bits = le32(header, 72);
  const exp = BigInt(bits >>> 24);
  const mant = BigInt(bits & 0x007fffff);
  const target = exp <= 3n ? mant >> (8n * (3n - exp)) : mant << (8n * (exp - 3n));
  const value = BigInt("0x" + toHex(Uint8Array.from(hash).reverse()));
  const work = target > 0n && value <= target;
  const difficulty = target > 0n ? MAX_TARGET / target : 0n;
  return {
    hash: toHex(Uint8Array.from(hash).reverse()),
    merkleRoot: header.subarray(36, 68),
    time: le32(header, 68),
    work,
    enoughWork: work && difficulty >= MIN_DIFFICULTY,
    difficulty,
  };
}

async function headerFrom(fetchFn, explorer, height, timeoutMs) {
  const r1 = await timed(fetchFn, `${explorer.base}/block-height/${height}`, {}, timeoutMs);
  if (!r1.ok) throw new Error(`HTTP ${r1.status}`);
  const hash = (await r1.text()).trim();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("unexpected answer");
  const r2 = await timed(fetchFn, `${explorer.base}/block/${hash}/header`, {}, timeoutMs);
  if (!r2.ok) throw new Error(`HTTP ${r2.status}`);
  const hex = (await r2.text()).trim();
  const header = fromHex(hex);
  const h = readHeader(header);
  if (h.hash !== hash) throw new Error("the header doesn't match the block hash it was given for");
  return { explorer: explorer.name, header: hex, ...h };
}

/**
 * Verify one Bitcoin attestation: fetch the block header at `height` from the explorers, check its
 * proof of work, and compare its Merkle root with the proof's result `msg`.
 * Returns { ok, height, time, hash, explorers, reason }.
 */
export async function verifyBitcoin(msg, height, { fetch: fetchFn = globalThis.fetch, explorers = EXPLORERS, timeoutMs = 20_000 } = {}) {
  const answers = await Promise.all(explorers.map((x) => headerFrom(fetchFn, x, height, timeoutMs).then((v) => v, (e) => ({ explorer: x.name, error: e.message }))));
  const good = answers.filter((a) => !a.error);
  if (!good.length) return { ok: false, height, reason: "unreachable", detail: answers.map((a) => `${a.explorer}: ${a.error}`).join("; ") };
  if (new Set(good.map((a) => a.header)).size > 1) return { ok: false, height, reason: "disagree", detail: "The block explorers gave different headers for this height." };
  const h = good[0];
  if (!h.enoughWork) return { ok: false, height, reason: "work", detail: "The block header doesn't carry real Bitcoin proof of work." };
  if (!equalBytes(h.merkleRoot, msg)) return { ok: false, height, reason: "mismatch", detail: "The proof doesn't lead to this block's Merkle root." };
  return { ok: true, height, time: h.time, hash: h.hash, explorers: good.map((a) => a.explorer) };
}

/** Verify every Bitcoin attestation in a proof; the earliest verified block is the answer. */
export async function verifyFile(file, opts = {}) {
  const { bitcoin } = summarize(file);
  const results = await Promise.all(bitcoin.map((b) => verifyBitcoin(b.msg, b.height, opts)));
  const ok = results.filter((r) => r.ok).sort((a, b) => a.time - b.time);
  return { results, earliest: ok[0] || null };
}
