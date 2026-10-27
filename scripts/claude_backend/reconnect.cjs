'use strict';
const crypto = require('node:crypto');

// Per-wrapper transport state, not native history. Bounded replay never guesses
// across a lost byte range and numbered input is delivered to native stdin once.
function createReconnect(limit = 4 * 1024 * 1024) {
  let sequence = 0, floor = 0, bytes = 0, inputSequence = 0;
  const frames = [];
  const integer = n => Number.isSafeInteger(n) && n >= 0;
  return {
    token: crypto.randomBytes(32).toString('hex'),
    output(frame) {
      const value = { ...frame, seq: ++sequence };
      const size = Buffer.byteLength(JSON.stringify(value));
      frames.push({ value, size }); bytes += size;
      while (bytes > limit && frames.length) { const old = frames.shift(); bytes -= old.size; floor = old.value.seq; }
      return value;
    },
    acknowledge(seq) {
      if (!integer(seq) || seq > sequence) throw new Error('Invalid output acknowledgement');
      while (frames.length && frames[0].value.seq <= seq) { const old = frames.shift(); bytes -= old.size; floor = old.value.seq; }
    },
    replay(after) {
      if (!integer(after) || after < floor || after > sequence) throw new Error('Claude reconnect output replay expired or cursor invalid; resume from native history');
      return frames.filter(f => f.value.seq > after).map(f => f.value);
    },
    input(seq, submit) {
      if (!integer(seq) || seq === 0 || seq > inputSequence + 1) throw new Error('Invalid Claude input sequence');
      if (seq === inputSequence + 1) { submit(); inputSequence = seq; }
      return inputSequence;
    },
  };
}
module.exports = { createReconnect };
