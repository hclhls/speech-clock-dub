# Privacy policy

Speech Clock Dub is a browser extension that dubs YouTube videos (and, experimentally, Udemy lectures and Vimeo, Coursera and edX videos) using translation and speech services
that you choose. It has no server of its own, no account system, no analytics and no advertising.

_Last updated: 2026-11-04_

## Summary

- The developers do not receive any data from the extension, and nothing is sent to any server operated
  by the developers.
- The extension sends the captions of the video you dub only to the services whose addresses you
  configure on its options page. With the default settings these are Google's Gemini API (translation)
  and Google Cloud Text-to-Speech (voice), which need your own API keys. You can instead point it at
  servers on your own computer or network.
- Only if you turn on the experimental speech-to-text option (off by default) and a video has no captions,
  the audio of that video is sent to the speech-to-text service whose address you configure.
- It does not read anything on youtube.com, udemy.com, coursera.org, edx.org or Vimeo's player other than the caption data and the playback state
  of the video you chose to dub.

## What the extension reads

When you start a dub on a YouTube watch page, a Udemy lecture page, a Vimeo video, a Coursera lecture or an edX video unit, the extension reads:

- the caption track of that video (the text and timings), either from the YouTube player, from Udemy's
  lecture caption file Vimeo's player caption file, the subtitle track of a Coursera lecture or the transcript of an edX video (see below) or from a caption file that you load yourself;
- the video element's playback state, so that it can change the playback rate and pause or resume it.

It does not read your browsing history, your YouTube, Udemy, Vimeo, Coursera or edX account, other tabs, cookies or form data.

On Udemy, the page has no caption track the extension can read directly, so the extension makes two
requests to udemy.com's own lecture API (the address of the course and the caption list of the lecture you
are on) and then downloads the caption file the lecture lists. These requests go only to udemy.com, from
your browser, with your existing Udemy session (the browser attaches its cookies, as it does for the Udemy
page itself); the extension does not read or store the cookies. The responses are used only to find and read
the captions.

On Vimeo, every video plays inside a `player.vimeo.com` frame, on vimeo.com and on other sites that embed
it. The extension runs only inside that frame; it cannot read the embedding page. From there it requests the
player's own configuration (which lists the captions) and the caption file, both from `player.vimeo.com`,
with your existing Vimeo session as the browser would for the player itself. The extension does not read or
store cookies, and uses the responses only to find and read the captions.

On Coursera, the extension reads the list of subtitle tracks of the lecture's video element and downloads the
file of one track (the language the player has selected). That file normally comes from Coursera's content
delivery network, and the browser then sends no Coursera cookies with the request (it would send them only
if the file were on coursera.org itself). On edX, the extension runs only inside the video frame
of a unit on `courses.edx.org` / `learning.edx.org` and requests the transcript that the video block names,
from `courses.edx.org`, with your existing edX session as the browser would for the video player itself. On
both sites the extension does not read or store cookies, and uses the responses only to find and read the
captions.

## Where the data goes

The caption text (and, for translation, nearby captions as context) and the translated text are sent over
HTTP(S) to the services you configure on the options page:

| Setting | Purpose | Default |
| --- | --- | --- |
| LLM base URL | Translation, caption punctuation and speaker labelling | `https://generativelanguage.googleapis.com/v1beta/openai` (Google Gemini) |
| TTS provider | Speech synthesis | Google Cloud Text-to-Speech (`https://texttospeech.googleapis.com`) |
| Speech-to-text base URL | Transcription of a video without captions (only if `sttMode` is `fallback`; off and empty by default) | none |
| VOICEVOX URL | Japanese speech synthesis (only if selected) | `http://localhost:50021` |
| edge-tts bridge URL | Speech synthesis for other languages (only if selected) | `http://127.0.0.1:5050` |

The extension's host permissions cover `localhost`, `127.0.0.1`, `generativelanguage.googleapis.com` and
`texttospeech.googleapis.com`. If you enter the address of any other server (for example a hosted LLM
service, or a machine on your local network), the browser asks you to allow the extension to reach that one
host (an optional host permission); you can revoke it at any time. What those services do with the text is
governed by whoever runs them:

- If you use the default Gemini endpoint, the caption text and your Gemini API key are sent to Google and
  are subject to Google's terms and privacy policy. The same applies to any other hosted LLM service you
  configure.
- If you use the Google provider, the translated text and your Google API key are sent directly from the
  extension to Google Cloud Text-to-Speech and are subject to Google's terms and privacy policy.
- The optional edge-tts bridge in this repository (`tools/edge_tts_server.py`) forwards the translated
  text to Microsoft's online speech service to synthesize audio. That text is subject to Microsoft's terms.
- If you turn on speech-to-text, the extension downloads the media file of the video you chose to dub (only
  when the page offers a plain file, not a stream), decodes its audio in your browser and sends it in short
  chunks, with your speech-to-text API key if you set one, to the endpoint you configured. That audio is
  subject to the terms of whoever runs the endpoint (OpenAI, Groq, or your own Whisper server). The file is
  requested with the cookies the browser would send for that address, and nothing is kept after the dub
  stops apart from the transcript in the tab's memory.
- VOICEVOX and a local LLM server run on your own machine and do not send text anywhere on their own.

## What the extension stores

- **Settings**, including the LLM and Google API keys if you enter them, are stored with
  `storage.sync`. If browser sync is enabled for your account, the browser may sync them across your
  signed-in devices. The API keys are stored unencrypted by the extension; use keys with limited scope, or
  leave the field empty for local servers that do not need one.
- **Per-video punctuation flags** for auto-generated captions are cached in `storage.local` so that the
  same video is not processed twice. They contain no caption text.

Nothing else is stored. Translated text and synthesized audio are kept in memory only while the video is
dubbed.

## Your choices

You can clear everything at any time by removing the extension. To keep all data on your own machines, use
only a local LLM server and VOICEVOX. Do not use the default Google services or the edge-tts bridge, which
contacts Microsoft.

## Changes and contact

Changes to this policy are published in this file, and the date above is updated. Questions and reports:
https://github.com/Nexplico-Ltd/speech-clock-dub/issues
