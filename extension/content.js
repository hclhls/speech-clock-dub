// Content script (isolated world).
// The synthesized Japanese speech is the master clock; the <video> follows it by
// changing playbackRate and pausing/resuming. The original audio is muted.
(() => {
  'use strict';

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const site = YTD_PROV.pick(location); // per-site adapter, see providers.js
  let S = { ...YTD_DEFAULTS };

  const state = {
    active: false,
    gen: 0, // bumped on start/stop to cancel the producer loop
    video: null,
    ctx: null,
    gain: null,
    cues: [], // { start, end, text } in video seconds
    ja: [], // translated text per cue (kept even after audio is freed)
    jaP: [], // in-flight/finished translation promises per cue
    spkP: [], // in-flight/finished speaker-labelling promises per window (speakerVoices 'llm')
    spkWarm: null, // promise: the first two windows are labelled and checked for a monologue
    mono: false, // the labels looked like one speaker, so every cue keeps voice 0
    items: [], // { buffer, dur } | { failed: true, dur: 0 } per cue
    lang: 'English',
    idx: 0, // cue currently being scheduled
    phase: 'lead-in', // 'lead-in' (heading to cue start) | 'speaking'
    buffering: true,
    source: null,
    audioDone: false,
    held: false, // true when WE paused the video
    userPaused: false,
    ad: false,
    raf: 0,
    origMuted: false,
    origRate: 1,
    lastStatus: 0,
    local: null, // captions loaded from a local file: { local, kind, events }
    failStreak: 0, // consecutive failed cues
    lastError: '',
    lastT: 0, // previous video.currentTime seen by the scheduler
    starting: false, // start() is running (loading captions, segmenting)
    cancel: false, // the user clicked the button while starting
    pausedBySeg: false, // we paused the video while segmenting captions
    speechStart: 0, // ctx.currentTime when the current cue's speech started
    speechDur: 0, // its duration in seconds
    subKey: '', // what the cached subtitle pages were computed for
    subPages: null,
  };

  // Punctuation flags per video, so toggling the dub off and on does not redo the LLM pass.
  const asrCache = new Map();

  // ---------- messaging ----------

  const sendBg = (msg) =>
    new Promise((resolve, reject) =>
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (res?.ok) resolve(res.result);
        else reject(new Error(res?.error ?? 'No response from background'));
      }),
    );

  async function retry(fn, tries = 2) {
    let last;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (err) {
        last = err;
        await sleep(300);
      }
    }
    throw last;
  }

  function b64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // ---------- captions -> cues ----------

  // Merge caption fragments into sentence-sized cues.
  function buildCues(events, kind) {
    const dialogue = S.speakerVoices === 'alternate' && kind !== 'asr';
    let frags =
      kind === 'asr'
        ? YTD_ASR.words(events)
        : events
            .filter((e) => e.segs)
            .map((e) => ({
              start: e.tStartMs / 1000,
              end: (e.tStartMs + (e.dDurationMs ?? 0)) / 1000,
              text: YTD_ASR.stripSounds(e.segs.map((s) => s.utf8).join('')),
            }));
    frags = dialogue ? YTD_SPK.split(frags) : frags.map((f) => ({ ...f, text: f.text.replace(/\s+/g, ' ') }));
    frags = frags.filter((f) => f.text);

    const cues = [];
    let cur = null;
    const flush = () => {
      if (cur) cues.push(cur);
      cur = null;
    };
    for (const f of frags) {
      if (cur && (f.turn || f.start - cur.end > S.maxGapSec)) flush();
      if (!cur) cur = { start: f.start, end: f.end, text: f.text, turn: f.turn };
      else {
        cur.text += ' ' + f.text;
        cur.end = Math.max(cur.end, f.end);
      }
      if (/[.!?。！？]["')\]]?$/.test(cur.text) || cur.text.length >= S.maxCueChars) flush();
    }
    flush();
    if (dialogue) YTD_SPK.assign(cues);

    // Cues must not overlap: the scheduler moves strictly forward in video time.
    for (let i = 0; i < cues.length; i++) {
      if (i > 0 && cues[i].start < cues[i - 1].end) cues[i].start = cues[i - 1].end;
      if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.2;
    }
    return cues;
  }

  // ---------- production (translate + TTS ahead of playback) ----------

  const nextMissing = (from) => {
    for (let i = Math.max(0, from); i < state.cues.length; i++) if (!state.items[i]) return i;
    return -1;
  };

  // Seconds of synthesized audio ready, contiguous from the current cue.
  function readyAhead() {
    let sum = 0;
    for (let i = state.idx; i < state.items.length; i++) {
      const it = state.items[i];
      if (!it) break;
      sum += it.dur;
    }
    return sum;
  }

  // Translations run strictly in order (each one sees the previous translations as context)
  // while speech synthesis of earlier cues proceeds in parallel.
  function translateCue(i) {
    if (state.ja[i] !== undefined) return Promise.resolve(state.ja[i]);
    if (state.jaP[i]) return state.jaP[i];
    const p = (async () => {
      await state.jaP[i - 1]?.catch(() => {});
      const prev = [];
      for (let k = Math.max(0, i - S.contextCues); k < i; k++) {
        if (state.ja[k] !== undefined) prev.push({ src: state.cues[k].text, ja: state.ja[k] });
      }
      state.ja[i] = await retry(() =>
        sendBg({ type: 'translate', text: state.cues[i].text, prev, sourceLang: state.lang }),
      );
      return state.ja[i];
    })();
    state.jaP[i] = p;
    p.catch(() => {
      if (state.jaP[i] === p) state.jaP[i] = undefined; // allow a later retry
    });
    return p;
  }

  // speakerVoices 'llm': labels one window of cues. A window waits for the one before it when that has
  // started, because it shows those labels as context; after a seek it starts without context instead of
  // labelling everything in between. A failed window keeps the voice of the cue before it.
  function labelWindow(w) {
    if (state.spkP[w]) return state.spkP[w];
    state.spkP[w] = (async () => {
      const before = state.spkP[w - 1];
      await before;
      const from = w * YTD_SPK.WINDOW;
      const cues = state.cues.slice(from, from + YTD_SPK.WINDOW);
      if (!cues.length) return;
      const shown = before ? state.cues.slice(Math.max(0, from - YTD_SPK.CONTEXT), from) : [];
      const context = shown.map((c) => ({ text: c.text, voice: c.voice }));
      const prompt = YTD_SPK.labelPrompt(cues.map((c) => c.text), context);
      let voices = null;
      try {
        voices = YTD_SPK.parseLabels(await retry(() => sendBg({ type: 'label', prompt })), cues.length);
      } catch (err) {
        console.warn('[ytd] speaker labelling failed:', err);
      }
      let last = before ? state.cues[from - 1].voice : 0;
      cues.forEach((c, k) => {
        c.voice = voices ? voices[k] : last;
        last = c.voice;
      });
    })();
    return state.spkP[w];
  }

  // The first two windows are labelled before any speech is made, so that a lecture (one speaker) can
  // be recognised and keep a single voice from the start.
  function warmSpeakers() {
    state.spkWarm ??= (async () => {
      await labelWindow(0);
      await labelWindow(1);
      const first = state.cues.slice(0, 2 * YTD_SPK.WINDOW);
      if (YTD_SPK.isMonologue(first.map((c) => c.voice))) {
        state.mono = true;
        state.cues.forEach((c) => (c.voice = 0));
      }
    })();
    return state.spkWarm;
  }

  async function produceItem(i) {
    try {
      if (S.speakerVoices === 'llm') {
        await warmSpeakers();
        if (!state.mono) await labelWindow(Math.floor(i / YTD_SPK.WINDOW));
      }
      const text = await translateCue(i);
      const b64 = await retry(() => sendBg({ type: 'synthesize', text, alt: state.cues[i].voice === 1 }));
      const buffer = await state.ctx.decodeAudioData(b64ToArrayBuffer(b64));
      state.items[i] = { buffer, dur: buffer.duration };
      state.failStreak = 0;
    } catch (err) {
      console.warn('[ytd] cue', i, 'failed:', err);
      state.items[i] = { failed: true, dur: 0 };
      state.failStreak++;
      state.lastError = err.message;
    }
    // A dead LLM or TTS server would otherwise make every cue silently skip.
    if (state.failStreak >= 3 && state.active) {
      const msg = state.lastError;
      stop();
      setStatus(`Error: translation/TTS failed 3 times in a row (${msg})`);
    }
  }

  // Keep up to S.concurrency cues in flight (cloud TTS has a per-request latency of seconds).
  async function produceLoop(gen) {
    const inflight = new Set();
    while (state.active && gen === state.gen) {
      let next = -1;
      for (let i = Math.max(0, state.idx); i < state.cues.length; i++) {
        if (!state.items[i] && !inflight.has(i)) {
          next = i;
          break;
        }
      }
      if (next < 0 || inflight.size >= S.concurrency || readyAhead() >= S.targetAheadSec) {
        await sleep(100);
        continue;
      }
      inflight.add(next);
      produceItem(next).finally(() => inflight.delete(next));
    }
  }

  // ---------- playback scheduler ----------

  const adShowing = () => !!document.querySelector('.html5-video-player.ad-showing');

  function hold() {
    const v = state.video;
    if (!v.paused) {
      state.held = true;
      v.pause();
    }
  }

  function resume() {
    const v = state.video;
    if (v.paused && !state.userPaused) {
      state.held = false;
      v.play().catch(() => {});
    }
  }

  function startSpeech(item, cue) {
    const v = state.video;
    const src = state.ctx.createBufferSource();
    src.buffer = item.buffer;
    src.connect(state.gain);
    state.audioDone = false;
    src.onended = () => {
      if (state.source === src) state.audioDone = true;
    };
    state.source = src;
    src.start();
    state.speechStart = state.ctx.currentTime;
    state.speechDur = item.dur;
    // Make the remaining part of the cue last as long as the speech.
    const remaining = Math.max(cue.end - v.currentTime, 0.1);
    v.playbackRate = clamp(remaining / item.dur, S.minRate, S.maxRate);
  }

  function stopSpeech() {
    const src = state.source;
    state.source = null;
    state.audioDone = false;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {}
    }
  }

  function checkWater() {
    if (readyAhead() < S.lowWaterSec && nextMissing(state.idx) >= 0) state.buffering = true;
  }

  function tick() {
    state.raf = requestAnimationFrame(tick);
    const v = state.video;

    const ad = adShowing();
    if (ad !== state.ad) {
      state.ad = ad;
      v.muted = !ad;
      if (ad) state.ctx.suspend();
      else if (!state.userPaused) state.ctx.resume();
    }
    if (ad || state.userPaused) return;

    // YouTube may unmute (volume key) or reload the source (position jumps back); the
    // scheduler only ever moves forward, so treat a backward jump like a user seek.
    if (!v.muted) v.muted = true;
    if (v.currentTime < state.lastT - 1) onSeeking();
    state.lastT = v.currentTime;

    updateStatus();
    updateSubtitle();

    if (state.idx >= state.cues.length) {
      // Last cue spoken: hand the rest of the video back to its original audio and speed.
      stop();
      setStatus('Dub finished');
      return;
    }
    const cue = state.cues[state.idx];
    const item = state.items[state.idx];

    if (state.buffering) {
      hold();
      if (readyAhead() >= S.highWaterSec || nextMissing(state.idx) < 0) state.buffering = false;
      else return;
    }

    if (state.phase === 'lead-in') {
      if (!item) {
        // Hard underflow: the next cue has no audio yet.
        state.buffering = true;
        hold();
        return;
      }
      if (item.failed) {
        state.idx++;
        return;
      }
      if (v.currentTime >= cue.start - 0.05) {
        startSpeech(item, cue);
        state.phase = 'speaking';
      } else {
        resume();
        v.playbackRate = cue.start - v.currentTime > 3 ? S.gapRate : 1;
      }
      return;
    }

    // speaking
    if (state.audioDone) {
      state.source = null;
      state.items[state.idx - 4] = undefined; // free old audio; text stays in state.ja
      state.idx++;
      state.phase = 'lead-in';
      checkWater();
      return;
    }
    // Speech still running but the cue's video segment is over: freeze the slide.
    if (v.currentTime >= cue.end) hold();
    else resume();
  }

  // ---------- video event handlers ----------

  function onPause() {
    if (!state.active || state.held || state.video.ended || state.ad) return;
    state.userPaused = true;
    state.ctx.suspend();
  }

  function onPlay() {
    if (!state.active || !state.userPaused) return;
    state.userPaused = false;
    state.ctx.resume();
  }

  function onSeeking() {
    if (!state.active || state.ad) return;
    // The scheduler never seeks, so any seek is the user's: resync to the new position.
    stopSpeech();
    const t = state.video.currentTime;
    const i = state.cues.findIndex((c) => c.end > t);
    state.idx = i < 0 ? state.cues.length : i;
    state.phase = 'lead-in';
    state.buffering = true;
    state.lastT = t;
  }

  // ---------- lifecycle ----------

  // Restores punctuation in ASR captions with the LLM, then cuts cues at sentence ends. Windows
  // overlap and only their inner part is trusted, so they can be processed in parallel.
  async function segmentAsr(cap) {
    const words = YTD_ASR.words(cap.events);
    const key = `asr:${cap.videoId ?? 'local'}:${words.length}:${S.asrWindowWords}:${S.asrStrideWords}`;
    let flags = asrCache.get(key);
    if (!flags && cap.videoId) {
      // Persisted from an earlier session (a few KB per video).
      try {
        const saved = (await chrome.storage.local.get(key))[key];
        if (saved?.length === words.length) asrCache.set(key, (flags = YTD_ASR.decodeFlags(saved)));
      } catch {}
    }
    if (!flags) {
      // Hold the video while the LLM works (this can take a while on long videos).
      if (!state.video.paused) {
        state.held = true;
        state.pausedBySeg = true;
        state.video.pause();
      }
      flags = new Array(words.length).fill(null);
      const wins = YTD_ASR.windows(words.length, S.asrWindowWords, S.asrStrideWords);
      const margin = Math.floor((S.asrWindowWords - S.asrStrideWords) / 2);
      let next = 0;
      let done = 0;
      let failed = 0;
      const worker = async () => {
        while (!state.cancel) {
          const k = next++;
          if (k >= wins.length) return;
          const win = wins[k];
          const input = words.slice(win.from, win.to).map((w) => w.text);
          try {
            const text = await retry(() => sendBg({ type: 'punctuate', text: input.join(' '), sourceLang: state.lang }));
            const found = YTD_ASR.align(input, text);
            if (!found) throw new Error('the model changed the words');
            const { lo, hi } = YTD_ASR.trusted(win, k, wins.length, margin);
            for (let i = lo; i < hi; i++) flags[i] = found[i - win.from];
          } catch (err) {
            failed++;
            console.warn('[ytd] punctuation window', k, 'failed:', err.message);
          }
          setStatus(`Segmenting captions… ${++done}/${wins.length}`);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, S.asrConcurrency) }, worker));
      if (state.cancel) throw new Error('cancelled');
      if (failed) console.warn(`[ytd] ${failed}/${wins.length} windows without punctuation; cut by length instead`);
      if (!failed) {
        asrCache.set(key, flags);
        if (cap.videoId) chrome.storage.local.set({ [key]: YTD_ASR.encodeFlags(flags) }).catch(() => {});
      }
    }
    return YTD_ASR.cues(words, flags, S);
  }

  async function start() {
    // Create the AudioContext synchronously inside the click handler (autoplay policy).
    state.ctx = new AudioContext();
    state.gain = state.ctx.createGain();
    state.gain.connect(state.ctx.destination);
    state.ctx.resume();

    state.starting = true;
    state.cancel = false;
    try {
      await begin();
    } catch (err) {
      // Cancelled or failed while we were holding the video: let it run again.
      if (state.pausedBySeg) {
        state.held = false;
        state.video.play().catch(() => {});
      }
      throw err;
    } finally {
      state.pausedBySeg = false;
      state.starting = false;
    }
  }

  // Experimental speech-to-text (see extension/stt.js). The result is kept per video, so toggling the dub
  // off and on does not transcribe again.
  const sttCache = new Map();
  async function transcribeVideo(v) {
    const key = `${site.videoKey(location)}|${v.currentSrc || v.src}|${S.sttLanguage}|${S.sttModel}`;
    if (sttCache.has(key)) return sttCache.get(key);
    const url = YTD_STT.directMediaUrl(v);
    setStatus('No captions: downloading the audio…');
    const samples = await YTD_STT.loadSamples(url, { maxMB: S.sttMaxMB, isCancelled: () => state.cancel });
    const { events, language } = await YTD_STT.transcribeSamples(samples, {
      send: (wav) => retry(() => sendBg({ type: 'transcribe', wav })),
      isCancelled: () => state.cancel,
      onProgress: (i, n) => setStatus(`No captions: transcribing the audio… ${i}/${n}`),
    });
    if (!events.length) throw new Error('No speech was found in the audio');
    const cap = { events, kind: 'manual', languageName: language || 'English', stt: true };
    sttCache.set(key, cap);
    return cap;
  }

  async function begin() {
    S = { ...YTD_DEFAULTS, ...(await chrome.storage.sync.get(null)) };
    const v = (state.video = site.findVideo());
    if (!v) throw new Error('No <video> element found');

    setStatus('Loading captions…');
    let cap = state.local;
    if (!cap) {
      try {
        cap = await site.fetchCaptions();
      } catch (err) {
        // Experimental: no captions, so transcribe the audio if the user set that up.
        if (S.sttMode === 'fallback' && S.sttBaseUrl) {
          try {
            cap = await transcribeVideo(v);
          } catch (sttErr) {
            if (state.cancel || sttErr.message === 'cancelled') throw sttErr;
            throw new Error(`${err.message}. Speech-to-text also failed: ${sttErr.message}`);
          }
        } else {
          throw new Error(`${err.message}. Use "Load captions" to supply an SRT/VTT/JSON3 file.`);
        }
      }
    }
    if (state.cancel) throw new Error('cancelled');
    state.lang =
      cap.languageName ||
      (cap.local
        ? S.localCaptionLang
        : (new Intl.DisplayNames(['en'], { type: 'language' }).of(cap.languageCode) ?? 'English'));
    const cues =
      cap.kind === 'asr' && S.asrPunctuation === 'on' ? await segmentAsr(cap) : buildCues(cap.events, cap.kind);
    if (!cues.length) throw new Error('No usable caption text');

    state.cues = cues;
    state.ja = [];
    state.jaP = [];
    state.spkP = [];
    state.spkWarm = null;
    state.mono = false;
    state.items = [];
    state.failStreak = 0;
    state.userPaused = false;
    state.ad = false;
    state.held = false;
    state.audioDone = false;
    state.phase = 'lead-in';
    state.buffering = true;

    const i = cues.findIndex((c) => c.end > v.currentTime);
    state.idx = i < 0 ? cues.length : i;
    state.lastT = v.currentTime;

    state.origMuted = v.muted;
    state.origRate = v.playbackRate;
    v.muted = true;
    hold();

    v.addEventListener('pause', onPause);
    v.addEventListener('play', onPlay);
    v.addEventListener('seeking', onSeeking);

    state.active = true;
    const gen = ++state.gen;
    produceLoop(gen);
    state.raf = requestAnimationFrame(tick);
    setButton(true);
  }

  function stop() {
    if (!state.active) {
      state.ctx?.close().catch(() => {});
      return;
    }
    state.active = false;
    state.gen++;
    cancelAnimationFrame(state.raf);
    stopSpeech();
    const v = state.video;
    v.removeEventListener('pause', onPause);
    v.removeEventListener('play', onPlay);
    v.removeEventListener('seeking', onSeeking);
    v.muted = state.origMuted;
    v.playbackRate = state.origRate;
    // If we were the ones holding the video (buffering / freezing a slide), let it run again.
    if (state.held && !state.userPaused) {
      state.held = false;
      v.play().catch(() => {});
    }
    state.ctx.close().catch(() => {});
    setButton(false);
    setStatus('');
    updateSubtitle();
  }

  // ---------- HUD ----------

  const SUB_MODES = ['off', 'translated', 'both'];
  let hud, btn, statusEl, subBtn, subEl, subJa, subSrc, subMeasure;

  const findPlayer = () => site.findPlayer();

  function ensureHud() {
    // The HUD and the subtitle overlay can live in different containers (see below), so either can be
    // orphaned when YouTube replaces the player on navigation.
    if (hud?.isConnected && subEl?.isConnected) return;
    const player = findPlayer();
    if (!player) return;
    hud?.remove();
    subEl?.remove();
    subMeasure?.remove();
    // The HUD and subtitles are positioned against the player.
    if (getComputedStyle(player).position === 'static') player.style.position = 'relative';
    if (!document.getElementById('ytd-style')) {
      const style = document.createElement('style');
      style.id = 'ytd-style';
      style.textContent =
        site.css +
        '.ytd-hud{transition:opacity .25s}' +
        // Touch screens: larger tap targets, and the HUD stays visible and above the player's tap overlay
        // (there is no hover to bring auto-hidden controls back).
        '@media (pointer:coarse){.ytd-hud button{font-size:15px!important;padding:8px 14px!important;min-height:36px}' +
        '.html5-video-player.ytp-autohide .ytd-hud{opacity:1!important}' +
        '.ytd-hud{z-index:2147483647!important}' +
        // Hidden after a few idle seconds (see below); a hidden HUD must not eat the tap that wakes it.
        '.ytd-hud.ytd-idle,.html5-video-player.ytp-autohide .ytd-hud.ytd-idle{opacity:0!important}' +
        '.ytd-hud.ytd-idle button{pointer-events:none!important}}';
      document.head.append(style);
    }
    hud = document.createElement('div');
    hud.className = 'ytd-hud';
    hud.style.cssText =
      'position:absolute;left:12px;top:12px;z-index:38;display:flex;gap:8px;align-items:center;' +
      'font:12px system-ui,sans-serif;color:#fff;pointer-events:none;';
    btn = document.createElement('button');
    btn.style.cssText =
      'padding:4px 10px;border:0;border-radius:12px;background:rgba(0,0,0,.65);color:#fff;cursor:pointer;' +
      'pointer-events:auto;';
    statusEl = document.createElement('span');
    statusEl.style.cssText = 'padding:2px 6px;border-radius:8px;background:rgba(0,0,0,.45);';
    statusEl.hidden = true;

    const loadBtn = document.createElement('button');
    loadBtn.style.cssText = btn.style.cssText;
    loadBtn.textContent = 'Load captions';
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.srt,.vtt,.json,.json3';
    fileInput.hidden = true;
    loadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      try {
        const events = YTD_PROV.parseCaptionFile(f.name, await f.text());
        if (!events.length) throw new Error('no cues found');
        const asr = /\.json3?$/i.test(f.name) && events.some((e) => e.segs?.some((s) => 'acAsrConf' in s));
        state.local = { local: true, kind: asr ? 'asr' : 'manual', events };
        setStatus(`Loaded ${events.length} caption entries from ${f.name}`);
      } catch (err) {
        setStatus(`Caption file error: ${err.message}`);
      }
    });

    subBtn = document.createElement('button');
    subBtn.style.cssText = btn.style.cssText;
    subBtn.addEventListener('click', () => {
      S.subtitles = SUB_MODES[(SUB_MODES.indexOf(S.subtitles) + 1) % SUB_MODES.length];
      try {
        chrome.storage.sync.set({ subtitles: S.subtitles });
      } catch {} // orphaned after an extension reload; the toggle still works for this page
      setButton(state.active);
      updateSubtitle();
    });

    // Translated subtitle overlay (pointer-events:none so it never blocks the player).
    subEl = document.createElement('div');
    subEl.style.cssText =
      'position:absolute;left:50%;bottom:max(12%,72px);transform:translateX(-50%);z-index:37;' +
      // An explicit width: with left:50% the available width would be only half of the player.
      'box-sizing:border-box;width:max-content;max-width:80%;' +
      'pointer-events:none;text-align:center;color:#fff;background:rgba(0,0,0,.65);padding:4px 10px;' +
      'border-radius:6px;line-height:1.4;white-space:pre-wrap;text-shadow:0 1px 2px #000;';
    subEl.hidden = true;
    subJa = document.createElement('div');
    subSrc = document.createElement('div');
    subSrc.style.cssText = 'font-size:.85em;opacity:.85;';
    subEl.append(subJa, subSrc);

    // Invisible twin of the overlay, used to measure how many lines a text takes.
    subMeasure = document.createElement('div');
    subMeasure.style.cssText =
      'position:absolute;left:-9999px;top:0;visibility:hidden;pointer-events:none;text-align:center;' +
      'line-height:1.4;white-space:pre-wrap;padding:0;';

    hud.append(btn, loadBtn, fileInput, subBtn, statusEl);
    // The mobile player handles touches itself (toggling its controls, swallowing the click), so keep
    // touches on the HUD from reaching it.
    for (const type of ['touchstart', 'touchend', 'pointerdown', 'pointerup', 'mousedown', 'mouseup']) {
      hud.addEventListener(type, (e) => e.stopPropagation());
    }
    player.append(subEl, subMeasure);
    // m.youtube.com draws its touch controls in a sibling of the player, on top of everything inside it, so
    // the HUD has to live next to them to receive taps.
    const touchHost = location.hostname === 'm.youtube.com' ? player.closest('.player-container') : null;
    if (touchHost) {
      hud.style.top = '64px';
      touchHost.append(hud);
    } else {
      player.append(hud);
    }
    btn.addEventListener('click', async () => {
      if (state.active) return stop();
      if (state.starting) {
        state.cancel = true;
        return;
      }
      try {
        await start();
      } catch (err) {
        if (err.message === 'cancelled') {
          stop();
          setStatus('Cancelled');
          return;
        }
        console.error('[ytd]', err);
        stop();
        // After the extension is reloaded, tabs keep an orphaned copy of this script.
        setStatus(
          /context invalidated/i.test(err.message)
            ? 'Extension was reloaded: reload this tab (F5)'
            : `Error: ${err.message}`,
        );
      }
    });
    setButton(state.active);
  }

  function setButton(on) {
    if (btn) btn.textContent = `Dub (${S.targetLang}): ${on ? 'on' : 'off'}`;
    if (subBtn) subBtn.textContent = `Sub: ${S.subtitles}`;
  }

  // Show the translation (and optionally the original) of the cue being spoken. Text longer than
  // S.subtitleMaxLines lines is split into pages that follow the progress of the speech, so the
  // overlay never covers more of the video than that.
  function updateSubtitle() {
    if (!subEl) return;
    const text = state.active && state.phase === 'speaking' && S.subtitles !== 'off' ? state.ja[state.idx] : '';
    const cue = state.cues[state.idx];
    if (!text) {
      subEl.hidden = true;
      state.subKey = '';
      return;
    }

    const width = findPlayer()?.clientWidth ?? 800;
    const both = S.subtitles === 'both' && !!cue;
    const key = `${state.idx}|${both}|${S.subtitleMaxLines}|${width}`;
    if (state.subKey !== key) {
      state.subKey = key;
      const fontPx = clamp(width * 0.026, 14, 40);
      subEl.style.fontSize = `${fontPx}px`;
      // A text fits when it needs at most subtitleMaxLines lines at the width the overlay gets.
      const fitsAt = (scale) => (t) => {
        subMeasure.style.fontSize = `${fontPx * scale}px`;
        subMeasure.style.width = `${width * 0.8 - 20}px`;
        subMeasure.textContent = t;
        return !S.subtitleMaxLines || subMeasure.scrollHeight <= fontPx * scale * 1.4 * S.subtitleMaxLines + 1;
      };
      state.subPages = { ja: YTD_SUB.paginate(text, fitsAt(1)), src: both ? YTD_SUB.paginate(cue.text, fitsAt(0.85)) : null };
    }

    const progress = state.speechDur > 0 ? clamp((state.ctx.currentTime - state.speechStart) / state.speechDur, 0, 1) : 0;
    const { ja, src } = state.subPages;
    subJa.textContent = ja[YTD_SUB.pageAt(ja, progress)];
    subSrc.textContent = src ? src[YTD_SUB.pageAt(src, progress)] : '';
    subSrc.hidden = !src;
    subEl.hidden = false;
  }

  function setStatus(text) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.hidden = !text;
  }

  function updateStatus() {
    const now = performance.now();
    if (now - state.lastStatus < 250) return;
    state.lastStatus = now;
    const mode = state.buffering ? 'buffering' : state.phase;
    setStatus(`${mode} · cue ${state.idx + 1}/${state.cues.length} · ready ${readyAhead().toFixed(0)}s`);
  }

  // Keep settings fresh so the button shows the current target language.
  const refreshSettings = () =>
    chrome.storage.sync.get(null).then((v) => {
      if (!state.active) S = { ...YTD_DEFAULTS, ...v };
      setButton(state.active);
    });
  refreshSettings();
  chrome.storage.onChanged.addListener(refreshSettings);

  setInterval(ensureHud, 1000);

  // Touch screens are small, so the HUD fades out after a few idle seconds and returns on any touch.
  if (matchMedia('(pointer:coarse)').matches) {
    const HUD_IDLE_MS = 4000;
    let idleTimer;
    const wake = () => {
      hud?.classList.remove('ytd-idle');
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => hud?.classList.add('ytd-idle'), HUD_IDLE_MS);
    };
    // Capture phase, so the player cannot swallow the touch first.
    for (const type of ['touchstart', 'pointerdown']) window.addEventListener(type, wake, { capture: true, passive: true });
    setInterval(() => {
      // A freshly created HUD (new page, fullscreen) starts visible and gets its own countdown.
      if (hud && !hud.dataset.ytdSeen) {
        hud.dataset.ytdSeen = '1';
        wake();
      }
    }, 500);
  }
  // Leaving the watch page (SPA navigation) invalidates the cues.
  const leaveVideo = () => {
    state.local = null;
    if (state.active) stop();
  };
  for (const name of site.navEvents) document.addEventListener(name, leaveVideo);
  // Fallback for pages that fire no such event: the video key in the address changed.
  let watchedId = site.videoKey(location);
  setInterval(() => {
    const id = site.videoKey(location);
    if (id !== watchedId) {
      watchedId = id;
      if (state.active) leaveVideo();
    }
  }, 1000);
})();
