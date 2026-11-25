// Minimal ZIP reader (enough for .docx files). No dependencies.
const zlib = require('zlib');

function unzip(buf) {
  const out = {};
  const sig = Buffer.from([0x50, 0x4b, 5, 6]);
  const eocd = buf.lastIndexOf(sig);
  if (eocd < 0) throw new Error('Not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const lName = buf.readUInt16LE(localOff + 26);
    const lExtra = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lName + lExtra;
    const data = buf.slice(start, start + csize);
    out[name] = () => (method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { unzip };
