// Per-site adapters: how to find the video, where to put the HUD, how to read captions and how to
// notice that the page moved to another video. content.js only talks to the adapter returned by
// YTD_PROV.pick(), so supporting a new site means adding one entry here and one `matches` pattern
// in manifest.json. Loaded before content.js.
const YTD_PROV = (() => {
  // ---------- caption files (shared by the "Load captions" button and the <track> adapter) ----------

  // Parse SRT / WebVTT / JSON3 text into json3-style events.
  function parseCaptionFile(name, text) {
    if (/\.json3?$/i.test(name)) return JSON.parse(text).events ?? [];
    const toMs = (t) => {
      const p = t.trim().replace(',', '.').split(':').map(parseFloat);
      while (p.length < 3) p.unshift(0);
      return Math.round(((p[0] * 60 + p[1]) * 60 + p[2]) * 1000);
    };
    const events = [];
    for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
      const lines = block.split('\n');
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const [a, b] = lines[i].split('-->');
      const start = toMs(a);
      const end = toMs(b.trim().split(/\s+/)[0]);
      // Keep line breaks: a line starting with "- " marks a change of speaker.
      const body = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').replace(/[ \t]+/g, ' ').trim();
      if (body) events.push({ tStartMs: start, dDurationMs: end - start, segs: [{ utf8: body }] });
    }
    return events;
  }

  // ---------- YouTube ----------

  const youtube = {
    id: 'youtube',
    matches: (loc) => /(^|\.)youtube\.com$/.test(loc.hostname),
    // The desktop and mobile watch pages both use YouTube's html5 player; #movie_player is its usual id.
    findVideo: () => document.querySelector('video.html5-main-video') ?? document.querySelector('video'),
    findPlayer: () => document.getElementById('movie_player') ?? document.querySelector('.html5-video-player'),
    // Keep clear of YouTube's own chrome: the title bar (top, fullscreen and embeds) and the control bar
    // (bottom). The HUD sits below the title bar and fades out together with the controls.
    css:
      '.html5-video-player.ytp-fullscreen .ytd-hud,.html5-video-player.ytp-embed .ytd-hud{top:64px!important}' +
      '.html5-video-player.ytp-autohide .ytd-hud{opacity:0;transition:opacity .25s}',
    videoKey: (loc) => new URLSearchParams(loc.search).get('v'),
    // Events that mean "the page is leaving this video" (SPA navigation).
    navEvents: ['yt-navigate-start', 'state-navigatestart'], // the second one is m.youtube.com
    // The MAIN-world page hook (page-hook.js) reads the caption track; ask it through postMessage.
    fetchCaptions() {
      return new Promise((resolve, reject) => {
        const reqId = crypto.randomUUID();
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMsg);
          reject(new Error('Timed out waiting for captions'));
        }, 25000); // page-hook may wait up to 10 s for the player's own caption request
        function onMsg(e) {
          if (e.source !== window || e.data?.type !== 'ytd:captions' || e.data.reqId !== reqId) return;
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data);
        }
        window.addEventListener('message', onMsg);
        window.postMessage({ type: 'ytd:get-captions', reqId }, '*');
      });
    },
  };

  // ---------- Udemy (and any site whose player exposes standard <track> elements) ----------

  // Udemy builds its class names with CSS modules (video-player--container--xYz12), so match on the stable part.
  const UDEMY_PLAYER = '[data-purpose="video-player"],[class*="video-player--container"],[class*="video-viewer--container"]';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // "en_US" -> "en-US"; anything Intl.DisplayNames would reject becomes 'en'.
  const langCode = (t) => {
    const code = (t.srclang || t.language || '').replace('_', '-');
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(code) ? code : 'en';
  };

  // Read the caption cues the browser already holds for a <track>. The track has to be in
  // `hidden` mode (not `disabled`) for the browser to load its cues; `hidden` shows nothing.
  async function cuesOf(textTrack) {
    const was = textTrack.mode;
    if (was === 'disabled') textTrack.mode = 'hidden';
    try {
      for (let i = 0; i < 20 && !textTrack.cues?.length; i++) await sleep(250);
      return [...(textTrack.cues ?? [])].map((c) => ({
        tStartMs: Math.round(c.startTime * 1000),
        dDurationMs: Math.round((c.endTime - c.startTime) * 1000),
        segs: [{ utf8: String(c.text ?? '').replace(/<[^>]+>/g, '') }],
      }));
    } finally {
      textTrack.mode = was;
    }
  }

  async function fetchTrackCaptions(video) {
    const elements = [...video.querySelectorAll('track')].filter((t) => /^(subtitles|captions)$/.test(t.kind || 'subtitles'));
    const tracks = [...video.textTracks].filter((t) => /^(subtitles|captions)$/.test(t.kind));
    if (!elements.length && !tracks.length) throw new Error('This video exposes no caption tracks');

    // Prefer the track the player marked as default, then the first one.
    const el = elements.find((t) => t.default) ?? elements[0];
    const languageCode = langCode(el ?? tracks[0]);
    let events = [];
    if (el?.src) {
      try {
        const res = await fetch(el.src, { credentials: 'include' });
        if (res.ok) events = parseCaptionFile('track.vtt', await res.text());
      } catch {} // fall through to the cues the browser loaded
    }
    if (!events.length) {
      const tt = (el && tracks.find((t) => t.label === el.label && t.language === el.srclang)) ?? tracks[0];
      if (tt) events = await cuesOf(tt);
    }
    if (!events.length) throw new Error('The caption track is empty');
    return { languageCode, kind: 'manual', events };
  }

  // Udemy draws its own captions and never adds <track> elements, so ask the same API the player uses:
  // /course/<slug>/learn/lecture/<id> -> course id -> the lecture's asset.captions[].url (WebVTT).
  function udemyLectureRef(pathname) {
    const m = /^\/course\/([^/]+)\/learn\/lecture\/(\d+)/.exec(pathname);
    return m ? { slug: m[1], lectureId: m[2] } : null;
  }

  function pickUdemyCaption(captions) {
    const c = (captions ?? []).find((x) => x?.url);
    return c ? { url: c.url, languageCode: langCode({ language: c.locale_id }) } : null;
  }

  async function fetchUdemyCaptions() {
    const ref = udemyLectureRef(location.pathname);
    if (!ref) throw new Error('Open a lecture first');
    const api = async (path) => {
      const res = await fetch(`/api-2.0/${path}`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Udemy API returned HTTP ${res.status}`);
      return res.json();
    };
    const course = await api(`courses/${ref.slug}/?fields[course]=id`);
    const lecture = await api(
      `users/me/subscribed-courses/${course.id}/lectures/${ref.lectureId}/?fields[lecture]=asset&fields[asset]=captions`,
    );
    const cap = pickUdemyCaption(lecture.asset?.captions);
    if (!cap) throw new Error('Udemy lists no captions for this lecture');
    const res = await fetch(cap.url);
    if (!res.ok) throw new Error(`Caption file returned HTTP ${res.status}`);
    const events = parseCaptionFile('captions.vtt', await res.text());
    if (!events.length) throw new Error('The caption track is empty');
    return { languageCode: cap.languageCode, kind: 'manual', events };
  }

  const udemy = {
    id: 'udemy',
    matches: (loc) => /(^|\.)udemy\.com$/.test(loc.hostname),
    findVideo: () => document.querySelector('video'),
    findPlayer() {
      const v = document.querySelector('video');
      return v ? (v.closest(UDEMY_PLAYER) ?? v.parentElement) : null;
    },
    css: '',
    // Lectures are /course/<slug>/learn/lecture/<id>: the address changes without a page load.
    videoKey: (loc) => loc.pathname,
    navEvents: [],
    async fetchCaptions() {
      const v = document.querySelector('video');
      if (!v) throw new Error('No <video> element found');
      try {
        return await fetchUdemyCaptions();
      } catch (apiErr) {
        try {
          return await fetchTrackCaptions(v);
        } catch {
          throw apiErr; // the API error is the more useful one
        }
      }
    },
  };

  // ---------- Vimeo ----------

  // Vimeo plays every video inside a player.vimeo.com frame (on vimeo.com and on embedding sites alike), so
  // this adapter runs in that frame. The player's config JSON lists the caption files:
  // /video/<id>/config -> request.text_tracks[] = { lang, label, kind, url (WebVTT, usually relative) }.
  const vimeoVideoId = (pathname) => /^\/video\/(\d+)/.exec(pathname)?.[1] ?? null;

  // Prefer a human-made caption or subtitle track over an auto-generated one ("en-x-autogen"), then the first.
  function pickVimeoTrack(tracks) {
    const usable = (tracks ?? []).filter((t) => t?.url && (!t.kind || /^(captions|subtitles)$/.test(t.kind)));
    return usable.find((t) => !/autogen/i.test(t.lang ?? '')) ?? usable[0] ?? null;
  }

  async function fetchVimeoCaptions() {
    const id = vimeoVideoId(location.pathname);
    if (!id) throw new Error('Open a Vimeo video first');
    // Keep the query string: private and unlisted videos carry their hash in it (?h=...).
    const res = await fetch(`/video/${id}/config${location.search}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Vimeo player config returned HTTP ${res.status}`);
    const config = await res.json();
    const track = pickVimeoTrack(config.request?.text_tracks);
    if (!track) throw new Error('Vimeo lists no captions for this video');
    const file = await fetch(new URL(track.url, location.href), { credentials: 'include' });
    if (!file.ok) throw new Error(`Caption file returned HTTP ${file.status}`);
    const events = parseCaptionFile('captions.vtt', await file.text());
    if (!events.length) throw new Error('The caption track is empty');
    return { languageCode: langCode({ language: track.lang }), kind: 'manual', events };
  }

  const vimeo = {
    id: 'vimeo',
    matches: (loc) => loc.hostname === 'player.vimeo.com',
    findVideo: () => document.querySelector('video'),
    findPlayer() {
      const v = document.querySelector('video');
      return v ? (v.closest('.vp-video-wrapper,.player,[class*="vp-player"]') ?? v.parentElement) : null;
    },
    css: '',
    videoKey: (loc) => loc.pathname,
    navEvents: [],
    async fetchCaptions() {
      const v = document.querySelector('video');
      if (!v) throw new Error('No <video> element found');
      try {
        return await fetchVimeoCaptions();
      } catch (apiErr) {
        try {
          return await fetchTrackCaptions(v);
        } catch {
          throw apiErr; // the config error is the more useful one
        }
      }
    },
  };

  const providers = [youtube, udemy, vimeo];
  const pick = (loc) => providers.find((p) => p.matches(loc)) ?? youtube;

  return { parseCaptionFile, pick, providers, udemyLectureRef, pickUdemyCaption, vimeoVideoId, pickVimeoTrack };
})();
