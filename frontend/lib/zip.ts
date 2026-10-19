// A zip file made in the browser, with no library: the files are stored as they are (no compression), which is fine for
// notes that are text of a few kilobytes each, and every zip program, and Notion's import, reads it.

export interface ZipEntry {
  // The path inside the zip, with "/" between folders.
  name: string;
  data: Uint8Array | string;
}

const encoder = new TextEncoder();

let table: Uint32Array | null = null;

// The CRC-32 of some bytes (what a zip keeps to check each file).
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A zip keeps the time as two 16-bit numbers in the local time of whoever made it.
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export const MAX_ZIP_ENTRIES = 65_535;
// What one zip may hold in all (the format has bigger limits; a library of notes is nowhere near this).
export const MAX_ZIP_BYTES = 512 * 1024 * 1024;

export class ZipTooBigError extends Error {}

export function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Uint8Array<ArrayBuffer> {
  if (entries.length > MAX_ZIP_ENTRIES) throw new ZipTooBigError("too many files");
  const stamp = dosDateTime(now);
  const files = entries.map((entry) => {
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    return { name: encoder.encode(entry.name), data, crc: crc32(data) };
  });
  let size = 22;
  for (const f of files) size += 30 + f.name.length + f.data.length + 46 + f.name.length;
  if (size > MAX_ZIP_BYTES) throw new ZipTooBigError("too big");

  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  const u16 = (value: number) => {
    view.setUint16(at, value, true);
    at += 2;
  };
  const u32 = (value: number) => {
    view.setUint32(at, value >>> 0, true);
    at += 4;
  };
  const bytes = (value: Uint8Array) => {
    out.set(value, at);
    at += value.length;
  };

  for (const f of files) {
    offsets.push(at);
    u32(0x04034b50); // local file header
    u16(20); // needs version 2.0
    u16(0x0800); // names are UTF-8
    u16(0); // stored
    u16(stamp.time);
    u16(stamp.date);
    u32(f.crc);
    u32(f.data.length);
    u32(f.data.length);
    u16(f.name.length);
    u16(0);
    bytes(f.name);
    bytes(f.data);
  }
  const directoryStart = at;
  files.forEach((f, i) => {
    u32(0x02014b50); // central directory entry
    u16(20);
    u16(20);
    u16(0x0800);
    u16(0);
    u16(stamp.time);
    u16(stamp.date);
    u32(f.crc);
    u32(f.data.length);
    u32(f.data.length);
    u16(f.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32(0); // external attributes
    u32(offsets[i]);
    bytes(f.name);
  });
  const directorySize = at - directoryStart;
  u32(0x06054b50); // end of central directory
  u16(0);
  u16(0);
  u16(files.length);
  u16(files.length);
  u32(directorySize);
  u32(directoryStart);
  u16(0);
  return out;
}
