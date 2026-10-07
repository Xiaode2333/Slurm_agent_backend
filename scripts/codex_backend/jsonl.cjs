'use strict';
const { StringDecoder } = require('node:string_decoder');
// JSONL splits on LF only, preserving Unicode separators and split UTF-8.
function consumeJsonl(stream, onRecord, onError, maxBytes = 64 * 1024 * 1024) {
  const decoder = new StringDecoder('utf8'); let buffer = '';
  const consume = () => {
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line) onRecord(JSON.parse(line));
    }
    if (Buffer.byteLength(buffer) > maxBytes) throw new Error('JSONL record exceeds size limit');
  };
  stream.on('data', chunk => { try { buffer += decoder.write(chunk); consume(); } catch (error) { onError(error); } });
  stream.on('end', () => { try { buffer += decoder.end(); consume(); if (buffer.trim()) throw new Error('Incomplete final JSONL record'); } catch (error) { onError(error); } });
  stream.on('error', onError);
}
module.exports = { consumeJsonl };
