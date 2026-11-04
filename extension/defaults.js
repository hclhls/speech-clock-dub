// Shared default settings. Loaded by the service worker (importScripts),
// the content script and the options page. Stored overrides live in chrome.storage.sync.

// Target languages: how the LLM is told to write, and the default edge-tts voice per gender.
const YTD_LANGS = {
  ja: {
    name: 'Japanese',
    style: 'natural spoken Japanese (polite desu/masu style)',
    voices: { female: 'ja-JP-NanamiNeural', male: 'ja-JP-KeitaNeural' },
    google: { code: 'ja-JP', voices: { female: 'ja-JP-Wavenet-B', male: 'ja-JP-Wavenet-C' } },
    levels: {
      easy: 'Use simple Japanese for learners at about JLPT N5 to N3: common words, short sentences, and plain explanations of difficult words instead of rare kanji compounds.',
      advanced: 'Use more advanced Japanese at about JLPT N3 to N1: precise vocabulary, kanji compounds and formal written-style expressions where they fit.',
    },
    // Observed mistranslation: "Welcome back" came out as 「お帰りください」 ("please go home").
    extraRule:
      '"Welcome back" is a greeting to returning viewers: say 「引き続き…へようこそ」 or 「おかえりなさい」, never 「お帰りください」.',
  },
  en: {
    name: 'English',
    style: 'natural spoken English',
    voices: { female: 'en-US-AriaNeural', male: 'en-US-GuyNeural' },
    google: { code: 'en-US', voices: { female: 'en-US-Wavenet-F', male: 'en-US-Wavenet-D' } },
  },
  'zh-TW': {
    name: 'Traditional Chinese',
    style: 'natural spoken Mandarin as used in Taiwan, written in Traditional Chinese characters',
    voices: { female: 'zh-TW-HsiaoChenNeural', male: 'zh-TW-YunJheNeural' },
    google: { code: 'cmn-TW', voices: { female: 'cmn-TW-Wavenet-A', male: 'cmn-TW-Wavenet-B' } },
  },
  'zh-CN': {
    name: 'Simplified Chinese',
    style: 'natural spoken Mandarin as used in mainland China, written in Simplified Chinese characters',
    voices: { female: 'zh-CN-XiaoxiaoNeural', male: 'zh-CN-YunxiNeural' },
    google: { code: 'cmn-CN', voices: { female: 'cmn-CN-Wavenet-A', male: 'cmn-CN-Wavenet-B' } },
  },
  ko: {
    name: 'Korean',
    style: 'natural spoken Korean (polite haeyo/hapnida style)',
    voices: { female: 'ko-KR-SunHiNeural', male: 'ko-KR-InJoonNeural' },
    google: { code: 'ko-KR', voices: { female: 'ko-KR-Wavenet-A', male: 'ko-KR-Wavenet-C' } },
  },
  es: {
    name: 'Spanish',
    style: 'natural spoken Spanish (neutral, as understood across Spain and Latin America)',
    voices: { female: 'es-ES-ElviraNeural', male: 'es-ES-AlvaroNeural' },
    google: { code: 'es-ES', voices: { female: 'es-ES-Wavenet-C', male: 'es-ES-Wavenet-B' } },
  },
  pt: {
    name: 'Portuguese',
    style: 'natural spoken Brazilian Portuguese',
    voices: { female: 'pt-BR-FranciscaNeural', male: 'pt-BR-AntonioNeural' },
    google: { code: 'pt-BR', voices: { female: 'pt-BR-Wavenet-A', male: 'pt-BR-Wavenet-B' } },
  },
  it: {
    name: 'Italian',
    style: 'natural spoken Italian',
    voices: { female: 'it-IT-ElsaNeural', male: 'it-IT-DiegoNeural' },
    google: { code: 'it-IT', voices: { female: 'it-IT-Wavenet-A', male: 'it-IT-Wavenet-C' } },
  },
  fr: {
    name: 'French',
    style: 'natural spoken French',
    voices: { female: 'fr-FR-DeniseNeural', male: 'fr-FR-HenriNeural' },
    google: { code: 'fr-FR', voices: { female: 'fr-FR-Wavenet-A', male: 'fr-FR-Wavenet-B' } },
  },
  de: {
    name: 'German',
    style: 'natural spoken German',
    voices: { female: 'de-DE-KatjaNeural', male: 'de-DE-ConradNeural' },
    google: { code: 'de-DE', voices: { female: 'de-DE-Wavenet-F', male: 'de-DE-Wavenet-B' } },
  },
  nl: {
    name: 'Dutch',
    style: 'natural spoken Dutch',
    voices: { female: 'nl-NL-ColetteNeural', male: 'nl-NL-MaartenNeural' },
    google: { code: 'nl-NL', voices: { female: 'nl-NL-Wavenet-A', male: 'nl-NL-Wavenet-B' } },
  },
  ru: {
    name: 'Russian',
    style: 'natural spoken Russian',
    voices: { female: 'ru-RU-SvetlanaNeural', male: 'ru-RU-DmitryNeural' },
    google: { code: 'ru-RU', voices: { female: 'ru-RU-Wavenet-A', male: 'ru-RU-Wavenet-B' } },
  },
};

// Wording of the translationLevel rule for languages without their own `levels` in YTD_LANGS.
const YTD_LEVELS = {
  easy: 'Use simple wording for language learners: common words, short sentences, and plain explanations of difficult words.',
  advanced: 'Use more advanced wording: precise vocabulary and formal written-style expressions where they fit.',
};

const YTD_DEFAULTS = {
  targetLang: 'ja', // a key of YTD_LANGS
  // How hard the translated wording is: 'standard' (no extra rule), 'easy' (for learners; JLPT N5-N3 for
  // Japanese) or 'advanced' (JLPT N3-N1 for Japanese). The meaning is never changed.
  translationLevel: 'standard', // 'standard' | 'easy' | 'advanced'
  voiceGender: 'female', // 'female' | 'male'
  // 'alternate': for dialogue captions that mark a change of speaker ('- ' or '>>'), the voices alternate
  // between voiceGender and the opposite gender. Needs captions with markers (not auto-generated ones).
  speakerVoices: 'off', // 'off' | 'alternate' (captions with "- " / ">>" markers) | 'llm' (experimental: the LLM labels who speaks)
  subtitles: 'off', // on-screen subtitles: 'off' | 'translated' | 'both' (translation + original)
  subtitleMaxLines: 2, // longer text is shown in pages of this many lines; 0 = no limit
  // 'auto' = VOICEVOX for Japanese, edge-tts for every other language. 'google' = Google Cloud
  // Text-to-Speech. The default is Google Cloud TTS, a paid online service: the translated text is sent to
  // Google. 'auto' (VOICEVOX for Japanese, edge-tts otherwise) is the local setup described in the README.
  ttsProvider: 'google', // 'auto' | 'voicevox' | 'edge' | 'google'
  // Per-speaker overrides: slot 1 is the first speaker (and every cue of a single-speaker video), slot 2 the
  // second speaker of a dialogue (speakerVoices 'alternate' or 'llm'). An empty provider uses ttsProvider; an empty voice uses the defaults below
  // (slot 2 gets the gender opposite to voiceGender). A voice is a VOICEVOX style id, an edge-tts voice
  // name or a Google voice name, matching the provider. Mixing providers is allowed, e.g. two female
  // voices, one from VOICEVOX and one from Google.
  voice1Provider: '', // '' | 'auto' | 'voicevox' | 'edge' | 'google'
  voice1Voice: '',
  voice2Provider: '',
  voice2Voice: '',

  // OpenAI-compatible chat completions endpoint. The default is Google's Gemini API, which needs llmApiKey
  // (the subtitle text is sent to Google). For a local server such as Unsloth use
  // 'http://127.0.0.1:8888/v1' and a model name it serves.
  llmBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  llmModel: 'gemini-3.1-flash-lite',
  llmApiKey: '',
  // JSON merged into every chat completion request. Hosted APIs may reject unknown fields, so the default
  // is empty. A local Gemma 4 needs '{"chat_template_kwargs":{"enable_thinking":false}}': with thinking
  // on it can spend minutes on a single subtitle line and return no content.
  llmExtraBody: '{}',
  llmTimeoutSec: 60,

  // VOICEVOX engine.
  voicevoxUrl: 'http://localhost:50021',
  speakerFemale: 2, // VOICEVOX style id (四国めたん ノーマル)
  speakerMale: 11, // VOICEVOX style id (玄野武宏 ノーマル); GET /speakers lists them
  ttsSpeed: 1.25, // speedScale; a faster voice means less slow-down of the video

  // edge-tts bridge (tools/edge_tts_server.py). Empty voice = default for targetLang and voiceGender.
  edgeUrl: 'http://127.0.0.1:5050',
  edgeVoice: '',
  edgeRate: '+0%', // e.g. '+10%' for a faster voice

  // Google Cloud Text-to-Speech (ttsProvider 'google'). Empty voice = default for targetLang and voiceGender.
  googleApiKey: '',
  googleVoice: '',
  googleSpeed: 1.15, // speakingRate, 0.25 to 4

  // Experimental: speech-to-text for videos without captions. 'fallback' transcribes the audio when no
  // captions can be found; 'off' never does. It works only for videos that are a plain media file (mp4,
  // webm ...), not for streams. The audio is sent to sttBaseUrl, an OpenAI-compatible endpoint with
  // /audio/transcriptions (OpenAI, Groq, whisper.cpp server, faster-whisper-server ...). Empty = unusable.
  sttMode: 'off', // 'off' | 'fallback'
  sttBaseUrl: '', // e.g. 'http://127.0.0.1:8080/v1'
  sttModel: 'whisper-1',
  sttApiKey: '',
  sttLanguage: '', // spoken language as an ISO code such as 'en'; empty = detect
  sttTimeoutSec: 300, // per audio chunk
  sttMaxMB: 200, // larger media files are refused (the whole file is decoded in memory)

  // Language name given to the LLM when captions come from a local file.
  localCaptionLang: 'English',

  // Auto-generated (ASR) captions have no punctuation. With 'on' the LLM restores it first, so cues
  // end at sentence boundaries; windows overlap and are processed in parallel.
  asrPunctuation: 'on', // 'on' | 'off'
  asrWindowWords: 120,
  asrStrideWords: 108, // neighbouring windows overlap by 12 words
  asrConcurrency: 4, // parallel punctuation requests (nothing else runs while segmenting)

  // Segmentation.
  contextCues: 3, // previous translated cues given to the LLM as context
  maxGapSec: 1.5, // a longer gap between caption fragments ends a sentence
  maxCueChars: 200, // force-flush a sentence beyond this length

  // Buffering (seconds of synthesized audio).
  lowWaterSec: 10, // at a cue boundary, rebuffer if less than this is ready
  highWaterSec: 40, // resume playback once this much is ready
  targetAheadSec: 90, // the producer stops once this much is ready ahead
  concurrency: 3, // cues translated/synthesized in parallel

  // Video rate control.
  minRate: 0.5,
  maxRate: 1.5,
  gapRate: 2, // rate used while crossing long silent gaps between cues
};

// Built-in settings profiles of the options page: only the values that differ from YTD_DEFAULTS.
// API keys are never part of a profile. User profiles are stored as "profile:<name>" in chrome.storage.sync.
const YTD_PRESETS = {
  'Hosted (Gemini + Google TTS)': {},
  'Local (Unsloth + VOICEVOX / edge-tts)': {
    llmBaseUrl: 'http://127.0.0.1:8888/v1',
    llmModel: 'unsloth/gemma-4-12B-it-qat-GGUF',
    llmExtraBody: '{"chat_template_kwargs":{"enable_thinking":false}}',
    ttsProvider: 'auto',
  },
  // Free voice: the edge-tts bridge (tools/edge_tts_server.py) instead of the paid Google TTS.
  'Gemini + edge-tts (free voice)': { ttsProvider: 'edge' },
  // Translation stays on your machine; only the translated text goes to Google TTS.
  'Local LLM + Google TTS': {
    llmBaseUrl: 'http://127.0.0.1:8888/v1',
    llmModel: 'unsloth/gemma-4-12B-it-qat-GGUF',
    llmExtraBody: '{"chat_template_kwargs":{"enable_thinking":false}}',
  },
  // Interviews and podcasts: the voice alternates at every change of speaker (hosted services).
  'Interview / podcast (two voices)': { speakerVoices: 'alternate' },
};

// Host permission patterns (port-less, as Chrome requires) for the configured servers that are not on this
// machine and are not already covered by the manifest. The options page asks for them at run time.
// Hosts that manifest.json already grants over https (kept in sync by a test).
const YTD_MANIFEST_HOSTS = ['texttospeech.googleapis.com', 'generativelanguage.googleapis.com'];

function ytdRemoteOrigins(settings) {
  const origins = new Set();
  for (const key of ['llmBaseUrl', 'voicevoxUrl', 'edgeUrl', 'sttBaseUrl']) {
    let url;
    try {
      url = new URL(settings[key]);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    // The manifest covers plain-http localhost only; IPv6 literals are not valid match patterns.
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) continue;
    if (url.hostname.startsWith('[')) continue;
    if (url.protocol === 'https:' && YTD_MANIFEST_HOSTS.includes(url.hostname)) continue;
    origins.add(`${url.protocol}//${url.hostname}/*`);
  }
  return [...origins];
}
