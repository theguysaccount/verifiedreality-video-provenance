// Completes the site's sample proof once its calendars have anchored it in Bitcoin.
//   node scripts/complete_sample.mjs   -> prints "changed" and rewrites the .ots when it completes
// Safe to run any time: a complete proof is left alone, a pending one that isn't ready is left alone.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OtsFile, summarize } from "../site/assets/ots.js";
import { upgrade, verifyFile } from "../site/assets/net.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = path.join(ROOT, "site", "data", "sample-clip.webm.ots");
const proof = OtsFile.parse(new Uint8Array(fs.readFileSync(file)));
if (summarize(proof).bitcoin.length) {
  console.log("sample proof is already complete");
  process.exit(0);
}
const r = await upgrade(proof);
if (!r.upgraded) {
  console.log(`sample proof still pending (asked ${r.asked} calendars)`);
  process.exit(0);
}
const v = await verifyFile(proof);
if (!v.earliest) {
  console.log(`::error::the calendars' answer for the sample doesn't verify: ${JSON.stringify(v.results)}`);
  process.exit(1);
}
fs.writeFileSync(file, proof.serialize());
console.log(`changed: sample proof complete, Bitcoin block ${v.earliest.height} at ${new Date(v.earliest.time * 1000).toISOString()}`);
