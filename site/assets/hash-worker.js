// Hashes a file in pieces off the main thread, so a multi-gigabyte video doesn't freeze the page.
// Receives { file }, posts { progress } now and then and finally { digest } (hex) or { error }.
import { Sha256, toHex } from "./hashes.js";

const CHUNK = 8 * 1024 * 1024;

self.onmessage = async (e) => {
  const { file } = e.data;
  try {
    const s = new Sha256();
    for (let off = 0; off < file.size; off += CHUNK) {
      s.update(new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer()));
      self.postMessage({ progress: Math.min(1, (off + CHUNK) / file.size) });
    }
    self.postMessage({ digest: toHex(s.digest()) });
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
