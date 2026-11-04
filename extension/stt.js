// Experimental speech-to-text for videos without captions. Loaded before content.js.
//
// The audio track of a video that is a plain media file (mp4, webm, mp3 ...) is downloaded, decoded to
// 16 kHz mono, cut into chunks and sent one chunk at a time to an OpenAI-compatible
// /audio/transcriptions endpoint (see transcribe() in background.js). The timed segments that come back
// are turned into json3-style caption events, so everything after that (cues, translation, TTS) is the
// same as for real captions. Streamed videos (blob:, HLS, DASH) have no file to download and are refused.
// The pure helpers need no DOM access, so they can be unit tested.
const YTD_STT = (() => {
  const RATE = 16000; // Hz; what Whisper-style models expect
  const SILENCE_RMS = 0.0005; // below this a chunk is treated as silent and not sent (models invent text)
  const MAX_NO_SPEECH = 0.8; // segments the model itself rates as probably not speech are dropped

  // The URL of the media file behind a <video>, or an Error saying why there is none.
  function directMediaUrl(video) {
    const url = video?.currentSrc || video?.src || '';
    if (!url) throw new Error('The video has no source URL yet');
    if (/^blob:/i.test(url)) throw new Error('This video is streamed (blob: source), so there is no file to transcribe');
    if (!/^https?:/i.test(url)) throw new Error(`Unsupported media URL "${url.slice(0, 40)}"`);
    if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) throw new Error('This video is an HLS/DASH stream, so there is no single file to transcribe');
    return url;
  }

  // Averages the channels of a decoded buffer: Float32Array[] -> Float32Array.
  function mixToMono(channels) {
    if (channels.length === 1) return channels[0];
    const out = new Float32Array(channels[0].length);
    for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i];
    for (let i = 0; i < out.length; i++) out[i] /= channels.length;
    return out;
  }

  const rms = (samples) => {
    if (!samples.length) return 0;
    let sum = 0;
    // Every 7th sample is enough to tell silence from speech and keeps long chunks cheap.
    let n = 0;
    for (let i = 0; i < samples.length; i += 7, n++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / n);
  };
  const isSilent = (samples) => rms(samples) < SILENCE_RMS;

  // 16-bit PCM mono WAV.
  function encodeWav(samples, sampleRate = RATE) {
    const buf = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buf);
    const str = (at, s) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
    str(0, 'RIFF');
    v.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buf;
  }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  // [{ from, to }] sample ranges of at most chunkSec seconds that cover `total` samples.
  function chunkRanges(total, chunkSec, rate = RATE) {
    const size = Math.max(1, Math.floor(chunkSec * rate));
    const out = [];
    for (let from = 0; from < total; from += size) out.push({ from, to: Math.min(total, from + size) });
    return out;
  }

  // Whisper-style segments [{ start, end, text }] (seconds, relative to the chunk) -> json3-style events.
  function segmentsToEvents(segments, offsetSec = 0) {
    const events = [];
    for (const s of segments ?? []) {
      const text = String(s.text ?? '').replace(/\s+/g, ' ').trim();
      if (!text || !(s.no_speech_prob == null || s.no_speech_prob <= MAX_NO_SPEECH)) continue;
      const start = offsetSec + Math.max(0, Number(s.start) || 0);
      const end = Math.max(start + 0.2, offsetSec + (Number(s.end) || 0));
      events.push({ tStartMs: Math.round(start * 1000), dDurationMs: Math.round((end - start) * 1000), segs: [{ utf8: text }] });
    }
    return events;
  }

  // The language name the translation prompt should use. Servers answer with "english" or with "en".
  function languageName(lang) {
    const l = String(lang ?? '').trim();
    if (!l) return '';
    if (/^[a-z]{2,3}(-[A-Za-z]+)?$/.test(l)) {
      try {
        return new Intl.DisplayNames(['en'], { type: 'language' }).of(l) ?? l;
      } catch {
        return l;
      }
    }
    return l[0].toUpperCase() + l.slice(1).toLowerCase();
  }

  // Sends the samples chunk by chunk through send(wavBase64) -> { segments, language } and returns
  // { events, language }. Silent chunks are skipped. Chunk results are put in order by their offsets.
  async function transcribeSamples(samples, { send, chunkSec = 300, onProgress, isCancelled }) {
    const ranges = chunkRanges(samples.length, chunkSec);
    const events = [];
    let language = '';
    for (let i = 0; i < ranges.length; i++) {
      if (isCancelled?.()) throw new Error('cancelled');
      onProgress?.(i, ranges.length);
      const part = samples.subarray(ranges[i].from, ranges[i].to);
      if (isSilent(part)) continue;
      const res = await send(toBase64(encodeWav(part)));
      language ||= res.language || '';
      events.push(...segmentsToEvents(res.segments, ranges[i].from / RATE));
    }
    onProgress?.(ranges.length, ranges.length);
    return { events, language: languageName(language) };
  }

  // Downloads the media file and decodes its audio to 16 kHz mono samples. A context created with a
  // sample rate makes decodeAudioData resample, so no resampler is needed here.
  async function loadSamples(url, { maxMB, isCancelled }) {
    let res;
    try {
      res = await fetch(url);
    } catch {
      throw new Error('The media file cannot be downloaded from the page (blocked by CORS or the network)');
    }
    if (!res.ok) throw new Error(`Media download failed: HTTP ${res.status}`);
    const size = Number(res.headers.get('content-length')) || 0;
    if (size > maxMB * 1048576) throw new Error(`The media file is ${(size / 1048576).toFixed(0)} MB, more than sttMaxMB (${maxMB})`);
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > maxMB * 1048576) throw new Error(`The media file is larger than sttMaxMB (${maxMB})`);
    if (isCancelled?.()) throw new Error('cancelled');
    const ctx = new OfflineAudioContext(1, 1, RATE);
    let audio;
    try {
      audio = await ctx.decodeAudioData(bytes);
    } catch {
      throw new Error('The browser cannot decode the audio of this media file');
    }
    return mixToMono(Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c)));
  }

  return { RATE, directMediaUrl, mixToMono, isSilent, encodeWav, toBase64, chunkRanges, segmentsToEvents, languageName, transcribeSamples, loadSamples };
})();
