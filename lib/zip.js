'use strict';
/**
 * lib/zip.js — 最小 ZIP 写入器（Store 无压缩 + CRC32）
 * 零依赖，用于导出比赛复盘包。
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * 生成 ZIP 文件 Buffer。
 * @param {Array<{name:string, data:Buffer|string}>} files
 * @returns {Buffer}
 */
function makeZip(files) {
  const enc = (s) => Buffer.from(s, 'utf8');
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = enc(f.name);
    const data = Buffer.isBuffer(f.data) ? f.data : enc(String(f.data));
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);          // signature
    localHeader.writeUInt16LE(20, 4);                  // version needed
    localHeader.writeUInt16LE(0x0800, 6);              // flags: UTF-8 names
    localHeader.writeUInt16LE(0, 8);                   // method: store
    localHeader.writeUInt16LE(0, 10);                  // mod time
    localHeader.writeUInt16LE(0, 12);                  // mod date
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);        // compressed size
    localHeader.writeUInt32LE(data.length, 22);        // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);                  // extra len

    chunks.push(localHeader, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);                   // signature
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);                           // method
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(offset, 42);                      // local header offset

    central.push(cd, nameBuf);
    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);                   // signature
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, ...central, eocd]);
}

module.exports = { makeZip, crc32 };
