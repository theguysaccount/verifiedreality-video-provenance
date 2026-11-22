// Unit tests: hashes, the proof format, links, and the network code with simulated services.
// Run: node --test tests/js/*.test.mjs   (no network needed)
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Sha256, sha256, sha1, ripemd160, toHex, fromHex } from "../../site/assets/hashes.js";
import { OtsFile, Timestamp, OtsError, OP, MAGIC, startProof, summarize, pendingAttestation, applyOp } from "../../site/assets/ots.js";
import { submit, upgrade, verifyBitcoin, verifyFile, readHeader, STAMP_CALENDARS } from "../../site/assets/net.js";
import { linkFragment, readFragment, toBase64Url, fromBase64Url, cleanName, proofName } from "../../site/assets/proofs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HEADERS = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/headers.json"), "utf8"));
const node = (alg, b) => crypto.createHash(alg).update(b).digest("hex");
const bytes = (s) => new TextEncoder().encode(s);

test("SHA-256, SHA-1 and RIPEMD-160 match published vectors and Node at every block boundary", () => {
  assert.equal(toHex(sha256(bytes("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(toHex(sha1(bytes("abc"))), "a9993e364706816aba3e25717850c26c9cd0d89d");
  assert.equal(toHex(ripemd160(bytes("abc"))), "8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
  assert.equal(toHex(ripemd160(new Uint8Array(0))), "9c1185a5c5e9fc54612808977ee8f548b2258d31");
  for (const len of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 4097]) {
    const b = crypto.randomBytes(len);
    assert.equal(toHex(sha256(b)), node("sha256", b), `sha256 ${len}`);
    assert.equal(toHex(sha1(b)), node("sha1", b), `sha1 ${len}`);
    assert.equal(toHex(ripemd160(b)), node("ripemd160", b), `ripemd160 ${len}`);
  }
});

test("incremental SHA-256 gives the same fingerprint however the file is split", () => {
  const b = crypto.randomBytes(300_001);
  for (const piece of [1, 7, 63, 64, 65, 4096, 299_999]) {
    const s = new Sha256();
    for (let i = 0; i < b.length; i += piece) s.update(b.subarray(i, i + piece));
    assert.equal(toHex(s.digest()), node("sha256", b), `pieces of ${piece}`);
  }
  assert.throws(() => { const s = new Sha256(); s.digest(); s.update(b); });
});

test("hex helpers refuse junk", () => {
  assert.deepEqual([...fromHex("00ff10")], [0, 255, 16]);
  assert.throws(() => fromHex("abc"));
  assert.throws(() => fromHex("zz"));
});

// A calendar's answer, as the real ones are shaped: a few appends and hashes, then a pending attestation.
function calendarAnswer(msg, uri, seed) {
  const t = new Timestamp(msg);
  const leaf = t.add(OP.APPEND, crypto.createHash("sha256").update(seed).digest().subarray(0, 8)).add(OP.SHA256)
    .add(OP.PREPEND, Uint8Array.from([0x6a, 0xf2, 0xc3, 0xd9])).add(OP.APPEND, crypto.randomBytes(8));
  leaf.attestations.push(pendingAttestation(uri));
  const w = new OtsFile(OP.SHA256, new Uint8Array(32), t);
  return w.serialize().subarray(MAGIC.length + 2 + 32); // just the timestamp part
}

test("a new proof has the shape the official client makes, and round-trips byte for byte", () => {
  const digest = sha256(bytes("a video"));
  const nonce = crypto.randomBytes(16);
  const { file, tip } = startProof(digest, nonce);
  assert.deepEqual([...tip.msg], [...sha256(Uint8Array.from([...digest, ...nonce]))]);
  tip.merge(Timestamp.fromBytes(calendarAnswer(tip.msg, "https://alice.btc.calendar.opentimestamps.org", "a"), tip.msg));
  tip.merge(Timestamp.fromBytes(calendarAnswer(tip.msg, "https://bob.btc.calendar.opentimestamps.org", "b"), tip.msg));
  const out = file.serialize();
  assert.deepEqual([...out.subarray(0, MAGIC.length)], [...MAGIC]);
  const back = OtsFile.parse(out);
  assert.deepEqual([...back.serialize()], [...out]);
  assert.equal(toHex(back.digest), toHex(digest));
  const s = summarize(back);
  assert.deepEqual(s.pending.map((p) => p.uri).sort(), ["https://alice.btc.calendar.opentimestamps.org", "https://bob.btc.calendar.opentimestamps.org"]);
  assert.equal(s.bitcoin.length, 0);
  assert.ok(back.timestamp.find(s.pending[0].msg));
});

test("merging the same answer twice changes nothing", () => {
  const { file, tip } = startProof(sha256(bytes("x")), crypto.randomBytes(16));
  const answer = calendarAnswer(tip.msg, "https://bob.btc.calendar.opentimestamps.org", "b");
  tip.merge(Timestamp.fromBytes(answer, tip.msg));
  const once = toHex(file.serialize());
  tip.merge(Timestamp.fromBytes(answer, tip.msg));
  assert.equal(toHex(file.serialize()), once);
});

test("the site's sample proof is a valid proof of the sample clip, pending or complete", () => {
  const clip = fs.readFileSync(path.join(ROOT, "site/data/sample-clip.webm"));
  const proof = OtsFile.parse(new Uint8Array(fs.readFileSync(path.join(ROOT, "site/data/sample-clip.webm.ots"))));
  assert.equal(toHex(proof.digest), node("sha256", clip));
  const s = summarize(proof);
  assert.ok(s.pending.length + s.bitcoin.length >= 1);
  assert.deepEqual([...proof.serialize()], [...fs.readFileSync(path.join(ROOT, "site/data/sample-clip.webm.ots"))]);
});

test("damaged and foreign files are refused with a reason", () => {
  const { file, tip } = startProof(sha256(bytes("y")), crypto.randomBytes(16));
  tip.merge(Timestamp.fromBytes(calendarAnswer(tip.msg, "https://bob.btc.calendar.opentimestamps.org", "b"), tip.msg));
  const good = file.serialize();
  assert.throws(() => OtsFile.parse(bytes("not a proof at all, just some text")), /isn't an OpenTimestamps proof/);
  assert.throws(() => OtsFile.parse(good.subarray(0, good.length - 3)), /ends too early/);
  assert.throws(() => OtsFile.parse(Uint8Array.from([...good, 0])), /extra data/);
  const v2 = Uint8Array.from(good);
  v2[MAGIC.length] = 2;
  assert.throws(() => OtsFile.parse(v2), /version 2/);
  const badOp = Uint8Array.from(good);
  badOp[MAGIC.length + 2 + 32] = 0x67; // keccak256: not supported here
  assert.throws(() => OtsFile.parse(badOp), /doesn't support/);
  // A pending attestation with a URL outside the allowed alphabet.
  const evil = new Timestamp(new Uint8Array(32));
  evil.attestations.push({ tag: "83dfe30d2ef90c8e", kind: "pending", payload: Uint8Array.from([5, ...bytes("a b<c")]) });
  const evilFile = new OtsFile(OP.SHA256, new Uint8Array(32), evil).serialize();
  assert.throws(() => OtsFile.parse(evilFile), /invalid address/);
  // Nesting deeper than the reference limit.
  let deep = new Timestamp(new Uint8Array(1));
  const root = deep;
  for (let i = 0; i < 300; i++) deep = deep.add(OP.REVERSE);
  deep.attestations.push(pendingAttestation("https://bob.btc.calendar.opentimestamps.org"));
  assert.throws(() => OtsFile.parse(new OtsFile(OP.SHA256, new Uint8Array(32), Object.assign(root, { msg: new Uint8Array(32) })).serialize()), OtsError);
  assert.throws(() => applyOp(OP.APPEND, new Uint8Array(4097), new Uint8Array(1)), /too long/);
});

test("check links carry the proof and survive the round trip; damaged ones are explained", () => {
  const { file, tip } = startProof(sha256(bytes("clip")), crypto.randomBytes(16));
  tip.merge(Timestamp.fromBytes(calendarAnswer(tip.msg, "https://finney.calendar.eternitywall.com", "f"), tip.msg));
  const frag = linkFragment({ file, name: "My clip \u{1F3A5}.mp4", size: 123456789, stampedAt: Date.UTC(2026, 10, 22, 8, 0, 0) });
  const back = readFragment("#" + frag);
  assert.deepEqual([...back.file.serialize()], [...file.serialize()]);
  assert.equal(back.name, "My clip \u{1F3A5}.mp4");
  assert.equal(back.size, 123456789);
  assert.equal(back.stampedAt, Date.UTC(2026, 10, 22, 8, 0, 0));
  assert.throws(() => readFragment("v=1&h=00"), /doesn't contain a proof/);
  assert.throws(() => readFragment(frag.replace(/p=[^&]+/, "p=AAAA")), /damaged|cut short/);
  assert.throws(() => readFragment(frag.replace(/h=[0-9a-f]+/, "h=" + "0".repeat(64))), /inconsistent/);
  assert.throws(() => readFragment(frag.replace("v=1", "v=9")), /newer version/);
  assert.deepEqual([...fromBase64Url(toBase64Url(Uint8Array.from([0, 251, 255, 62, 63])))], [0, 251, 255, 62, 63]);
  assert.equal(cleanName("a\u0000b\n"), "a b");
  assert.equal(proofName('clip: "final"/v2.mp4'), "clip_ _final_v2.mp4.ots");
});

// ---------- the network code, against simulated calendars and explorers ----------

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () => (body instanceof Uint8Array ? body : bytes(String(body))).slice().buffer,
  text: async () => (body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body)),
});

test("stamping merges every calendar that answers and reports the ones that don't", async () => {
  const { file, tip } = startProof(sha256(bytes("stamp me")), crypto.randomBytes(16));
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith(STAMP_CALENDARS[1])) throw new TypeError("Failed to fetch");
    const uri = url.startsWith(STAMP_CALENDARS[0]) ? "https://alice.btc.calendar.opentimestamps.org" : "https://finney.calendar.eternitywall.com";
    return reply(200, calendarAnswer(init.body, uri, url));
  };
  const results = await submit(tip, { fetch: fakeFetch });
  assert.deepEqual(results.map((r) => r.ok), [true, false, true]);
  assert.equal(results[1].error, "Failed to fetch");
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.headers["Content-Type"], "application/x-www-form-urlencoded", "no CORS preflight");
    assert.deepEqual([...c.init.body], [...tip.msg], "only the blinded tip is sent");
    assert.ok(c.url.endsWith("/digest"));
  }
  assert.equal(summarize(OtsFile.parse(file.serialize())).pending.length, 2);
});

// A proof whose path ends exactly at a real block's Merkle root.
function proofToBlock(height) {
  const header = fromHex(HEADERS[height].header);
  const root = header.subarray(36, 68);
  const t = new Timestamp(Uint8Array.from(root));
  t.attestations.push({ tag: "0588960d73d71901", kind: "bitcoin", height: Number(height), payload: Uint8Array.from(varuint(Number(height))) });
  return new OtsFile(OP.SHA256, new Uint8Array(32), t);
}
function varuint(n) {
  const out = [];
  do {
    let c = n % 128;
    n = Math.floor(n / 128);
    if (n) c |= 0x80;
    out.push(c);
  } while (n);
  return out;
}
function explorers(headersByHeight, { broken = [], lie = null } = {}) {
  return async (url) => {
    const host = new URL(url).host;
    if (broken.includes(host)) throw new TypeError("Failed to fetch");
    const m = url.match(/block-height\/(\d+)$/);
    if (m) {
      // A lying explorer answers consistently, with another real block, for the height asked.
      if (lie && host === lie.host) return reply(200, headersByHeight[lie.height].hash);
      return headersByHeight[m[1]] ? reply(200, headersByHeight[m[1]].hash) : reply(404, "not found");
    }
    const h = url.match(/block\/([0-9a-f]{64})\/header$/);
    if (h) {
      if (lie && lie.garbled && host === lie.host) return reply(200, headersByHeight["428648"].header);
      const entry = Object.values(headersByHeight).find((x) => x.hash === h[1]);
      return entry ? reply(200, entry.header) : reply(404, "not found");
    }
    return reply(404, "not found");
  };
}

test("a block header is checked for real proof of work", () => {
  const h = readHeader(fromHex(HEADERS["358391"].header));
  assert.equal(h.hash, HEADERS["358391"].hash);
  assert.equal(h.time, 1432827678);
  assert.ok(h.work && h.enoughWork);
  const easy = fromHex(HEADERS["358391"].header);
  easy.set([0xff, 0xff, 0x00, 0x21], 72); // bits so easy that any hash passes, as a forger would choose
  assert.equal(readHeader(easy).enoughWork, false);
});

test("a complete proof is verified against the block header from both explorers", async () => {
  const proof = proofToBlock("358391");
  const v = await verifyFile(proof, { fetch: explorers(HEADERS) });
  assert.equal(v.earliest.ok, true);
  assert.equal(v.earliest.time, 1432827678);
  assert.equal(v.earliest.height, 358391);
  assert.deepEqual(v.earliest.explorers, ["Blockstream", "mempool.space"]);
  const one = await verifyFile(proof, { fetch: explorers(HEADERS, { broken: ["mempool.space"] }) });
  assert.deepEqual(one.earliest.explorers, ["Blockstream"]);
});

test("wrong blocks, lying or unreachable explorers never verify", async () => {
  const proof = proofToBlock("358391");
  const wrongHeight = summarize(proof).bitcoin[0];
  const r1 = await verifyBitcoin(wrongHeight.msg, 428648, { fetch: explorers(HEADERS) });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "mismatch");
  // Explorers that disagree: refuse, rather than pick one.
  const r2 = await verifyBitcoin(wrongHeight.msg, 358391, { fetch: explorers(HEADERS, { lie: { host: "mempool.space", height: "428648" } }) });
  assert.deepEqual([r2.ok, r2.reason], [false, "disagree"]);
  // An explorer whose header doesn't match the hash it gave is ignored; the honest one decides.
  const r2b = await verifyBitcoin(wrongHeight.msg, 358391, { fetch: explorers(HEADERS, { lie: { host: "mempool.space", height: "358391", garbled: true } }) });
  assert.equal(r2b.ok, true);
  const r3 = await verifyBitcoin(wrongHeight.msg, 358391, { fetch: explorers(HEADERS, { broken: ["blockstream.info", "mempool.space"] }) });
  assert.deepEqual([r3.ok, r3.reason], [false, "unreachable"]);
});

test("upgrading asks only known calendars and merges a Bitcoin path when one is ready", async () => {
  const { file, tip } = startProof(sha256(bytes("pending")), crypto.randomBytes(16));
  tip.merge(Timestamp.fromBytes(calendarAnswer(tip.msg, "https://alice.btc.calendar.opentimestamps.org", "a"), tip.msg));
  tip.merge(Timestamp.fromBytes(calendarAnswer(tip.msg, "https://calendar.example.com", "x"), tip.msg));
  const asked = [];
  const notReady = async (url) => {
    asked.push(url);
    throw new TypeError("Failed to fetch"); // what a browser sees for "not ready yet"
  };
  const r = await upgrade(file, { fetch: notReady });
  assert.deepEqual([r.asked, r.upgraded, r.skipped], [1, 0, ["https://calendar.example.com"]]);
  assert.ok(asked[0].startsWith("https://alice.btc.calendar.opentimestamps.org/timestamp/"));
  // Now the calendar has an answer leading to a block.
  const pendingMsg = summarize(file).pending.find((p) => p.uri.includes("alice")).msg;
  const answer = new Timestamp(pendingMsg);
  answer.add(OP.SHA256).attestations.push({ tag: "0588960d73d71901", kind: "bitcoin", height: 900000, payload: Uint8Array.from(varuint(900000)) });
  const ready = async () => reply(200, new OtsFile(OP.SHA256, new Uint8Array(32), answer).serialize().subarray(MAGIC.length + 2 + 32));
  const r2 = await upgrade(file, { fetch: ready });
  assert.equal(r2.upgraded, 1);
  assert.deepEqual(summarize(OtsFile.parse(file.serialize())).bitcoin.map((b) => b.height), [900000]);
});

test("an exported list of stamps imports again, and junk in it is dropped", async () => {
  const { exportList, validStamps } = await import("../../site/assets/proofs.js");
  const { file, tip } = startProof(sha256(bytes("moving")), crypto.randomBytes(16));
  tip.merge(Timestamp.fromBytes(calendarAnswer(tip.msg, "https://bob.btc.calendar.opentimestamps.org", "b"), tip.msg));
  const good = { id: "0123456789abcdef", name: "clip.mp4", size: 10, type: "video/mp4", sha256: "ignored", stampedAt: 1763800000000, ots: toBase64Url(file.serialize()) };
  const text = exportList([good, { id: "zz", ots: "AAAA" }, { id: "fedcba9876543210", ots: "AAAA" }, null]);
  const back = validStamps(text);
  assert.equal(back.length, 1);
  assert.equal(back[0].sha256, toHex(file.digest), "the fingerprint comes from the proof, not the file's claim");
  assert.equal(back[0].ots, good.ots);
  assert.throws(() => validStamps("{}"), /isn't an exported list/);
  assert.throws(() => validStamps("not json"), /isn't an exported list/);
});
