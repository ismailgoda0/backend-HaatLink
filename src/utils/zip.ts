import fs from 'fs';
import type { Response } from 'express';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? ((c >>> 1) ^ 0xedb88320) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32Update(crc: number, data: Buffer) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(ms: number) {
  const d = new Date(ms);
  const year = Math.max(1980, Math.min(2107, d.getFullYear()));
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export async function streamZip(items: { path: string; name: string }[], res: Response) {
  const central: Buffer[] = [];
  let offset = 0;
  const write = async (buf: Buffer) => {
    if (!res.write(buf)) await new Promise<void>((resolve) => res.once('drain', resolve));
  };

  for (const item of items) {
    const name = Buffer.from(item.name, 'utf8');
    const st = fs.statSync(item.path);
    const dt = dosDateTime(st.mtimeMs);
    const local = Buffer.alloc(30 + name.length);
    let o = 0;
    local.writeUInt32LE(0x04034b50, o); o += 4;
    local.writeUInt16LE(20, o); o += 2;
    local.writeUInt16LE(0x0808, o); o += 2;
    local.writeUInt16LE(0, o); o += 2;
    local.writeUInt16LE(dt.time, o); o += 2;
    local.writeUInt16LE(dt.date, o); o += 2;
    local.writeUInt32LE(0, o); o += 4;
    local.writeUInt32LE(0, o); o += 4;
    local.writeUInt32LE(0, o); o += 4;
    local.writeUInt16LE(name.length, o); o += 2;
    local.writeUInt16LE(0, o); o += 2;
    name.copy(local, o);
    await write(local);

    const localOffset = offset;
    offset += local.length;
    let crc = 0;
    let size = 0;
    const stream = fs.createReadStream(item.path);
    for await (const chunk of stream as any) {
      const b = Buffer.from(chunk);
      crc = crc32Update(crc, b);
      size += b.length;
      await write(b);
      offset += b.length;
    }

    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(size, 8);
    desc.writeUInt32LE(size, 12);
    await write(desc);
    offset += 16;

    const c = Buffer.alloc(46 + name.length);
    o = 0;
    c.writeUInt32LE(0x02014b50, o); o += 4;
    c.writeUInt16LE(20, o); o += 2;
    c.writeUInt16LE(20, o); o += 2;
    c.writeUInt16LE(0x0808, o); o += 2;
    c.writeUInt16LE(0, o); o += 2;
    c.writeUInt16LE(dt.time, o); o += 2;
    c.writeUInt16LE(dt.date, o); o += 2;
    c.writeUInt32LE(crc, o); o += 4;
    c.writeUInt32LE(size, o); o += 4;
    c.writeUInt32LE(size, o); o += 4;
    c.writeUInt16LE(name.length, o); o += 2;
    c.writeUInt16LE(0, o); o += 2;
    c.writeUInt16LE(0, o); o += 2;
    c.writeUInt16LE(0, o); o += 2;
    c.writeUInt16LE(0, o); o += 2;
    c.writeUInt32LE(0, o); o += 4;
    c.writeUInt32LE(localOffset, o); o += 4;
    name.copy(c, o);
    central.push(c);
  }

  const centralStart = offset;
  for (const c of central) { await write(c); offset += c.length; }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  await write(end);
  res.end();
}
