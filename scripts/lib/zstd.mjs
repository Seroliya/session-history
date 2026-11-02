// Zstandard decoding for session stores.
//
// DSH appends one zstd frame per write, so a session file is many concatenated
// frames and the last one may still be incomplete while the session is live.
// Node's zstdDecompressSync stops after the first frame, so frames are split
// here by walking frame/block headers (RFC 8878) and decoded one at a time.
// Native zlib zstd (Node >= 22.15) is used when present; otherwise the vendored
// pure-JS fzstd decoder.
import zlib from 'node:zlib';
import fs from 'node:fs';
import { decompress as fzDecompress } from '../vendor/fzstd.mjs';

const MAGIC = 0xfd2fb528;
const HAS_NATIVE = typeof zlib.zstdDecompressSync === 'function';

export function splitFrames(buf) {
  const frames = [];
  const n = buf.length;
  let pos = 0;
  let truncated = false;
  while (pos + 4 <= n) {
    const magic = buf.readUInt32LE(pos);
    if ((magic & 0xfffffff0) >>> 0 === 0x184d2a50) {
      // Skippable frame.
      if (pos + 8 > n) { truncated = true; break; }
      const size = buf.readUInt32LE(pos + 4);
      if (pos + 8 + size > n) { truncated = true; break; }
      pos += 8 + size;
      continue;
    }
    if (magic !== MAGIC) { truncated = true; break; }
    const start = pos;
    let p = pos + 4;
    if (p >= n) { truncated = true; break; }
    const fhd = buf[p++];
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    p += (single ? 0 : 1) + [0, 1, 2, 4][dictFlag] + (fcsFlag === 0 ? single : [0, 2, 4, 8][fcsFlag]);
    let ok = true;
    let last = 0;
    while (!last) {
      if (p + 3 > n) { ok = false; break; }
      const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      last = h & 1;
      const type = (h >> 1) & 3;
      if (type === 3) { ok = false; break; }
      p += 3 + (type === 1 ? 1 : h >>> 3);
      if (p > n) { ok = false; break; }
    }
    if (ok && checksum) {
      p += 4;
      if (p > n) ok = false;
    }
    if (!ok) { truncated = true; break; }
    frames.push(buf.subarray(start, p));
    pos = p;
  }
  return { frames, truncated };
}

function decodeFrame(frame) {
  if (HAS_NATIVE) {
    try { return zlib.zstdDecompressSync(frame); } catch { /* fall through to fzstd */ }
  }
  return Buffer.from(fzDecompress(frame));
}

export function zstdDecompressAll(buf) {
  const { frames, truncated } = splitFrames(buf);
  const out = [];
  let corrupt = false;
  for (const f of frames) {
    try { out.push(decodeFrame(f)); } catch { corrupt = true; break; }
  }
  return { data: Buffer.concat(out), truncated: truncated || corrupt, frames: frames.length };
}

export function readSessionText(file) {
  const buf = fs.readFileSync(file);
  if (/\.zstd?$/i.test(file)) {
    const { data, truncated } = zstdDecompressAll(buf);
    return { text: data.toString('utf8'), truncated };
  }
  return { text: buf.toString('utf8'), truncated: false };
}

export const zstdBackend = HAS_NATIVE ? 'node-zlib' : 'fzstd';
