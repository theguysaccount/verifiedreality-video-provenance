// OpenTimestamps proofs (.ots files): reading, writing, merging and evaluating them.
// Follows the reference implementation (python-opentimestamps) byte for byte, including the
// order in which branches and attestations are written, so proofs made here open in the official
// `ots` client and proofs made there open here. No DOM and no network.
import { sha256, sha1, ripemd160, toHex, fromHex } from "./hashes.js";

export const MAGIC = fromHex("004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294");
export const MAJOR_VERSION = 1;
export const OP = Object.freeze({ SHA1: 0x02, RIPEMD160: 0x03, SHA256: 0x08, APPEND: 0xf0, PREPEND: 0xf1, REVERSE: 0xf2, HEXLIFY: 0xf3 });
const OP_NAME = { 0x02: "sha1", 0x03: "ripemd160", 0x08: "sha256", 0xf0: "append", 0xf1: "prepend", 0xf2: "reverse", 0xf3: "hexlify" };
const DIGEST_LEN = { 0x02: 20, 0x03: 20, 0x08: 32 };
export const ATTESTATION = Object.freeze({
  PENDING: "83dfe30d2ef90c8e",
  BITCOIN: "0588960d73d71901",
  LITECOIN: "06869a0d73d71b45",
  ETHEREUM: "30fe8087b5c7ead7",
});
const LIMITS = { msg: 4096, uri: 1000, payload: 8192, depth: 256, file: 1_000_000, height: 0xffffffff };
const URI_CHARS = /^[A-Za-z0-9\-._/:]+$/;

export class OtsError extends Error {}

// ---------- bytes ----------

const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

export const equalBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.i = 0;
  }

  read(n) {
    if (this.i + n > this.b.length) throw new OtsError("The proof file ends too early: it is incomplete or damaged.");
    const v = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return v;
  }

  byte() {
    return this.read(1)[0];
  }

  varuint() {
    let v = 0;
    let mul = 1;
    for (;;) {
      const c = this.byte();
      v += (c & 0x7f) * mul;
      if (!(c & 0x80)) break;
      mul *= 128;
      if (mul > 2 ** 49) throw new OtsError("The proof file contains a number that is too large.");
    }
    return v;
  }

  varbytes(max) {
    const n = this.varuint();
    if (n > max) throw new OtsError("The proof file contains a field that is too long.");
    return this.read(n);
  }
}

class Writer {
  constructor() {
    this.parts = [];
    this.length = 0;
  }

  bytes(b) {
    this.parts.push(b instanceof Uint8Array ? b : Uint8Array.from(b));
    this.length += b.length;
    return this;
  }

  varuint(n) {
    const out = [];
    do {
      let c = n % 128;
      n = Math.floor(n / 128);
      if (n) c |= 0x80;
      out.push(c);
    } while (n);
    return this.bytes(out);
  }

  varbytes(b) {
    return this.varuint(b.length).bytes(b);
  }

  out() {
    const all = new Uint8Array(this.length);
    let at = 0;
    for (const p of this.parts) {
      all.set(p, at);
      at += p.length;
    }
    return all;
  }
}

// ---------- operations ----------

export function applyOp(tag, arg, msg) {
  if (msg.length > LIMITS.msg) throw new OtsError("A message in the proof is too long.");
  let out;
  switch (tag) {
    case OP.SHA256: out = sha256(msg); break;
    case OP.SHA1: out = sha1(msg); break;
    case OP.RIPEMD160: out = ripemd160(msg); break;
    case OP.APPEND: out = concat(msg, arg); break;
    case OP.PREPEND: out = concat(arg, msg); break;
    case OP.REVERSE: out = Uint8Array.from(msg).reverse(); break;
    case OP.HEXLIFY: out = new TextEncoder().encode(toHex(msg)); break;
    default: throw new OtsError(`The proof uses an operation this page doesn't support (0x${tag.toString(16)}).`);
  }
  if (out.length > LIMITS.msg) throw new OtsError("A message in the proof is too long.");
  return out;
}

const hasArg = (tag) => tag === OP.APPEND || tag === OP.PREPEND;
const opKey = (tag, arg) => `${tag.toString(16).padStart(2, "0")}:${toHex(arg)}`;

export function describeOp(tag, arg) {
  return hasArg(tag) ? `${OP_NAME[tag]} ${toHex(arg)}` : OP_NAME[tag];
}

// ---------- attestations ----------

function readAttestation(r) {
  const tag = toHex(r.read(8));
  const payload = r.varbytes(LIMITS.payload);
  const a = { tag, payload };
  const p = new Reader(payload);
  if (tag === ATTESTATION.PENDING) {
    const uri = new TextDecoder().decode(p.varbytes(LIMITS.uri));
    if (!URI_CHARS.test(uri)) throw new OtsError("The proof names a calendar with an invalid address.");
    a.kind = "pending";
    a.uri = uri;
  } else if (tag === ATTESTATION.BITCOIN || tag === ATTESTATION.LITECOIN || tag === ATTESTATION.ETHEREUM) {
    a.kind = { [ATTESTATION.BITCOIN]: "bitcoin", [ATTESTATION.LITECOIN]: "litecoin", [ATTESTATION.ETHEREUM]: "ethereum" }[tag];
    a.height = p.varuint();
    if (a.height > LIMITS.height) throw new OtsError("The proof names an impossible block height.");
  } else {
    a.kind = "unknown";
  }
  if (a.kind !== "unknown" && p.i !== payload.length) throw new OtsError("The proof contains an attestation with extra data.");
  return a;
}

export function pendingAttestation(uri) {
  if (!URI_CHARS.test(uri) || uri.length > LIMITS.uri) throw new OtsError("invalid calendar address");
  const payload = new Writer().varbytes(new TextEncoder().encode(uri)).out();
  return { tag: ATTESTATION.PENDING, payload, kind: "pending", uri };
}

function compareAttestations(a, b) {
  if (a.tag !== b.tag) return a.tag < b.tag ? -1 : 1;
  if (a.kind === "pending") return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
  if (a.kind === "bitcoin" || a.kind === "litecoin" || a.kind === "ethereum") return a.height - b.height;
  return compareBytes(a.payload, b.payload);
}

const sameAttestation = (a, b) => a.tag === b.tag && equalBytes(a.payload, b.payload);

// ---------- the timestamp tree ----------

export class Timestamp {
  constructor(msg) {
    this.msg = msg;
    this.attestations = [];
    this.ops = new Map(); // key -> { tag, arg, stamp }
  }

  static parse(r, msg, depth = 0) {
    if (depth > LIMITS.depth) throw new OtsError("The proof is nested too deeply.");
    const stamp = new Timestamp(msg);
    const one = (tag) => {
      if (tag === 0x00) {
        const a = readAttestation(r);
        if (!stamp.attestations.some((x) => sameAttestation(x, a))) stamp.attestations.push(a);
        return;
      }
      if (!(tag in OP_NAME)) throw new OtsError(`The proof uses an operation this page doesn't support (0x${tag.toString(16)}).`);
      const arg = hasArg(tag) ? r.varbytes(LIMITS.msg) : new Uint8Array(0);
      if (hasArg(tag) && arg.length === 0) throw new OtsError("The proof contains an empty append or prepend.");
      const child = Timestamp.parse(r, applyOp(tag, arg, msg), depth + 1);
      const key = opKey(tag, arg);
      if (stamp.ops.has(key)) stamp.ops.get(key).stamp.merge(child);
      else stamp.ops.set(key, { tag, arg, stamp: child });
    };
    let tag = r.byte();
    while (tag === 0xff) {
      one(r.byte());
      tag = r.byte();
    }
    one(tag);
    return stamp;
  }

  /** Parse the bytes a calendar returns: a timestamp that starts from `msg`. */
  static fromBytes(bytes, msg) {
    const r = new Reader(bytes);
    const stamp = Timestamp.parse(r, msg);
    if (r.i !== bytes.length) throw new OtsError("The calendar's answer has extra data after the timestamp.");
    return stamp;
  }

  /** The child reached by applying an operation, created if it isn't there. */
  add(tag, arg = new Uint8Array(0)) {
    const key = opKey(tag, arg);
    if (!this.ops.has(key)) this.ops.set(key, { tag, arg, stamp: new Timestamp(applyOp(tag, arg, this.msg)) });
    return this.ops.get(key).stamp;
  }

  merge(other) {
    if (!equalBytes(this.msg, other.msg)) throw new OtsError("Can't merge timestamps for different messages.");
    for (const a of other.attestations) if (!this.attestations.some((x) => sameAttestation(x, a))) this.attestations.push(a);
    for (const [key, op] of other.ops) {
      if (this.ops.has(key)) this.ops.get(key).stamp.merge(op.stamp);
      else this.ops.set(key, op);
    }
  }

  serialize(w) {
    if (!this.attestations.length && !this.ops.size) throw new OtsError("An empty timestamp can't be written.");
    const atts = [...this.attestations].sort(compareAttestations);
    const writeAtt = (a) => w.bytes([0x00]).bytes(fromHex(a.tag)).varbytes(a.payload);
    for (const a of atts.slice(0, -1)) {
      w.bytes([0xff]);
      writeAtt(a);
    }
    const ops = [...this.ops.values()].sort((x, y) => x.tag - y.tag || compareBytes(x.arg, y.arg));
    if (!ops.length) {
      writeAtt(atts[atts.length - 1]);
      return;
    }
    if (atts.length) {
      w.bytes([0xff]);
      writeAtt(atts[atts.length - 1]);
    }
    ops.forEach((op, i) => {
      if (i < ops.length - 1) w.bytes([0xff]);
      w.bytes([op.tag]);
      if (hasArg(op.tag)) w.varbytes(op.arg);
      op.stamp.serialize(w);
    });
  }

  /** Every attestation in the tree with the message it attests: [{ msg, attestation, path }]. */
  all(path = []) {
    const out = this.attestations.map((attestation) => ({ msg: this.msg, attestation, path }));
    for (const op of this.ops.values()) out.push(...op.stamp.all([...path, describeOp(op.tag, op.arg)]));
    return out;
  }

  /** The node whose message is `msg`, searching the whole tree. */
  find(msg) {
    if (equalBytes(this.msg, msg)) return this;
    for (const op of this.ops.values()) {
      const hit = op.stamp.find(msg);
      if (hit) return hit;
    }
    return null;
  }
}

// ---------- detached proof files ----------

export class OtsFile {
  constructor(hashOp, digest, timestamp) {
    this.hashOp = hashOp;
    this.digest = digest;
    this.timestamp = timestamp;
  }

  static parse(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length > LIMITS.file) throw new OtsError("This file is too large to be a timestamp proof.");
    if (bytes.length < MAGIC.length || !equalBytes(bytes.subarray(0, MAGIC.length), MAGIC)) {
      throw new OtsError("This isn't an OpenTimestamps proof. Proof files end in .ots.");
    }
    const r = new Reader(bytes);
    r.read(MAGIC.length);
    const major = r.varuint();
    if (major !== MAJOR_VERSION) throw new OtsError(`This proof uses version ${major} of the format, which this page doesn't read.`);
    const hashOp = r.byte();
    if (!(hashOp in DIGEST_LEN)) throw new OtsError("This proof uses a file hash this page doesn't support.");
    const digest = Uint8Array.from(r.read(DIGEST_LEN[hashOp]));
    const timestamp = Timestamp.parse(r, digest);
    if (r.i !== bytes.length) throw new OtsError("The proof file has extra data at the end: it may be damaged.");
    return new OtsFile(hashOp, digest, timestamp);
  }

  serialize() {
    const w = new Writer().bytes(MAGIC).varuint(MAJOR_VERSION).bytes([this.hashOp]).bytes(this.digest);
    this.timestamp.serialize(w);
    return w.out();
  }

  get hashName() {
    return OP_NAME[this.hashOp];
  }
}

/** A new proof for a file digest: digest -> append(nonce) -> sha256 = the value sent to calendars. */
export function startProof(digest, nonce) {
  if (digest.length !== 32) throw new OtsError("expected a SHA-256 digest");
  const file = new OtsFile(OP.SHA256, digest, new Timestamp(digest));
  const tip = file.timestamp.add(OP.APPEND, nonce).add(OP.SHA256);
  return { file, tip };
}

/** Summary of a proof: what's pending where, and which block attestations it holds. */
export function summarize(file) {
  const all = file.timestamp.all();
  return {
    pending: all.filter((x) => x.attestation.kind === "pending").map((x) => ({ uri: x.attestation.uri, msg: x.msg })),
    bitcoin: all.filter((x) => x.attestation.kind === "bitcoin").map((x) => ({ height: x.attestation.height, msg: x.msg, path: x.path })),
    other: all.filter((x) => !["pending", "bitcoin"].includes(x.attestation.kind)).map((x) => x.attestation.kind),
  };
}
