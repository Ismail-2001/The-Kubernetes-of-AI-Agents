const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'node_modules', 'fastify', 'lib', 'reply.js');
let code = fs.readFileSync(filePath, 'utf8');
const needle = 'function safeWriteHead (reply, statusCode) {';
const idx = code.indexOf(needle);
if (idx === -1) { console.error('safeWriteHead not found'); process.exit(1); }
const funcStart = idx;
let depth = 0;
let funcEnd = funcStart;
for (let i = funcStart; i < code.length; i++) {
  if (code[i] === '{') depth++;
  if (code[i] === '}') { depth--; if (depth === 0) { funcEnd = i + 1; break; } }
}
const patched = `function safeWriteHead (reply, statusCode) {
  if (reply.raw.headersSent) return;
  const res = reply.raw
  try {
    res.writeHead(statusCode, reply[kReplyHeaders])
  } catch (err) {
    if (err.code === 'ERR_HTTP_HEADERS_SENT') { return; }
    throw err
  }
}`;

const writeNeedle = 'function writePayload (payload, res, reply) {';
const writeIdx = code.indexOf(writeNeedle);
if (writeIdx !== -1) {
  let wDepth = 0, wEnd = writeIdx;
  for (let i = writeIdx; i < code.length; i++) {
    if (code[i] === '{') wDepth++;
    if (code[i] === '}') { wDepth--; if (wDepth === 0) { wEnd = i + 1; break; } }
  }
  const writePatched = `function writePayload (payload, res, reply) {
  if (res.writableEnded || res.destroyed) return;
  try {
    if (!isHttp2Reply(reply) || Buffer.byteLength(payload) <= HTTP2_WRITE_CHUNK_SIZE) {
      res.write(payload)
      sendTrailer(payload, res, reply)
      return
    }
    writeHttp2Payload(payload, res, () => {
      sendTrailer(payload, res, reply)
    })
  } catch (err) {
    if (err.code === 'ERR_STREAM_WRITE_AFTER_END' || err.code === 'ERR_HTTP_HEADERS_SENT') {
      return;
    }
    throw err;
  }
}`;
  code = code.slice(0, writeIdx) + writePatched + code.slice(wEnd);
  console.log('Patched writePayload in fastify/lib/reply.js');
}
code = code.slice(0, funcStart) + patched + code.slice(funcEnd);
fs.writeFileSync(filePath, code);
console.log('Patched safeWriteHead in fastify/lib/reply.js (' + patched.length + ' bytes)');
