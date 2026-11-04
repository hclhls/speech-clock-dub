import assert from 'node:assert/strict';
import { Blob } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { EXT, loadDefaults } from './helpers/load-background.mjs';

// Objects made inside the vm context have another Object prototype, so compare them as plain JSON.
const { YTD_DEFAULTS } = loadDefaults();
const plain = (x) => JSON.parse(JSON.stringify(x));

// Runs extension/options.js against a tiny DOM and an in-memory chrome.storage.sync.
async function openOptions(stored = {}) {
  const store = { ...stored };
  const inputs = {};
  const handlers = {};
  const permissionRequests = [];
  const exported = [];
  const form = { elements: inputs, append(label) { Object.assign(inputs, label.children); } };
  const node = () => ({
    children: {},
    add() {},
    click() {},
    append(child) { if (child.name) this.children[child.name] = child; else Object.assign(this.children, child.children); },
  });
  const button = (id) => ({ addEventListener: (_, fn) => (handlers[id] = fn), click: () => handlers[id]?.() });
  const elements = {
    form,
    msg: { textContent: '' },
    profile: { value: '', options: [], replaceChildren(...opts) { this.options = opts.map((o) => o.value); } },
    profileName: { value: '' },
    importFile: { files: [], value: '', addEventListener: (_, fn) => (handlers.importFile = fn), click() {} },
  };
  for (const id of ['save', 'load', 'saveAs', 'delete', 'export', 'import']) elements[id] = button(id);
  const context = vm.createContext({
    URL,
    Blob: class extends Blob { constructor(parts, opts) { super(parts, opts); exported.push(parts.join('')); } },
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    document: { getElementById: (id) => elements[id], createElement: node },
    chrome: {
      storage: {
        sync: {
          get: async () => ({ ...store }),
          set: async (o) => Object.assign(store, o),
          remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
        },
      },
      permissions: { request: async (r) => (permissionRequests.push(r), true) },
    },
  });
  for (const f of ['defaults.js', 'options.js']) vm.runInContext(fs.readFileSync(path.join(EXT, f), 'utf8'), context);
  await new Promise((r) => setImmediate(r)); // let the form fill
  const importFile = async (text) => {
    elements.importFile.files = [{ text: async () => text }];
    await handlers.importFile();
  };
  return { store, inputs, permissionRequests, exported, msg: elements.msg, profile: elements.profile, name: elements.profileName, handlers, importFile };
}

test('saving stores only values that differ from the defaults and drops reset ones', async () => {
  const o = await openOptions({ llmExtraBody: '{"chat_template_kwargs":{}}', targetLang: 'en' });
  assert.equal(o.inputs.llmExtraBody.value, '{"chat_template_kwargs":{}}', 'the saved value is shown');
  o.inputs.llmExtraBody.value = '{}'; // back to the default
  o.inputs.googleApiKey.value = 'gk';
  o.inputs.maxRate.value = '1.8';
  await o.handlers.save();
  assert.equal(o.msg.textContent, 'Saved');
  assert.deepEqual(o.store, { targetLang: 'en', googleApiKey: 'gk', maxRate: 1.8 });
});

test('a remote server in the form triggers a permission request on Save', async () => {
  const o = await openOptions();
  o.inputs.edgeUrl.value = 'http://192.168.1.20:5050';
  await o.handlers.save();
  assert.deepEqual(plain(o.permissionRequests), [{ origins: ['http://192.168.1.20/*'] }]);
});

test('the built-in profiles are listed, and loading one keeps the API keys of the form', async () => {
  const o = await openOptions({ llmApiKey: 'secret', googleApiKey: 'gk', targetLang: 'ko' });
  assert.deepEqual(o.profile.options.slice(0, 2), ['Hosted (Gemini + Google TTS)', 'Local (Unsloth + VOICEVOX / edge-tts)']);
  assert.equal(o.profile.options.length, Object.keys(loadDefaults().YTD_PRESETS).length);
  o.profile.value = 'Local (Unsloth + VOICEVOX / edge-tts)';
  await o.handlers.load();
  assert.equal(o.inputs.llmBaseUrl.value, 'http://127.0.0.1:8888/v1');
  assert.equal(o.inputs.ttsProvider.value, 'auto');
  assert.equal(o.inputs.targetLang.value, 'ja', 'a profile sets every non-secret setting; the rest fall back to defaults');
  assert.equal(o.inputs.llmApiKey.value, 'secret');
  assert.equal(o.inputs.googleApiKey.value, 'gk');
  assert.equal(o.store.targetLang, 'ko', 'nothing is applied until Save');
  await o.handlers.save();
  assert.equal(o.store.activeProfile, 'Local (Unsloth + VOICEVOX / edge-tts)');
  assert.equal(o.store.ttsProvider, 'auto');
  assert.equal(o.store.llmApiKey, 'secret');
  assert.equal('targetLang' in o.store, false);

  o.profile.value = 'Hosted (Gemini + Google TTS)';
  await o.handlers.load();
  await o.handlers.save();
  assert.deepEqual(o.store, { llmApiKey: 'secret', googleApiKey: 'gk', activeProfile: 'Hosted (Gemini + Google TTS)' });
});

test('a user profile is saved without API keys, listed, loaded and deleted', async () => {
  const o = await openOptions({ llmApiKey: 'secret' });
  o.inputs.targetLang.value = 'en';
  o.inputs.edgeRate.value = '+10%';
  o.name.value = '  English fast  ';
  await o.handlers.saveAs();
  const saved = plain(o.store['profile:English fast']);
  assert.equal(saved.targetLang, 'en');
  assert.equal(saved.edgeRate, '+10%');
  assert.equal(saved.llmModel, YTD_DEFAULTS.llmModel, 'a profile is a full snapshot, including values equal to the defaults');
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(YTD_DEFAULTS).filter((k) => !/ApiKey/i.test(k)).sort());
  assert.equal(JSON.stringify(o.store).includes('secret'), true, 'the shared key itself is still stored');
  assert.equal(JSON.stringify(o.store['profile:English fast']).includes('secret'), false);
  assert.deepEqual(o.profile.options.slice(-1), ['English fast']);
  assert.equal(o.profile.value, 'English fast');

  o.inputs.targetLang.value = 'ko';
  o.profile.value = 'English fast';
  await o.handlers.load();
  assert.equal(o.inputs.targetLang.value, 'en');
  assert.equal(o.inputs.edgeRate.value, '+10%');

  await o.handlers.delete();
  assert.equal('profile:English fast' in o.store, false);
  assert.equal(o.profile.options.length, Object.keys(loadDefaults().YTD_PRESETS).length);
});

test('Export file writes every setting except the API keys, and the file can be imported again', async () => {
  const o = await openOptions({ llmApiKey: 'secret', googleApiKey: 'gk', targetLang: 'ko' });
  await o.handlers.export();
  assert.equal(o.exported.length, 1);
  const file = JSON.parse(o.exported[0]);
  assert.equal(file.app, 'speech-clock-dub');
  assert.equal(file.settings.targetLang, 'ko');
  assert.equal(file.settings.llmModel, YTD_DEFAULTS.llmModel, 'defaults are written out too');
  assert.equal(Object.keys(file.settings).length, Object.keys(YTD_DEFAULTS).filter((k) => !/ApiKey/i.test(k)).length, 'all but the API keys');
  assert.equal(o.exported[0].includes('secret') || o.exported[0].includes('gk'), false, 'no key in the file');

  const other = await openOptions({ llmApiKey: 'other-key' });
  await other.importFile(o.exported[0]);
  assert.equal(other.inputs.targetLang.value, 'ko');
  assert.equal(other.inputs.llmApiKey.value, 'other-key');
  assert.match(other.msg.textContent, /Imported \d+ settings\./);
  assert.doesNotMatch(other.msg.textContent, /ignored/);
});

test('profile names are validated and built-in profiles are protected', async () => {
  const o = await openOptions();
  for (const bad of ['', '   ', 'x'.repeat(41), 'Hosted (Gemini + Google TTS)']) {
    o.name.value = bad;
    await o.handlers.saveAs();
    assert.deepEqual(Object.keys(o.store), [], JSON.stringify(bad));
  }
  o.profile.value = 'Hosted (Gemini + Google TTS)';
  await o.handlers.delete();
  assert.match(o.msg.textContent, /cannot be deleted/);
});

test('import fills the form, ignores keys, unknown settings and wrong types, and rejects other files', async () => {
  const o = await openOptions({ googleApiKey: 'gk' });
  await o.importFile(JSON.stringify({
    app: 'speech-clock-dub',
    name: 'Shared',
    settings: { targetLang: 'zh-TW', maxRate: 1.7, minRate: 'fast', nope: 1, llmApiKey: 'stolen' },
  }));
  assert.equal(o.inputs.targetLang.value, 'zh-TW');
  assert.equal(o.inputs.maxRate.value, 1.7);
  assert.equal(o.inputs.minRate.value, 0.5, 'a wrong type falls back to the default');
  assert.equal(o.inputs.llmApiKey.value, '', 'an imported API key is ignored');
  assert.equal(o.inputs.googleApiKey.value, 'gk');
  assert.equal(o.name.value, 'Shared');
  assert.match(o.msg.textContent, /3 ignored/);
  assert.doesNotMatch(o.msg.textContent, /Check the server URLs/);
  assert.deepEqual(o.store, { googleApiKey: 'gk' }, 'import alone saves nothing');

  await o.importFile('{not json');
  assert.match(o.msg.textContent, /not valid JSON/);
  await o.importFile(JSON.stringify({ settings: {} }));
  assert.match(o.msg.textContent, /not a Speech Clock Dub settings file/);
});

test('import rejects invalid choices and numbers, ignores __proto__, and warns when a server URL moves', async () => {
  const o = await openOptions({ llmApiKey: 'secret' });
  o.inputs.llmBaseUrl.value = 'https://generativelanguage.googleapis.com/v1beta/openai';
  await o.importFile(
    '{"app":"speech-clock-dub","settings":{"__proto__":{"x":1},"ttsProvider":"bogus","targetLang":"xx","maxRate":null,"minRate":1e999,"llmTimeoutSec":30,"llmBaseUrl":"https://evil.example/v1"}}',
  );
  assert.equal(o.inputs.ttsProvider.value, 'google', 'an unknown dropdown value is ignored');
  assert.equal(o.inputs.targetLang.value, 'ja');
  assert.equal(o.inputs.llmTimeoutSec.value, 30);
  assert.match(o.msg.textContent, /Imported 2 settings \(5 ignored\)/);
  assert.match(o.msg.textContent, /llmBaseUrl = https:\/\/evil\.example\/v1/, 'the moved URL is shown');
  assert.equal(o.inputs.llmApiKey.value, 'secret', 'the key stays in the form, so the warning matters');
  assert.equal(({}).x, undefined, 'Object.prototype is untouched');
});

test('translationLevel is an everyday dropdown and an invalid imported level is ignored', async () => {
  const o = await openOptions();
  assert.equal(o.inputs.translationLevel.value, 'standard');
  await o.importFile('{"app":"speech-clock-dub","settings":{"translationLevel":"expert"}}');
  assert.equal(o.inputs.translationLevel.value, 'standard');
  assert.match(o.msg.textContent, /Imported 0 settings \(1 ignored\)/);
  await o.importFile('{"app":"speech-clock-dub","settings":{"translationLevel":"easy"}}');
  assert.equal(o.inputs.translationLevel.value, 'easy');
});

test('Save refuses an empty or non-numeric number field', async () => {
  const o = await openOptions();
  o.inputs.maxRate.value = '';
  await o.handlers.save();
  assert.match(o.msg.textContent, /maxRate must be a number/);
  assert.deepEqual(plain(o.store), {});
  o.inputs.maxRate.value = 'abc';
  await o.handlers.save();
  assert.deepEqual(plain(o.store), {});
});

test('inherited names such as constructor are not built-in profiles', async () => {
  const o = await openOptions();
  o.name.value = 'constructor';
  await o.handlers.saveAs();
  assert.deepEqual(Object.keys(o.store), ['profile:constructor']);
});
