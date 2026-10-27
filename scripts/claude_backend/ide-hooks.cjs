'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

// Inspected official extension: these callbacks only autosave editor buffers
// and collect diagnostics. Never infer callback semantics from a matcher alone.
const PROFILES = new Map([
  ['77fa2ea0eec77d1cda9b93099dcfeb179dc4ec6a92b321f050e89a9f9fe89c7e', 'vscode-2.1.311'],
]);
function extensionProfile(spec, request) {
  if (request.env?.CLAUDE_CODE_ENTRYPOINT !== 'claude-vscode') return null;
  const bundled = request.args?.[0];
  if (!bundled || !path.isAbsolute(bundled)) return null;
  try {
    const root = path.resolve(path.dirname(bundled), '../..');
    if (path.relative(root, bundled) !== path.join('resources', 'native-binary', 'claude')) return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (manifest.publisher !== 'Anthropic' || manifest.name !== 'claude-code' || manifest.version !== '2.1.311' || spec.version !== manifest.version) return null;
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'extension.js'))).digest('hex');
    return PROFILES.get(digest) || null;
  } catch { return null; } // Unknown/updated bundles retain all native behavior.
}

function createIdeHooks({ profile, write, audit, changed }) {
  let callbacks = new Map(), detached = false;
  const pending = new Map();
  const state = { profile, registered: false, handled: 0, waiting: [] };
  const publish = () => {
    state.waiting = [...pending].map(([requestId, r]) => ({ requestId, subtype: r.subtype }));
    changed({ ...state });
  };
  const settle = () => {
    if (!detached) return;
    for (const [id, request] of pending) {
      const hook = callbacks.get(request.callback_id), input = request.input;
      if (request.subtype !== 'hook_callback' || !hook || input?.hook_event_name !== hook.event || !hook.tools.includes(input.tool_name)) continue;
      // Neutral optional IDE-hook output, NOT a can_use_tool approval or a
      // permissionDecision. Native policy and project/managed hooks still run.
      const response = { type: 'control_response', response: { subtype: 'success', request_id: id, response: { continue: true } } };
      audit({ type: 'detached_ide_hook', requestId: id, callbackId: request.callback_id, event: hook.event, tool: input.tool_name });
      write(Buffer.from(JSON.stringify(response) + '\n'));
      pending.delete(id); state.handled++;
    }
    publish();
  };
  const register = hooks => {
    callbacks = new Map(); state.registered = false;
    // Exact SDK registration from the inspected bundle. Any addition, renamed
    // callback or timeout change disables fallback rather than guessing.
    const expected = {
      PreToolUse: [
        { matcher: 'Edit|Write|MultiEdit', hookCallbackIds: ['hook_0'] },
        { matcher: 'Edit|Write|Read', hookCallbackIds: ['hook_1'] },
      ],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hookCallbackIds: ['hook_2'] }],
    };
    if (!profile || !hooks || Object.keys(hooks).length !== 2) return;
    for (const [event, entries] of Object.entries(expected)) {
      if (!Array.isArray(hooks[event]) || hooks[event].length !== entries.length) return;
      for (let i = 0; i < entries.length; i++) {
        const actual = hooks[event][i], target = entries[i];
        if (!actual || Object.keys(actual).some(k => !['matcher', 'hookCallbackIds'].includes(k)) || actual.matcher !== target.matcher || JSON.stringify(actual.hookCallbackIds) !== JSON.stringify(target.hookCallbackIds)) return;
      }
    }
    for (const [event, entries] of Object.entries(expected)) for (const entry of entries) callbacks.set(entry.hookCallbackIds[0], { event, tools: entry.matcher.split('|') });
    state.registered = true;
  };
  const inspect = (kind, value) => {
    if (kind === 'input') {
      if (value.type === 'control_request' && value.request?.subtype === 'initialize') { register(value.request.hooks); publish(); }
      if (value.type === 'control_response' && pending.delete(value.response?.request_id)) publish();
    } else {
      if (value.type === 'control_cancel_request' && pending.delete(value.request_id)) publish();
      if (value.type === 'control_request' && typeof value.request_id === 'string' && value.request && pending.size < 256) {
        pending.set(value.request_id, value.request); settle();
      }
    }
  };
  const observers = Object.fromEntries(['input', 'output'].map(kind => {
    const decoder = new StringDecoder('utf8'); let buffer = '', oversized = false;
    return [kind, chunk => {
      for (const part of decoder.write(chunk).split(/(?<=\n)/)) {
        if (!oversized) buffer += part;
        if (buffer.length > 2 * 1024 * 1024) { buffer = ''; oversized = true; }
        if (part.endsWith('\n')) {
          if (!oversized) { try { inspect(kind, JSON.parse(buffer)); } catch { /* Non-JSON native bytes remain untouched. */ } }
          buffer = ''; oversized = false;
        }
      }
    }];
  }));
  return {
    input: observers.input, output: observers.output,
    detach() { detached = true; settle(); },
    attach() { detached = false; },
    state,
  };
}
module.exports = { extensionProfile, createIdeHooks };
