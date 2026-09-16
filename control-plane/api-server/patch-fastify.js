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
code = code.slice(0, funcStart) + patched + code.slice(funcEnd);
fs.writeFileSync(filePath, code);
console.log('Patched safeWriteHead in fastify/lib/reply.js (' + patched.length + ' bytes)');
