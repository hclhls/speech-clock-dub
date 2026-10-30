# Project instructions

## Communication

- Always reply to the user in Japanese, regardless of the language the user writes in.
- All documentation (README, CLAUDE.md, docs/), code comments, and commit messages must be written in plain English.
  The one exception is the translated READMEs (`README.ja.md`, `README.ko.md`, `README.zh-TW.md`,
  `README.zh-CN.md`), which the user asked for. `README.md` (English) is the source of truth: when
  it changes, update the translations to match.

## Project

Chrome MV3 extension that dubs YouTube (and, experimentally, Udemy and Vimeo) lecture videos (mostly static slides) into Japanese, English,
Traditional/Simplified Chinese or Korean.
The synthesized speech is the master clock; the video is the slave. The extension adjusts
`playbackRate` and pauses/resumes the `<video>` element to follow the speech, never the other way around.

Pipeline: YouTube captions -> sentence segmentation -> local LLM translation (OpenAI-compatible endpoint)
-> TTS (VOICEVOX for Japanese, edge-tts via a local bridge for other languages) -> Web Audio queue with high/low watermarks.

## Layout

- `extension/manifest.json` - MV3 manifest
- `extension/defaults.js` - shared default settings (loaded by background, content script and options page)
- `extension/page-hook.js` - runs in the page's MAIN world; reads caption tracks from the YouTube player
- `extension/asr.js` - pure helpers for auto-generated captions (word flattening, LLM punctuation windows, alignment, sentence-based cues)
- `extension/speakers.js` - pure helpers for dialogue captions (speaker-change markers, alternating voices, LLM speaker labelling)
- `extension/subtitle.js` - pure helpers that split long subtitle text into pages of a few lines
- `extension/providers.js` - per-site adapters (YouTube, Udemy, Vimeo): find the video and player, fetch captions, detect navigation; also the SRT/VTT parser
- `extension/content.js` - captions -> cues, production loop, playback scheduler, HUD
- `extension/background.js` - service worker; bridges to the LLM and TTS HTTP servers
- `extension/options.html`, `extension/options.js` - settings UI
- `tools/edge_tts_server.py` - local HTTP bridge around edge-tts (run with `.venv/bin/python`)
- `tests/` - unit tests; `npm test` for the extension, `python -m unittest discover -s tests -p "test_*.py"` for the bridge
- `.github/workflows/ci.yml` - CI (syntax check, ruff, both test suites)
