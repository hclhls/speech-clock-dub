# speech-clock-dub

[![CI](https://github.com/Nexplico-Ltd/speech-clock-dub/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Nexplico-Ltd/speech-clock-dub/actions/workflows/ci.yml)

**English** | [日本語](README.ja.md) | [한국어](README.ko.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

> This English README is the source of truth; the translations may lag behind it.

YouTube dubbing for lectures where the video follows the voice.

A Chrome and Firefox (MV3) extension that dubs YouTube (and, experimentally, Udemy and Vimeo) lecture videos into Japanese, English, Traditional
Chinese, Simplified Chinese or Korean. It is designed for videos that are essentially slideshows:
instead of squeezing the translated speech to fit the picture, **the picture follows the speech**.

## How it works

```
YouTube captions -> sentence cues -> LLM translation -> TTS (VOICEVOX / edge-tts) -> Web Audio queue
                                                                            |
                              <video> playbackRate / pause / play  <--------+
```

- The synthesized audio is the master clock. The original audio is muted.
- For each cue the video's `playbackRate` is set to `remaining_cue_time / speech_duration`,
  clamped to `[minRate, maxRate]`.
- If the speech outlasts the cue's video segment, the video is paused (frozen slide) until the
  speech ends. If the speech is shorter, the video plays on at a faster rate to the next cue.
- Long silent gaps between cues are crossed at `gapRate`.
- A producer loop translates and synthesizes cues ahead of playback. Translations run in order (each
  sees the previous ones as context); speech synthesis runs up to `concurrency` cues in parallel,
  which matters for cloud TTS where each request takes seconds. At a cue boundary, if less
  than `lowWaterSec` of audio is ready, the video pauses and resumes only once `highWaterSec`
  is ready (hysteresis). Because the video is the slave, an underflow never causes desync; it
  only pauses the video. Playback is never interrupted in the middle of a sentence.
- User pause/play pauses/resumes the audio too; a user seek re-syncs the cue index.
  Ads are detected (`.ad-showing`) and suspend the scheduler.

## Setup

### Quick start (default): hosted services

The default settings use two hosted Google services and need **no local server**. You need a Google
Cloud / AI Studio account and two API keys (they may be the same key if it is enabled for both APIs):

1. **Gemini API key** for the translation. Create it in [Google AI Studio](https://aistudio.google.com/apikey)
   and paste it into `llmApiKey` in the options page. The defaults (`llmBaseUrl` =
   `https://generativelanguage.googleapis.com/v1beta/openai`, `llmModel` = `gemini-3.1-flash-lite`) use
   Gemini's OpenAI-compatible endpoint. Any other hosted OpenAI-compatible service (OpenAI, Groq,
   OpenRouter, ...) works too: set `llmBaseUrl`, `llmModel` and `llmApiKey`. Chrome asks once for access
   to that host when you press Save.
2. **Google Cloud Text-to-Speech key** for the voice. Enable the Cloud Text-to-Speech API in a Google
   Cloud project, create an API key, and paste it into `googleApiKey`. `ttsProvider` is already `google`.

The defaults are the cheapest options: `gemini-3.1-flash-lite` for the translation and WaveNet voices for the speech (at the time of writing, Google lists WaveNet at the same price as Standard voices, a quarter of the Neural2 price, with a monthly free quota). Prices change, so check Google's pricing pages. The better-sounding Neural2 and Chirp 3 HD voices can be set with `googleVoice`.

**Both services are paid (each has a free quota; check Google's pricing), and the subtitle text and its
translation are sent to Google.** The keys are stored in `chrome.storage.sync` like all settings, so
restrict the Text-to-Speech key to that API in the Google Cloud console (and restrict the Gemini key too if Google offers that for it). If a key is missing, the status line shows
an error that names it. This default setup has not been run end to end by the maintainers yet; the local
setup below is the one that has been used the most.

Only `localhost` / `127.0.0.1`, `texttospeech.googleapis.com` and `generativelanguage.googleapis.com`
are in `host_permissions`. Servers on other hosts are allowed at run time, see below.

### Advanced: local servers (optional)

For free, private dubbing run your own servers and point the settings at them: set `llmBaseUrl`,
`llmModel` and `llmExtraBody` for the LLM, and `ttsProvider` to `auto` (VOICEVOX for Japanese, edge-tts
otherwise), `voicevox` or `edge`.

1. **An OpenAI-compatible LLM endpoint** (e.g. the Unsloth service) serving a Gemma 12B-class
   model. Set `llmBaseUrl` (the URL that ends in `/v1`, e.g. `http://127.0.0.1:8888/v1`) and `llmModel`.
   For Gemma 4 also set `llmExtraBody` to `{"chat_template_kwargs":{"enable_thinking":false}}`, otherwise
   thinking can take minutes per line. The extension calls `POST {llmBaseUrl}/chat/completions`.
2. **VOICEVOX engine** (open source, high-quality Japanese TTS):

   ```
   # GPU (requires nvidia-container-toolkit). The image's default command already passes
   # --use_gpu --host 0.0.0.0, so do not append arguments: they would replace that command.
   docker run -d --rm --name voicevox --gpus all -p 50021:50021 voicevox/voicevox_engine:nvidia-latest
   # CPU only
   docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-latest
   ```

   VOICEVOX needs roughly 1-2 GB of VRAM, so it can share a 16 GB GPU with a 12B LLM.

   Each voice character has its own terms of use; check them before publishing dubbed videos.
   `speakerFemale` / `speakerMale` are VOICEVOX style ids (`GET /speakers` lists them).

   **VRAM:** each additional VOICEVOX voice loads another model on the GPU. With a 12B LLM that
   reserves nearly all of a 16 GB card (e.g. a very large context window), the first voice may work
   while another one fails with a CUDA out-of-memory error (HTTP 500 on `/synthesis`). Dubbing needs
   only a small LLM context (a few thousand tokens), so lower the context length when loading the
   model. Measured on a 16 GB RTX 4060 Ti with Gemma 4 12B (Q4): at a 262144-token context
   llama-server used 14.2 GB (about 0.5 GB free, male voices failed); at 16384 it used 9.5 GB
   (about 3.9 GB free with VOICEVOX loaded, both voices work) and translation got faster
   (0.5 s -> 0.3 s per sentence).

   Alternatively run VOICEVOX on the CPU (about 0.5x real time per sentence). Omit `--use_gpu` by
   overriding the image's command: `... voicevox_engine:nvidia-latest gosu user
   /opt/voicevox_engine/run --host 0.0.0.0`.

3. **edge-tts bridge** (only for non-Japanese targets, or Japanese if you prefer it over VOICEVOX).
   edge-tts uses Microsoft's online speech service through an unofficial API, so **the translated
   text is sent to Microsoft**, it needs internet access, and it may break if the service changes.
   A small local HTTP bridge exposes it to the extension:

   ```
   python3 -m venv .venv && .venv/bin/pip install edge-tts
   .venv/bin/python tools/edge_tts_server.py        # listens on 127.0.0.1:5050
   ```

   `--port` changes the port (then update `edgeUrl`). Expect 2-3 s per sentence; the parallel
   producer hides this once the buffer has filled, but the first start takes longer than with VOICEVOX.

   If synthesis fails with `403 Invalid response status`, Microsoft has changed its service and your
   edge-tts is out of date: run `.venv/bin/pip install -U edge-tts` and restart the bridge.

## Profiles

The options page has a **Profile** box for switching between whole configurations, for example the hosted
setup on a laptop and the local servers at home. It comes with built-in profiles (listed below). **Load** fills the form from the selected profile and
**Save** applies it. A profile sets every setting except the API keys: settings it does not list go back to
their defaults, so Load, then re-check your language and voice before Save. **Save as profile** stores the current form under a name you type (every setting except the API keys, so the profile keeps its meaning if a default changes later), **Delete**
removes a profile of your own, and **Export file** / **Import file** move a profile to another browser as a
JSON file. The API keys are not part of any profile: they are shared by all profiles and are never
exported or imported. Profiles are stored in `chrome.storage.sync`, one item per profile.

Built-in profiles:

| Profile | Translation | Voice |
| --- | --- | --- |
| `Hosted (Gemini + Google TTS)` | Gemini (hosted) | Google Cloud TTS (the default) |
| `Local (Unsloth + VOICEVOX / edge-tts)` | local Unsloth server | VOICEVOX for Japanese, edge-tts otherwise |
| `Gemini + edge-tts (free voice)` | Gemini (hosted) | edge-tts bridge (no Google TTS fee) |
| `Local LLM + Google TTS` | local Unsloth server | Google Cloud TTS |
| `Interview / podcast (two voices)` | Gemini (hosted) | Google Cloud TTS, voice switches at every change of speaker (`speakerVoices` = `alternate`) |

## Using servers on another machine

The LLM, VOICEVOX and the edge-tts bridge can run on another computer, for example a GPU box on your
local network. On that machine, make the servers listen on the network and allow the ports in its
firewall (only for your LAN): VOICEVOX with `--host 0.0.0.0`, the bridge with
`tools/edge_tts_server.py --host 0.0.0.0`, and the LLM server with its own host option. Then enter the
URLs such as `http://192.168.1.20:8888/v1` in `llmBaseUrl`, `voicevoxUrl` and `edgeUrl` on the options
page. When you press Save, Chrome asks once per host whether the extension may reach it
(`optional_host_permissions`). The traffic is plain HTTP and the bridge and VOICEVOX have no
authentication, so use this only on a network you trust.

### HTTPS

The servers themselves speak plain HTTP only (VOICEVOX has no TLS option). The extension accepts
`https://` URLs, so put a TLS-terminating reverse proxy in front of the server on the other machine
and enter the proxy's URL, for example `voicevoxUrl` = `https://voicevox.lan:50443`. With
[Caddy](https://caddyserver.com/), which creates a certificate from its own local CA, a `Caddyfile` is enough:

```
voicevox.lan:50443 {
    reverse_proxy 127.0.0.1:50021
}
```

Chrome on the machine running the extension must trust the certificate (for Caddy, install its root
certificate once), otherwise requests fail. If you use Tailscale, `tailscale serve --https=50443 http://127.0.0.1:50021`
gives a publicly trusted certificate for the machine's tailnet name and needs no trust setup. The same
works for the edge-tts bridge and the LLM server. These proxy setups have not been tested with this
extension.

## Target languages

Set `targetLang` in the options page:

| `targetLang` | Language | Default edge-tts voice (female) |
| --- | --- | --- |
| `ja` | Japanese | `ja-JP-NanamiNeural` (VOICEVOX is used with `ttsProvider` `auto`) |
| `en` | English | `en-US-AriaNeural` |
| `zh-TW` | Traditional Chinese (Taiwan) | `zh-TW-HsiaoChenNeural` |
| `zh-CN` | Simplified Chinese | `zh-CN-XiaoxiaoNeural` |
| `ko` | Korean | `ko-KR-SunHiNeural` |

`translationLevel` sets how hard the translated wording is: `standard` (default), `easy` (simple words and short sentences for learners; about JLPT N5-N3 for Japanese) or `advanced` (more precise, formal wording; about JLPT N3-N1 for Japanese). The meaning and technical terms are not changed. It only adds one rule to the translation prompt, so how well it is followed depends on the model.

`voiceGender` (`female` or `male`) picks the voice:

| `targetLang` | female | male |
| --- | --- | --- |
| `ja` (VOICEVOX) | style `2` (四国めたん) | style `11` (玄野武宏) |
| `ja` (edge-tts) | `ja-JP-NanamiNeural` | `ja-JP-KeitaNeural` |
| `en` | `en-US-AriaNeural` | `en-US-GuyNeural` |
| `zh-TW` | `zh-TW-HsiaoChenNeural` | `zh-TW-YunJheNeural` |
| `zh-CN` | `zh-CN-XiaoxiaoNeural` | `zh-CN-YunxiNeural` |
| `ko` | `ko-KR-SunHiNeural` | `ko-KR-InJoonNeural` |

`ttsProvider` is `google` by default (Google Cloud Text-to-Speech); `auto` means VOICEVOX for `ja` and edge-tts otherwise; `google` forces Google Cloud
Text-to-Speech (default voices: `ja-JP-Wavenet-B/C`, `en-US-Wavenet-F/D`, `cmn-TW-Wavenet-A/B`,
`cmn-CN-Wavenet-A/B`, `ko-KR-Wavenet-A/C`; `googleVoice` overrides the voice and `googleSpeed` sets the
speaking rate). `edgeVoice` overrides the
edge-tts voice (`.venv/bin/edge-tts --list-voices` lists them) and `edgeRate` (e.g. `+10%`) the speed.
To add a language, add an entry to `YTD_LANGS` in `extension/defaults.js`.

`speakerVoices` (`off` by default) is for dialogue such as interviews and podcasts. Many manual captions mark a change of speaker with a leading `- ` or `>>`. With `speakerVoices` set to `alternate`, the markers are removed from the text and the voice switches at every change: the first speaker gets the voice of `voiceGender`, the other speaker gets the opposite gender. The markers carry no names, so this only works for two speakers, and auto-generated captions usually have no markers.

`voice1Provider` / `voice1Voice` and `voice2Provider` / `voice2Voice` set the provider and voice of the first and second speaker individually. `voice1*` applies to every cue (so it also sets the voice of a single-speaker video), while `voice2*` is used only for the second speaker of a dialogue (`speakerVoices` `alternate` or `llm`). Together they let you mix providers or use two voices of the same gender, for example VOICEVOX style `8` for the first speaker and `ja-JP-Neural2-B` from Google for the second. The voice is a VOICEVOX style id, an edge-tts voice name or a Google voice name, matching the provider. Empty values keep the default behaviour (`ttsProvider`, with the second speaker's gender opposite to `voiceGender`).

For captions without markers there is an experimental `llm` mode: the translation LLM is asked, every 15 cues and from the text alone, which lines belong to the host (voice of `voiceGender`) and which to the guest (the opposite gender). The prompt assumes an interview, it costs about one extra request per 15 cues, and it also works for auto-generated captions. In an offline test on the Lex Fridman #494 captions with the markers removed (Gemma 4 12B, three samples of 300 sentences), it found 70-80% of the speaker changes with similar precision; a missed change can make the voices swap roles for a while, and a failed request keeps the previous voice. If the first 30 cues are labelled almost entirely as one speaker (as in a lecture), the video is treated as a monologue and keeps a single voice. Treat it as a rough aid, not as reliable speaker identification.

## On-screen subtitles

The **Sub** button in the player cycles `off` -> `translated` -> `both` (translation plus the original
line). The choice is saved in the `subtitles` setting (default `off`). The text of the cue being
spoken is shown near the bottom of the player and hidden between cues, while paused-by-the-user it
stays visible. The font scales with the player width, so it also works in fullscreen. It sits above
YouTube's own caption line, so it does not overlap if YouTube captions are switched on. Long sentences are shown in pages of at most `subtitleMaxLines` lines (default 2; `0` means no limit), which advance with the speech, so the overlay never covers more of the video than that. In `both` mode the translation and the original are limited separately.

## Install (development)

1. Open `chrome://extensions`, enable Developer mode, click "Load unpacked", select `extension/`.
2. Open the extension's options page and adjust the settings. The everyday ones (language, voice gender,
   subtitles, TTS provider, API keys) are at the top; the rest is folded into sections (voice details,
   servers and models, captions and subtitles, buffering and video speed) that open by themselves when
   they hold a changed value.
3. Open a YouTube video that has captions and click **Dub (xx)** at the top left of the player
   (**Sub** toggles the on-screen translation).
   Reload the YouTube tab after every extension reload.

**Firefox (140 or newer):** open `about:debugging#/runtime/this-firefox`, click "Load Temporary
Add-on..." and select `extension/manifest.json`. Temporary add-ons are removed when Firefox quits.
The same files run on both browsers: Chrome uses `background.service_worker`, Firefox uses
`background.scripts`. Firefox asks for the host permissions at install time; they can be revoked in
`about:addons` > the extension > Permissions. The options page is under `about:addons` > Preferences. Tested on Firefox
running on Linux.

**Android (Firefox for Android, experimental):** the extension also matches `m.youtube.com`, and the HUD
buttons and the options page are touch-sized. It has been tested on a real phone (Firefox for Android) with the hosted defaults. To try it, enable USB
debugging on the phone and run `npx web-ext run --source-dir extension --target firefox-android --android-device <id>`
(`adb devices` lists the id), or load it from `about:debugging` in a desktop Firefox connected to the phone.
Chrome for Android does not support extensions. The hosted defaults (Gemini and Google TTS) work on a phone with
just the API keys; a local LLM, VOICEVOX or the edge-tts bridge must run on a computer on the same network,
with its LAN address in `llmBaseUrl`, `voicevoxUrl` and `edgeUrl`. Audio stops when the browser goes to the
background or the screen locks. iOS needs a separate Safari Web Extension and is not supported yet.

**Udemy (experimental):** the extension also matches `*.udemy.com`. On a lecture page the same **Dub** button appears on the player. Udemy draws its own captions and adds no `<track>` elements to the video, so the extension asks the same lecture API the player uses (it needs you to be signed in and enrolled in the course) and loads the first caption file the lecture lists (WebVTT). The video's standard `<track>` elements are only a fallback. If the lecture has no captions, use **Load captions** with an SRT/VTT file. Site-specific code lives in `extension/providers.js`; supporting another site means adding one adapter there and one `matches` pattern in `manifest.json`.

**Vimeo (experimental):** the extension also runs inside `player.vimeo.com` frames, which is where Vimeo plays every video (on vimeo.com and on pages that embed it), and shows the same **Dub** button on the player. It reads the caption file from the player's config (`/video/<id>/config`), preferring a human-made track over an auto-generated one, and falls back to the video's standard `<track>` elements. This has not been tested against a real Vimeo video yet, and a video with no captions needs **Load captions**. Embeds that restrict where they can be played (domain-level privacy) may refuse the config request.

## Example lectures

The extension is meant for slide-based lectures. Four playlists and one podcast episode you can try it on:

- Adi Teman's [Digital Integrated Circuits (2020-21)](https://www.youtube.com/playlist?list=PLZU5hLL_713yF0Lkwjj9O3ttVIuhPV-me) (Bar-Ilan University 83-313, 66 videos). The lectures we checked have manual English captions, the best-supported case.
- Prof. Tony Chan Carusone's [CMOS Analog Integrated Circuit Design Fundamentals](https://www.youtube.com/playlist?list=PLUJOuapA83-QlWbnMJvoyQucGaBlpBF0F) (37 graduate-level videos on the Microelectronics channel). These videos have only auto-generated English captions, which is the least-tested path (see Known limitations below).
- Razavi's [Beauty of Circuits](https://www.youtube.com/playlist?list=PLvYonHCKSWagKgNwtFKlWmkN7aKeSBPEO) lectures. We have not checked its captions yet, so treat it as untested.
- Prof. Onur Mutlu's (ETH Zürich) [Digital Design and Computer Architecture (Spring 2025)](https://www.youtube.com/playlist?list=PL5Q2soXY2Zi9Eo29LMgKVcaydS7V1zZW3) livestreamed lectures. We have not checked its captions yet, so treat it as untested.
- Lex Fridman Podcast [#494, Jensen Huang](https://www.youtube.com/watch?v=vif8NQcjVf0) (2 h 26 min conversation with no slides, English captions). It shows how the extension behaves on a long, speech-only video, and it has not been tested as thoroughly as the lectures above.

Videos with manual captions work better. The videos are not part of this project, and the project is not affiliated with their authors. Please respect their rights: do not republish dubbed copies without permission.

## Files

| File | Role |
| --- | --- |
| `extension/manifest.json` | MV3 manifest |
| `extension/defaults.js` | Default settings shared by all contexts |
| `extension/page-hook.js` | MAIN-world script; fetches caption JSON through the player API |
| `extension/asr.js` | ASR caption helpers: word flattening, punctuation windows, alignment, sentence-based cues |
| `extension/speakers.js` | Dialogue helpers: splitting captions at speaker-change markers and alternating voices |
| `extension/subtitle.js` | Subtitle paging helpers: splitting long text into pages of a few lines |
| `extension/providers.js` | Per-site adapters (YouTube, Udemy, Vimeo): video and player lookup, caption fetching, navigation detection |
| `extension/content.js` | Cue building, production loop, playback scheduler, HUD |
| `extension/background.js` | Service worker; LLM, VOICEVOX and edge-tts HTTP bridge |
| `extension/options.html`, `options.js` | Settings UI |
| `tools/edge_tts_server.py` | Local HTTP bridge around `edge-tts` |
| `tests/` | Unit tests (Node's built-in runner for the extension, `unittest` for the bridge) |
| `.github/workflows/ci.yml` | GitHub Actions CI |

## Development

```
npm test                                                  # extension tests, Node 22+, no dependencies
.venv/bin/pip install ruff
.venv/bin/ruff check tools tests                          # lint the bridge and its tests
.venv/bin/python -m unittest discover -s tests -p "test_*.py"   # bridge tests
```

GitHub Actions (`.github/workflows/ci.yml`) runs a syntax check of every extension script plus both
test suites on each push to `main` and on every pull request.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to contribute and report issues.

## Known limitations / TODO

- Auto-generated (ASR) captions have no punctuation. With `asrPunctuation` set to `on` (the default) the LLM first restores punctuation in overlapping windows of words, so cues end at sentence boundaries. This takes about 1.2 s per minute of video (measured with a local 12B model on a 16 GB GPU); the video is paused and a progress count is shown meanwhile. The result is saved per video when the captions come from YouTube, so later starts do not wait. On a 43-minute lecture 74% of the cues ended at a sentence end (without this step 70% were cut mid-sentence by the length limit). Windows where the model changes the words (3 of 52 in that test) fall back to cutting by length. Set `asrPunctuation` to `off` to skip the step. Manual captions still work best.
- YouTube may require a PO token for the `timedtext` endpoint, which can make the caption
  fetch return an empty body. In that case use the **Load captions** button to supply an
  SRT / WebVTT / JSON3 file, e.g. one created with
  `yt-dlp --skip-download --write-subs --sub-langs en --convert-subs srt <url>`.
  Set `localCaptionLang` (the *source* language name such as `English`) in the options page. The loaded file
  is dropped when you navigate to another video. Rolling-style auto-caption VTT files are not
  de-duplicated; use manual subtitles for this path.
- Translation is one cue at a time with the previous `contextCues` translations as context.
  Batching and glossary support would improve terminology consistency.
- Only the first caption track matching the preference order is used; there is no language picker.
- Decoded audio for cues more than 4 behind the playhead is freed; seeking back re-synthesizes them.
- The tests cover the settings, the manifest, the service worker, the ASR helpers and the edge-tts bridge. The content
  script (cue building, scheduler, HUD) and the page hook have no automated tests yet; they are
  checked by hand in a browser.
## License

Copyright 2026 Nexplico-Ltd. Licensed under the Apache License 2.0, see [LICENSE](LICENSE) and
[NOTICE](NOTICE). This applies to the code in this repository only. The
services and models it talks to have their own terms: VOICEVOX and each of its voice characters,
Microsoft's online speech service behind edge-tts, and the LLM you run (e.g. Gemma). Check them
before publishing dubbed videos.
