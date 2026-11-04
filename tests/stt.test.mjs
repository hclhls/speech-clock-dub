import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadBackground, loadStt, response } from './helpers/load-background.mjs';

const STT = loadStt();
const plain = (x) => JSON.parse(JSON.stringify(x));

test('directMediaUrl accepts a media file and refuses streams', () => {
  assert.equal(STT.directMediaUrl({ currentSrc: 'https://cdn.example/v/lecture.mp4?x=1' }), 'https://cdn.example/v/lecture.mp4?x=1');
  assert.equal(STT.directMediaUrl({ src: 'http://localhost/a.webm' }), 'http://localhost/a.webm');
  assert.throws(() => STT.directMediaUrl({ currentSrc: 'blob:https://www.youtube.com/abc' }), /streamed/);
  assert.throws(() => STT.directMediaUrl({ currentSrc: 'https://cdn.example/index.m3u8?t=1' }), /HLS/);
  assert.throws(() => STT.directMediaUrl({ currentSrc: 'https://cdn.example/manifest.mpd' }), /HLS\/DASH/);
  assert.throws(() => STT.directMediaUrl({ currentSrc: '' }), /no source/);
  assert.throws(() => STT.directMediaUrl({ currentSrc: 'data:video/mp4;base64,AAAA' }), /Unsupported/);
  assert.throws(() => STT.directMediaUrl(null), /no source/);
});

test('mixToMono averages channels and keeps a mono buffer as it is', () => {
  const mono = new Float32Array([0.5, -0.5]);
  assert.equal(STT.mixToMono([mono]), mono);
  assert.deepEqual([...STT.mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])])], [0.5, 0.5]);
});

test('encodeWav writes a 16-bit mono PCM header and clamps samples', () => {
  const wav = STT.encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
  const v = new DataView(wav);
  const tag = (at) => String.fromCharCode(...new Uint8Array(wav, at, 4));
  assert.equal(tag(0), 'RIFF');
  assert.equal(tag(8), 'WAVE');
  assert.equal(tag(36), 'data');
  assert.equal(wav.byteLength, 44 + 8);
  assert.equal(v.getUint32(24, true), 16000, 'sample rate');
  assert.equal(v.getUint16(22, true), 1, 'mono');
  assert.equal(v.getUint16(34, true), 16, 'bits');
  assert.deepEqual([44, 46, 48, 50].map((at) => v.getInt16(at, true)), [0, 32767, -32768, 32767]);
});

test('chunkRanges covers all samples in chunks of at most chunkSec', () => {
  assert.deepEqual(plain(STT.chunkRanges(40000, 1)), [{ from: 0, to: 16000 }, { from: 16000, to: 32000 }, { from: 32000, to: 40000 }]);
  assert.deepEqual(plain(STT.chunkRanges(0, 1)), []);
});

test('segmentsToEvents offsets times, joins whitespace and drops empty or non-speech segments', () => {
  const events = STT.segmentsToEvents(
    [
      { start: 0, end: 2.5, text: '  Hello   there. ' },
      { start: 2.5, end: 3, text: '   ' },
      { start: 3, end: 4, text: 'Thanks for watching', no_speech_prob: 0.95 },
      { start: 4, end: 4, text: 'Zero length' },
    ],
    600,
  );
  assert.deepEqual(plain(events), [
    { tStartMs: 600000, dDurationMs: 2500, segs: [{ utf8: 'Hello there.' }] },
    { tStartMs: 604000, dDurationMs: 200, segs: [{ utf8: 'Zero length' }] },
  ]);
});

test('languageName turns ISO codes and Whisper names into English names', () => {
  assert.equal(STT.languageName('english'), 'English');
  assert.equal(STT.languageName('de'), 'German');
  assert.equal(STT.languageName('zh-TW'), 'Chinese (Taiwan)');
  assert.equal(STT.languageName(''), '');
});

test('transcribeSamples sends chunks in order, skips silence and offsets the segments', async () => {
  const loud = (n) => Float32Array.from({ length: n }, (_, i) => Math.sin(i / 5) * 0.3);
  const samples = new Float32Array(3 * 16000);
  samples.set(loud(16000), 0); // second 0-1 speech, 1-2 silent, 2-3 speech
  samples.set(loud(16000), 32000);
  const sent = [];
  const progress = [];
  const out = await STT.transcribeSamples(samples, {
    chunkSec: 1,
    send: async (wav) => {
      sent.push(wav);
      return { language: 'english', segments: [{ start: 0.1, end: 0.9, text: `part ${sent.length}` }] };
    },
    onProgress: (i, n) => progress.push(`${i}/${n}`),
  });
  assert.equal(sent.length, 2, 'the silent chunk is not sent');
  assert.deepEqual(plain(out.events).map((e) => [e.tStartMs, e.segs[0].utf8]), [[100, 'part 1'], [2100, 'part 2']]);
  assert.equal(out.language, 'English');
  assert.deepEqual(progress, ['0/3', '1/3', '2/3', '3/3']);
  await assert.rejects(STT.transcribeSamples(samples, { chunkSec: 1, send: async () => ({}), isCancelled: () => true }), /cancelled/);
});

function sttServer(json) {
  return (url) => {
    if (url.endsWith('/audio/transcriptions')) return response(json);
    throw new Error(`unexpected fetch ${url}`);
  };
}

test('transcribe posts a multipart request to /audio/transcriptions and returns the segments', async () => {
  const bg = loadBackground({
    settings: { sttBaseUrl: 'http://127.0.0.1:8080/v1/', sttModel: 'small', sttLanguage: 'de', sttApiKey: 'k' },
    fetchImpl: sttServer({ language: 'german', segments: [{ start: 1, end: 2, text: 'Hallo.', no_speech_prob: 0.01, tokens: [1] }] }),
  });
  const res = await bg.send({ type: 'transcribe', wav: Buffer.from('RIFFxxxx').toString('base64') });
  assert.equal(res.ok, true);
  assert.deepEqual(plain(res.result), { segments: [{ start: 1, end: 2, text: 'Hallo.', no_speech_prob: 0.01 }], language: 'german' });
  const call = bg.calls[0];
  assert.equal(call.url, 'http://127.0.0.1:8080/v1/audio/transcriptions');
  assert.equal(call.opts.headers.Authorization, 'Bearer k');
  assert.ok(call.opts.signal, 'request must have a timeout');
  const form = call.opts.body;
  assert.equal(form.get('model'), 'small');
  assert.equal(form.get('language'), 'de');
  assert.equal(form.get('response_format'), 'verbose_json');
  assert.equal(form.get('file').type, 'audio/wav');
});

test('transcribe needs sttBaseUrl, reports HTTP errors and accepts a text-only answer', async () => {
  const none = loadBackground({ settings: {}, fetchImpl: sttServer({}) });
  assert.match((await none.send({ type: 'transcribe', wav: '' })).error, /sttBaseUrl is empty/);
  assert.equal(none.calls.length, 0);

  const bad = loadBackground({ settings: { sttBaseUrl: 'http://x/v1' }, fetchImpl: () => response('nope', { status: 500 }) });
  assert.match((await bad.send({ type: 'transcribe', wav: '' })).error, /STT HTTP 500/);

  const plainText = loadBackground({ settings: { sttBaseUrl: 'http://x/v1' }, fetchImpl: sttServer({ text: ' Just text. ', duration: 12 }) });
  const res = await plainText.send({ type: 'transcribe', wav: '' });
  assert.deepEqual(plain(res.result.segments), [{ start: 0, end: 12, text: ' Just text. ' }]);
  const form = plainText.calls[0].opts.body;
  assert.equal(form.get('language'), null, 'language is detected when sttLanguage is empty');
});
