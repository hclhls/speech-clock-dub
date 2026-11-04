// Generic settings form: one input per key of YTD_DEFAULTS; a few keys get a dropdown.
// The everyday settings come first; the rest is folded into sections that open by themselves when
// they hold a changed value. A key missing from GROUPS lands in the last section.
const COMMON = ['targetLang', 'translationLevel', 'voiceGender', 'subtitles', 'speakerVoices', 'ttsProvider', 'llmApiKey', 'googleApiKey'];
const GROUPS = [
  ['Voice details', ['ttsSpeed', 'googleVoice', 'googleSpeed', 'edgeVoice', 'edgeRate', 'speakerFemale', 'speakerMale',
    'voice1Provider', 'voice1Voice', 'voice2Provider', 'voice2Voice']],
  ['Servers and models', ['llmBaseUrl', 'llmModel', 'llmExtraBody', 'llmTimeoutSec', 'voicevoxUrl', 'edgeUrl']],
  ['Speech-to-text (experimental)', ['sttMode', 'sttBaseUrl', 'sttModel', 'sttApiKey', 'sttLanguage', 'sttTimeoutSec', 'sttMaxMB']],
  ['Captions and subtitles', ['subtitleMaxLines', 'localCaptionLang', 'asrPunctuation', 'asrWindowWords',
    'asrStrideWords', 'asrConcurrency', 'contextCues', 'maxGapSec', 'maxCueChars']],
  ['Buffering and video speed', ['lowWaterSec', 'highWaterSec', 'targetAheadSec', 'concurrency', 'minRate', 'maxRate', 'gapRate']],
];

const form = document.getElementById('form');

const CHOICES = {
  targetLang: Object.keys(YTD_LANGS),
  voiceGender: ['female', 'male'],
  translationLevel: ['standard', 'easy', 'advanced'],
  sttMode: ['off', 'fallback'],
  speakerVoices: ['off', 'alternate', 'llm'],
  subtitles: ['off', 'translated', 'both'],
  asrPunctuation: ['on', 'off'],
  ttsProvider: ['auto', 'voicevox', 'edge', 'google'],
  voice1Provider: ['', 'auto', 'voicevox', 'edge', 'google'],
  voice2Provider: ['', 'auto', 'voicevox', 'edge', 'google'],
};

// Secrets are masked at all times, so the key is never visible on screen after saving.
const SECRET_KEY = /ApiKey/i;
const isSecret = (key) => SECRET_KEY.test(key);

const PROFILE_PREFIX = 'profile:';
const MAX_NAME = 40;

const msg = document.getElementById('msg');
const profileSelect = document.getElementById('profile');
const nameInput = document.getElementById('profileName');
let loadedProfile = ''; // the profile last loaded or saved; remembered as activeProfile on Save

function readForm() {
  const values = {};
  for (const [key, def] of Object.entries(YTD_DEFAULTS)) {
    const raw = form.elements[key].value;
    values[key] = typeof def === 'number' ? (String(raw).trim() === '' ? NaN : Number(raw)) : raw;
  }
  return values;
}

// Fills the form from a profile (or file) and keeps the API keys that are already in the form.
function fillForm(overrides) {
  const current = readForm();
  const values = { ...YTD_DEFAULTS, ...overrides };
  for (const key of Object.keys(YTD_DEFAULTS)) {
    form.elements[key].value = isSecret(key) ? current[key] : values[key];
  }
}

// The values that differ from the defaults, optionally without the API keys.
function overridesOf(values, { secrets }) {
  const out = {};
  for (const [key, def] of Object.entries(YTD_DEFAULTS)) {
    if (values[key] !== def && (secrets || !isSecret(key))) out[key] = values[key];
  }
  return out;
}

// Every setting except the API keys: what Save as profile and Export file store, so a profile keeps its
// meaning when a default changes later. (Built-in profiles list only their differences.)
function snapshotOf(values) {
  const out = {};
  for (const key of Object.keys(YTD_DEFAULTS)) {
    if (!isSecret(key)) out[key] = values[key];
  }
  return out;
}

function userProfiles(stored) {
  const profiles = Object.create(null);
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(PROFILE_PREFIX)) profiles[key.slice(PROFILE_PREFIX.length)] = value;
  }
  return profiles;
}

async function listProfiles(selected) {
  const stored = await chrome.storage.sync.get(null);
  const names = [...Object.keys(YTD_PRESETS), ...Object.keys(userProfiles(stored)).sort()];
  profileSelect.replaceChildren(...names.map((n) => new Option(n, n)));
  const wanted = selected || stored.activeProfile;
  if (names.includes(wanted)) profileSelect.value = wanted;
  return stored;
}

// If storage is unavailable (for example an add-on without a fixed id in Firefox), still show the form
// with the defaults and say why, instead of leaving the page blank.
chrome.storage.sync.get(null).catch((err) => {
  msg.textContent = `Cannot read saved settings: ${err.message}`;
  return {};
}).then(async (stored) => {
  const values = { ...YTD_DEFAULTS, ...stored };
  const fields = {};
  for (const [key, def] of Object.entries(YTD_DEFAULTS)) {
    const label = document.createElement('label');
    label.textContent = key;
    let input;
    if (CHOICES[key]) {
      input = document.createElement('select');
      for (const c of CHOICES[key]) input.add(new Option(c, c));
    } else {
      input = document.createElement('input');
      input.type = typeof def === 'number' ? 'number' : isSecret(key) ? 'password' : 'text';
      if (isSecret(key)) input.autocomplete = 'new-password';
      if (typeof def === 'number') input.step = 'any';
    }
    input.name = key;
    input.value = values[key];
    label.append(input);
    fields[key] = label;
  }
  const placed = new Set([...COMMON, ...GROUPS.flatMap(([, keys]) => keys)]);
  const leftover = Object.keys(YTD_DEFAULTS).filter((key) => !placed.has(key));
  GROUPS[GROUPS.length - 1][1].push(...leftover);
  for (const key of COMMON) form.append(fields[key]);
  for (const [title, keys] of GROUPS) {
    const section = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = title;
    section.append(summary);
    for (const key of keys) section.append(fields[key]);
    section.open = keys.some((key) => values[key] !== YTD_DEFAULTS[key]);
    form.append(section);
  }
  loadedProfile = stored.activeProfile || '';
  await listProfiles().catch(() => {});
});

document.getElementById('save').addEventListener('click', async () => {
  // Only values that differ from the defaults are stored, so a later change of a default reaches everyone
  // who never changed that setting; a setting set back to its default is removed from storage.
  const values = readForm();
  const badNumber = Object.keys(YTD_DEFAULTS).find((key) => typeof YTD_DEFAULTS[key] === 'number' && !Number.isFinite(values[key]));
  if (badNumber) {
    msg.textContent = `Cannot save: ${badNumber} must be a number`;
    return;
  }
  const out = overridesOf(values, { secrets: true });
  const reset = Object.keys(YTD_DEFAULTS).filter((key) => !(key in out));
  // Servers on other machines (e.g. an LLM and TTS box on the LAN) need a host permission, which Chrome
  // only grants after a click, so ask first.
  const origins = ytdRemoteOrigins(values);
  let note = '';
  if (origins.length) {
    // request() first: it resolves true at once for hosts already granted, and keeps the click's user gesture.
    try {
      if (!(await chrome.permissions.request({ origins }))) note = `access to ${origins.join(', ')} was not granted`;
    } catch (e) {
      note = `cannot request access to ${origins.join(', ')} (${e.message})`;
    }
  }
  try {
    await chrome.storage.sync.set(loadedProfile ? { ...out, activeProfile: loadedProfile } : out);
    await chrome.storage.sync.remove(loadedProfile ? reset : [...reset, 'activeProfile']);
  } catch (err) {
    msg.textContent = `Cannot save: ${err.message}`;
    return;
  }
  msg.textContent = note ? `Saved, but ${note}` : 'Saved';
});

document.getElementById('load').addEventListener('click', async () => {
  const name = profileSelect.value;
  let stored;
  try {
    stored = await chrome.storage.sync.get(null);
  } catch (err) {
    msg.textContent = `Cannot read profiles: ${err.message}`;
    return;
  }
  const overrides = Object.hasOwn(YTD_PRESETS, name) ? YTD_PRESETS[name] : userProfiles(stored)[name];
  if (!overrides) {
    msg.textContent = 'No profile selected';
    return;
  }
  fillForm(overrides);
  loadedProfile = name;
  msg.textContent = `Loaded "${name}": every setting except the API keys now follows the profile (settings it does not list are back to their defaults). Press Save to apply it.`;
});

document.getElementById('saveAs').addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name || name.length > MAX_NAME) {
    msg.textContent = `Enter a profile name of 1 to ${MAX_NAME} characters`;
    return;
  }
  if (Object.hasOwn(YTD_PRESETS, name)) {
    msg.textContent = `"${name}" is a built-in profile; choose another name`;
    return;
  }
  try {
    await chrome.storage.sync.set({ [PROFILE_PREFIX + name]: snapshotOf(readForm()) });
  } catch (err) {
    msg.textContent = `Cannot save the profile: ${err.message}`;
    return;
  }
  loadedProfile = name;
  await listProfiles(name);
  msg.textContent = `Saved profile "${name}" (without API keys). Press Save to also make it the active settings.`;
});

document.getElementById('delete').addEventListener('click', async () => {
  const name = profileSelect.value;
  if (Object.hasOwn(YTD_PRESETS, name)) {
    msg.textContent = 'Built-in profiles cannot be deleted';
    return;
  }
  try {
    await chrome.storage.sync.remove(PROFILE_PREFIX + name);
  } catch (err) {
    msg.textContent = `Cannot delete the profile: ${err.message}`;
    return;
  }
  if (loadedProfile === name) loadedProfile = '';
  await listProfiles();
  msg.textContent = `Deleted profile "${name}"`;
});

document.getElementById('export').addEventListener('click', () => {
  const data = {
    app: 'speech-clock-dub',
    name: loadedProfile,
    settings: snapshotOf(readForm()),
  };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  link.download = `speech-clock-dub-${(loadedProfile || 'settings').replace(/[^\w.-]+/g, '_')}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  msg.textContent = 'Exported (without API keys)';
});

const importFile = document.getElementById('importFile');
document.getElementById('import').addEventListener('click', () => importFile.click());
importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  importFile.value = '';
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    msg.textContent = 'Import failed: the file is not valid JSON';
    return;
  }
  if (data?.app !== 'speech-clock-dub' || typeof data.settings !== 'object' || !data.settings) {
    msg.textContent = 'Import failed: this is not a Speech Clock Dub settings file';
    return;
  }
  // Unknown keys, API keys and invalid values (wrong type, not one of the dropdown choices, not a finite
  // number) are ignored.
  const kept = {};
  let ignored = 0;
  for (const [key, value] of Object.entries(data.settings)) {
    const valid =
      Object.hasOwn(YTD_DEFAULTS, key) &&
      !isSecret(key) &&
      typeof value === typeof YTD_DEFAULTS[key] &&
      (typeof value !== 'number' || Number.isFinite(value)) &&
      (!CHOICES[key] || CHOICES[key].includes(value));
    if (valid) Object.defineProperty(kept, key, { value, enumerable: true });
    else ignored++;
  }
  // The shared API keys stay in the form, so a file must not move a server URL unnoticed.
  const current = readForm();
  const moved = ['llmBaseUrl', 'voicevoxUrl', 'edgeUrl', 'sttBaseUrl'].filter((key) => key in kept && kept[key] !== current[key]);
  fillForm(kept);
  if (typeof data.name === 'string') nameInput.value = data.name.slice(0, MAX_NAME);
  loadedProfile = '';
  const warning = moved.length ? ` Check the server URLs before saving, your API keys are sent to them: ${moved.map((key) => `${key} = ${kept[key]}`).join(', ')}.` : '';
  msg.textContent = `Imported ${Object.keys(kept).length} settings${ignored ? ` (${ignored} ignored)` : ''}. Press Save to apply them, or "Save as profile" to keep them.${warning}`;
});
