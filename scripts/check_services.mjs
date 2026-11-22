// Health of the outside services the site depends on, checked from Node with the site's own code:
//   node scripts/check_services.mjs
// 1. Every stamping calendar accepts a fresh random digest (fails if fewer than MIN_CALENDARS do).
// 2. A calendar still serves the finished path for an old commitment (the upgrade route works).
// 3. Both block explorers serve a header that verifies (proof of work, Merkle root, agreement).
import crypto from "node:crypto";
import { startProof, summarize, Timestamp } from "../site/assets/ots.js";
import { submit, verifyBitcoin, STAMP_CALENDARS, EXPLORERS } from "../site/assets/net.js";
import { fromHex } from "../site/assets/hashes.js";

const MIN_CALENDARS = Number(process.env.MIN_CALENDARS || 2);
const problems = [];
const warnings = [];

// 1. stamping
const { tip } = startProof(crypto.randomBytes(32), crypto.randomBytes(16));
const results = await submit(tip);
for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} stamp at ${r.calendar}${r.ok ? "" : `: ${r.error}`}`);
const ok = results.filter((r) => r.ok).length;
if (ok < MIN_CALENDARS) problems.push(`only ${ok} of ${STAMP_CALENDARS.length} calendars accepted a stamp (need ${MIN_CALENDARS})`);
else if (ok < STAMP_CALENDARS.length) warnings.push(`${STAMP_CALENDARS.length - ok} calendar(s) refused a stamp`);

// 2. upgrading: this commitment was anchored at alice in 2016 (the OpenTimestamps client's own example).
const CANARY = { uri: "https://alice.btc.calendar.opentimestamps.org", msg: "57cfa5c46716df9bd9e83595bce439c58108d8fcc1678f30d4c6731c3f1fa6c79ed712c66fb1ac8d4e4eb0e7" };
try {
  const res = await fetch(`${CANARY.uri}/timestamp/${CANARY.msg}`, { headers: { Accept: "application/vnd.opentimestamps.v1" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const t = Timestamp.fromBytes(new Uint8Array(await res.arrayBuffer()), fromHex(CANARY.msg));
  const btc = t.all().filter((x) => x.attestation.kind === "bitcoin");
  if (!btc.length) throw new Error("no Bitcoin attestation in the answer");
  const v = await verifyBitcoin(btc[0].msg, btc[0].attestation.height);
  if (!v.ok) throw new Error(`the path doesn't verify: ${v.reason} ${v.detail || ""}`);
  console.log(`ok   upgrade route at ${CANARY.uri}: block ${v.height}, verified via ${v.explorers.join(" + ")}`);
  if (v.explorers.length < EXPLORERS.length) warnings.push(`only ${v.explorers.join(", ")} answered for block headers`);
} catch (e) {
  problems.push(`upgrade route: ${e.message}`);
  console.log(`FAIL upgrade route: ${e.message}`);
}

for (const w of warnings) console.log(`::warning::${w}`);
for (const p of problems) console.log(`::error::${p}`);
process.exit(problems.length ? 1 : 0);
