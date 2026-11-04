// Background script: bridges the content script to the local LLM and TTS servers.
// Content scripts cannot call these directly because of the page's CORS/CSP rules.
// Chrome runs this as a service worker and loads defaults.js here; Firefox runs it as an event
// page and loads defaults.js through the manifest's "scripts" list (importScripts does not exist).
if (typeof importScripts === 'function') importScripts('defaults.js');

async function getSettings() {
  return { ...YTD_DEFAULTS, ...(await chrome.storage.sync.get(null)) };
}

async function translate({ text, prev, sourceLang }) {
  const s = await getSettings();
  const context = prev.length
    ? 'Previous lines (for context only, do not repeat them):\n' +
      prev.map((p) => `${p.src}\n=> ${p.ja}`).join('\n') +
      '\n\n'
    : '';
  const lang = getLang(s);
  const level = (lang.levels || YTD_LEVELS)[s.translationLevel] || '';
  // Single user message: some Gemma chat templates have no system role.
  const prompt =
    `You translate ${sourceLang} lecture subtitles into ${lang.style} for a voice-over.\nRules:\n` +
    `- Be faithful: do not add, omit or reinterpret content. Keep technical terms accurate.\n` +
    `- Translate the meaning, not word by word.${lang.extraRule ? ` In particular, ${lang.extraRule}` : ''}\n` +
    (level ? `- ${level} Keep the meaning and technical terms unchanged.\n` : '') +
    `Output ONLY the ${lang.name} translation of the last line, with no notes, quotes or romaji.` +
    `\n\n${context}Translate this line:\n${text}`;

  return chat(s, prompt, { temperature: 0.2, maxTokens: 512 });
}

// Speech-to-text for one audio chunk (a base64 WAV): an OpenAI-compatible /audio/transcriptions call.
// Returns the timed segments and the language the server detected.
async function transcribe({ wav }) {
  const s = await getSettings();
  if (!s.sttBaseUrl) throw new Error('sttBaseUrl is empty: set a speech-to-text endpoint in the options page');
  const bin = atob(wav);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', s.sttModel);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  if (s.sttLanguage) form.append('language', s.sttLanguage);
  const res = await fetch(`${s.sttBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: s.sttApiKey ? { Authorization: `Bearer ${s.sttApiKey}` } : {},
    body: form,
    signal: AbortSignal.timeout(s.sttTimeoutSec * 1000),
  });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  let segments = Array.isArray(json.segments)
    ? json.segments.map((g) => ({ start: g.start, end: g.end, text: g.text, no_speech_prob: g.no_speech_prob }))
    : [];
  // Some servers answer with the plain text only: use it as one segment over the whole chunk.
  if (!segments.length && json.text?.trim()) segments = [{ start: 0, end: Number(json.duration) || bytes.length / 32000, text: json.text }];
  return { segments, language: json.language ?? '' };
}

// Restores punctuation and capitalization in a window of ASR words (see extension/asr.js).
async function punctuate({ text, sourceLang }) {
  const s = await getSettings();
  const prompt =
    `Add punctuation and capitalization to this ${sourceLang} speech-recognition transcript of a lecture.\n` +
    `Rules:\n` +
    `- Do not add, remove, reorder or change any word. Only insert punctuation marks and fix capitalization.\n` +
    `- End every sentence with a period, question mark or exclamation mark.\n` +
    `- Output ONLY the corrected text on a single line, with no notes.\n\n` +
    `Transcript:\n${text}`;
  return chat(s, prompt, { temperature: 0, maxTokens: 1024 });
}

// Labels who speaks each line of a dialogue (see extension/speakers.js); `prompt` is built by the caller.
async function labelSpeakers({ prompt }) {
  return chat(await getSettings(), prompt, { temperature: 0, maxTokens: 600 });
}

// One chat completion against the OpenAI-compatible endpoint; returns the reply text.
async function chat(s, prompt, { temperature, maxTokens }) {
  let extra = {};
  try {
    extra = JSON.parse(s.llmExtraBody || '{}');
  } catch {
    throw new Error('llmExtraBody is not valid JSON');
  }

  // Fail with a clear message instead of an HTTP error when the default hosted endpoint has no key yet.
  if (!s.llmApiKey && /^https:\/\/generativelanguage\.googleapis\.com\//.test(s.llmBaseUrl)) {
    throw new Error('llmApiKey is empty: set a Gemini API key in the options page');
  }

  const res = await fetch(`${s.llmBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(s.llmApiKey ? { Authorization: `Bearer ${s.llmApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: s.llmModel,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens, // guard against runaway output
      stream: false,
      ...extra,
    }),
    signal: AbortSignal.timeout(s.llmTimeoutSec * 1000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const out = json.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('LLM returned an empty reply');
  return out;
}

function getLang(s) {
  const lang = YTD_LANGS[s.targetLang];
  if (!lang) throw new Error(`Unknown targetLang "${s.targetLang}" (use one of ${Object.keys(YTD_LANGS).join(', ')})`);
  return lang;
}

// `alt` asks for the second voice of a dialogue: the gender opposite to voiceGender.
async function synthesize({ text, alt }) {
  const s = await getSettings();
  // Each speaker slot may name its own provider and voice (voice1* = first speaker, voice2* = second),
  // so voices of different providers can be mixed, even with the same gender.
  const slot = alt ? 2 : 1;
  const choice = s[`voice${slot}Provider`] || s.ttsProvider;
  const provider = choice === 'auto' ? (s.targetLang === 'ja' ? 'voicevox' : 'edge') : choice;
  const voice = String(s[`voice${slot}Voice`] ?? '').trim();
  if (provider === 'edge') return synthesizeEdge(s, text, alt, voice);
  if (provider === 'google') return synthesizeGoogle(s, text, alt, voice);
  if (provider === 'voicevox') return synthesizeVoicevox(s, text, alt, voice);
  throw new Error(`Unknown TTS provider "${choice}" (use auto, voicevox, edge or google)`);
}

const genderFor = (s, alt) => ((s.voiceGender === 'male') !== Boolean(alt) ? 'male' : 'female');

async function synthesizeEdge(s, text, alt, voice) {
  const res = await fetch(`${s.edgeUrl.replace(/\/$/, '')}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice: voice || (!alt && s.edgeVoice) || getLang(s).voices[genderFor(s, alt)], rate: s.edgeRate }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`edge-tts bridge HTTP ${res.status}: ${await res.text()}`);
  return toBase64(await res.arrayBuffer());
}

async function synthesizeGoogle(s, text, alt, voice) {
  if (!s.googleApiKey) throw new Error('googleApiKey is empty; set a Google Cloud Text-to-Speech API key');
  const g = getLang(s).google;
  const res = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.googleApiKey },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: g.code, name: voice || (!alt && s.googleVoice) || g.voices[genderFor(s, alt)] },
      audioConfig: { audioEncoding: 'MP3', speakingRate: Math.min(4, Math.max(0.25, Number(s.googleSpeed) || 1)) },
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}: ${await res.text()}`);
  const { audioContent } = await res.json();
  if (!audioContent) throw new Error('Google TTS returned no audio');
  return audioContent; // already base64
}

async function synthesizeVoicevox(s, text, alt, voice) {
  if (s.targetLang !== 'ja') throw new Error('VOICEVOX only speaks Japanese; use ttsProvider "edge", "google" or "auto"');
  const base = s.voicevoxUrl.replace(/\/$/, '');
  if (voice !== '' && !Number.isFinite(Number(voice))) throw new Error(`VOICEVOX voice must be a style id (a number), got "${voice}"`);
  const speaker = voice !== '' ? Number(voice) : genderFor(s, alt) === 'male' ? s.speakerMale : s.speakerFemale;

  const q = await fetch(`${base}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`, {
    method: 'POST',
  });
  if (!q.ok) throw new Error(`VOICEVOX audio_query HTTP ${q.status}`);
  const query = await q.json();
  query.speedScale = s.ttsSpeed;

  const w = await fetch(`${base}/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!w.ok) throw new Error(`VOICEVOX synthesis HTTP ${w.status}`);
  return toBase64(await w.arrayBuffer());
}

// Extension messages are JSON-serialized, so binary data travels as base64.
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

const HANDLERS = { translate, transcribe, punctuate, label: labelSpeakers, synthesize };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = Object.hasOwn(HANDLERS, msg?.type) ? HANDLERS[msg.type] : null;
  const job = handler ? handler(msg) : null;
  if (!job) return false;
  job.then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: String(err?.message ?? err) }),
  );
  return true; // async response
});
