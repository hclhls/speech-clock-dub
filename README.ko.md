# speech-clock-dub

[![CI](https://github.com/Nexplico-Ltd/speech-clock-dub/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Nexplico-Ltd/speech-clock-dub/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md) | **한국어** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

> 이 문서는 영어판 [README.md](README.md)의 한국어 번역입니다. 내용이 다르면 영어판이 기준입니다. 번역은 최신 내용보다 늦을 수 있습니다.

영상이 음성을 따라가는 YouTube 강의 더빙 도구입니다.

YouTube 강의 영상을 일본어, 영어, 번체 중국어, 간체 중국어, 한국어로 더빙하는 Chrome/Firefox(MV3) 확장 프로그램입니다. 슬라이드 위주의 영상을 염두에 두고 만들었습니다. 번역한 음성을 화면 속도에 억지로 맞추는 대신, **화면이 음성을 따라갑니다**.

## 동작 방식

```
YouTube 자막 -> 문장 단위 cue -> LLM 번역 -> TTS (VOICEVOX / edge-tts) -> Web Audio 큐
                                                                            |
                              <video> 의 playbackRate / pause / play  <-----+
```

- 합성된 음성이 마스터 클럭입니다. 원래 음성은 음소거됩니다.
- 각 cue마다 영상의 `playbackRate`를 `cue 남은 시간 / 음성 길이`로 설정합니다(`[minRate, maxRate]` 범위로 제한).
- 음성이 cue의 영상 구간보다 길면, 음성이 끝날 때까지 영상을 일시정지합니다(슬라이드가 멈춘 화면). 음성이 더 짧으면 다음 cue까지 영상을 더 빠르게 재생합니다.
- cue 사이의 긴 무음 구간은 `gapRate`로 지나갑니다.
- 선행 생성(producer) 루프가 재생보다 앞서 cue를 번역하고 음성을 합성합니다. 번역은 순서대로 실행하고(각 번역은 앞선 번역을 문맥으로 받습니다), 음성 합성은 최대 `concurrency`개의 cue를 병렬로 실행합니다. 클라우드 TTS는 요청 하나에 몇 초가 걸리기 때문에 이것이 중요합니다. cue 경계에서 준비된 음성이 `lowWaterSec`초 미만이면 영상을 일시정지하고, `highWaterSec`초 분량이 쌓이면 다시 재생합니다(히스테리시스). 영상이 종속 쪽이므로 버퍼가 바닥나도 동기가 어긋나지 않고 영상만 멈춥니다. 문장 중간에 재생이 끊기지 않습니다.
- 사용자가 일시정지/재생하면 음성도 함께 멈추거나 이어지며, 사용자가 탐색(seek)하면 cue 위치를 다시 맞춥니다. 광고는 감지되어(`.ad-showing`) 그동안 스케줄러가 멈춥니다.

## 설정

### 빠른 시작(기본값): 호스팅 서비스

기본 설정은 Google의 호스팅 서비스 두 가지를 사용하므로 **로컬 서버가 필요 없습니다**. Google Cloud / AI Studio 계정과 API 키 두 개가 필요합니다(두 API를 모두 활성화한 같은 키여도 됩니다).

1. 번역용 **Gemini API 키**. [Google AI Studio](https://aistudio.google.com/apikey)에서 만들어 옵션 페이지의 `llmApiKey`에 붙여 넣습니다. 기본값(`llmBaseUrl` = `https://generativelanguage.googleapis.com/v1beta/openai`, `llmModel` = `gemini-3.1-flash-lite`)은 Gemini의 OpenAI 호환 엔드포인트를 사용합니다. 다른 호스팅 OpenAI 호환 서비스(OpenAI, Groq, OpenRouter 등)도 `llmBaseUrl`, `llmModel`, `llmApiKey`를 설정하면 쓸 수 있습니다. 해당 호스트에 대한 접근은 Save를 누를 때 Chrome이 한 번 묻습니다.
2. 음성용 **Google Cloud Text-to-Speech 키**. Google Cloud 프로젝트에서 Cloud Text-to-Speech API를 활성화하고 API 키를 만들어 `googleApiKey`에 붙여 넣습니다. `ttsProvider`는 처음부터 `google`입니다.

기본값은 가장 저렴한 선택입니다. 번역은 `gemini-3.1-flash-lite`, 음성은 WaveNet 음성을 사용합니다(작성 시점에 Google은 WaveNet을 Standard와 같은 가격, Neural2의 4분의 1로 안내하며 매월 무료 할당량이 있습니다). 가격은 바뀔 수 있으니 Google의 요금 페이지를 확인하세요. 음질이 더 좋은 Neural2와 Chirp 3 HD 음성은 `googleVoice`로 지정할 수 있습니다.

**두 서비스 모두 유료이며(무료 할당량이 있으니 요금은 Google 안내를 확인하세요), 자막 텍스트와 그 번역이 Google로 전송됩니다.** 키는 다른 설정처럼 `chrome.storage.sync`에 저장되므로 Google Cloud 콘솔에서 Text-to-Speech 키를 해당 API로만 제한하세요(Google이 제한을 지원한다면 Gemini 키도 마찬가지로 제한하세요). 키가 없으면 상태 줄에 그 키 이름이 나오는 오류가 표시됩니다. 이 기본 구성은 아직 관리자가 처음부터 끝까지 실행해 보지 않았습니다. 가장 많이 사용된 것은 아래의 로컬 구성입니다.

`host_permissions`에는 `localhost` / `127.0.0.1`, `texttospeech.googleapis.com`, `generativelanguage.googleapis.com`만 들어 있습니다. 다른 호스트의 서버는 실행 중에 허용합니다(아래 절 참조).

### 고급: 로컬 서버(선택)

무료로 비공개 더빙을 하려면 직접 서버를 실행하고 설정을 그쪽으로 향하게 하세요. LLM에는 `llmBaseUrl`, `llmModel`, `llmExtraBody`를, TTS에는 `ttsProvider`를 `auto`(일본어는 VOICEVOX, 그 외는 edge-tts), `voicevox`, `edge` 중 하나로 설정합니다.

1. **OpenAI 호환 LLM 엔드포인트**(예: Unsloth 서비스)에서 Gemma 12B급 모델을 실행합니다. `llmBaseUrl`(`/v1`로 끝나는 URL, 예: `http://127.0.0.1:8888/v1`)과 `llmModel`을 설정하세요. Gemma 4에서는 `llmExtraBody`도 `{"chat_template_kwargs":{"enable_thinking":false}}`로 설정합니다. 그렇지 않으면 한 줄에 몇 분이 걸릴 수 있습니다. 확장 프로그램은 `POST {llmBaseUrl}/chat/completions`를 호출합니다.
2. **VOICEVOX 엔진**(오픈 소스, 고품질 일본어 TTS):

   ```
   # GPU (nvidia-container-toolkit 필요). 이미지의 기본 명령이 이미
   # --use_gpu --host 0.0.0.0 을 넘기므로 인자를 덧붙이지 마세요(기본 명령이 대체됩니다).
   docker run -d --rm --name voicevox --gpus all -p 50021:50021 voicevox/voicevox_engine:nvidia-latest
   # CPU 전용
   docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-latest
   ```

   VOICEVOX에는 VRAM이 1~2 GB 정도 필요하므로, 16 GB GPU에서 12B LLM과 함께 쓸 수 있습니다.

   음성 캐릭터마다 이용 약관이 따로 있습니다. 더빙한 영상을 공개하기 전에 확인하세요.
   `speakerFemale` / `speakerMale`은 VOICEVOX 스타일 ID입니다(`GET /speakers`로 목록을 볼 수 있습니다).

   **VRAM:** VOICEVOX는 음성을 하나 추가할 때마다 GPU에 모델을 하나 더 불러옵니다. 12B LLM이 16 GB 카드의 거의 전부를 차지하고 있으면(예: 컨텍스트 창이 매우 큰 경우) 첫 번째 음성은 동작해도 다른 음성은 CUDA 메모리 부족 오류로 실패할 수 있습니다(`/synthesis`가 HTTP 500). 더빙에는 LLM 컨텍스트가 수천 토큰이면 충분하므로, 모델을 불러올 때 컨텍스트 길이를 낮추세요. 16 GB RTX 4060 Ti와 Gemma 4 12B(Q4)에서 측정한 결과: 컨텍스트 262144 토큰에서는 llama-server가 14.2 GB를 사용했고(여유 약 0.5 GB, 남성 음성 실패), 16384에서는 9.5 GB였습니다(VOICEVOX를 불러온 상태에서 여유 약 3.9 GB, 두 음성 모두 동작). 번역도 빨라졌습니다(문장당 0.5초 -> 0.3초).

   또는 VOICEVOX를 CPU에서 실행할 수도 있습니다(문장당 실시간의 약 0.5배). 이미지의 명령을 덮어써서 `--use_gpu`를 뺍니다: `... voicevox_engine:nvidia-latest gosu user /opt/voicevox_engine/run --host 0.0.0.0`.

3. **edge-tts 브리지**(일본어 이외의 언어로 더빙할 때. VOICEVOX 대신 쓰고 싶다면 일본어에서도). edge-tts는 비공식 API로 Microsoft의 온라인 음성 서비스를 사용하므로 **번역된 텍스트가 Microsoft로 전송됩니다**. 인터넷 연결이 필요하며, 서비스가 바뀌면 동작하지 않을 수 있습니다. 작은 로컬 HTTP 브리지로 확장 프로그램에 연결합니다:

   ```
   python3 -m venv .venv && .venv/bin/pip install edge-tts
   .venv/bin/python tools/edge_tts_server.py        # 127.0.0.1:5050 에서 대기
   ```

   `--port`로 포트를 바꿀 수 있습니다(그 경우 `edgeUrl`도 바꾸세요). 문장당 2~3초가 걸리지만, 버퍼가 차고 나면 병렬 producer가 이를 가려 줍니다. 다만 처음 재생을 시작할 때까지는 VOICEVOX보다 오래 걸립니다.

   합성이 `403 Invalid response status` 로 실패하면 Microsoft 서비스가 바뀌어 edge-tts 가 오래된 것입니다. `.venv/bin/pip install -U edge-tts` 를 실행하고 브리지를 다시 시작하세요.

## 프로필

옵션 페이지의 **Profile** 칸에서 설정 전체를 전환할 수 있습니다. 예를 들어 노트북에서는 호스팅 구성, 집에서는 로컬 서버를 쓰는 식입니다. 기본 제공 프로필이 처음부터 들어 있습니다(아래 목록). **Load**는 선택한 프로필을 양식에 불러오고, **Save**로 적용합니다. 프로필은 API 키를 제외한 모든 설정을 정합니다. 나열되지 않은 설정은 기본값으로 돌아가므로, Load한 뒤 언어와 음성을 확인하고 Save하세요. **Save as profile**은 입력한 이름으로 현재 양식을 저장하고(API 키를 제외한 모든 설정을 저장하므로 나중에 기본값이 바뀌어도 프로필의 의미는 변하지 않습니다), **Delete**는 직접 만든 프로필을 삭제합니다. **Export file** / **Import file**로 프로필을 JSON 파일로 다른 브라우저에 옮길 수 있습니다. API 키는 프로필에 포함되지 않습니다. 모든 프로필이 공유하며, 내보내기와 가져오기에도 포함되지 않습니다. 프로필은 `chrome.storage.sync`에 프로필 하나당 항목 하나로 저장됩니다.

기본 제공 프로필:

| 프로필 | 번역 | 음성 |
| --- | --- | --- |
| `Hosted (Gemini + Google TTS)` | Gemini(호스팅) | Google Cloud TTS(기본값) |
| `Local (Unsloth + VOICEVOX / edge-tts)` | 로컬 Unsloth 서버 | 일본어는 VOICEVOX, 그 외는 edge-tts |
| `Gemini + edge-tts (free voice)` | Gemini(호스팅) | edge-tts 브리지(Google TTS 요금 없음) |
| `Local LLM + Google TTS` | 로컬 Unsloth 서버 | Google Cloud TTS |
| `Interview / podcast (two voices)` | Gemini(호스팅) | Google Cloud TTS. 화자가 바뀔 때마다 목소리가 바뀝니다(`speakerVoices` = `alternate`) |

## 다른 컴퓨터의 서버 사용하기

LLM, VOICEVOX, edge-tts 브리지는 로컬 네트워크의 GPU 머신처럼 다른 컴퓨터에서 실행할 수 있습니다. 그 컴퓨터에서 서버가 네트워크에서 접근 가능하도록 실행하고 방화벽에서 포트를 허용하세요(LAN 안에서만). VOICEVOX는 `--host 0.0.0.0`, 브리지는 `tools/edge_tts_server.py --host 0.0.0.0`, LLM 서버는 각자의 호스트 옵션을 사용합니다. 그런 다음 옵션 페이지의 `llmBaseUrl`, `voicevoxUrl`, `edgeUrl`에 `http://192.168.1.20:8888/v1` 같은 URL을 입력합니다. 저장을 누르면 Chrome이 호스트마다 한 번, 확장 프로그램이 그곳에 접속해도 되는지 묻습니다(`optional_host_permissions`). 통신은 암호화되지 않은 HTTP이고 브리지와 VOICEVOX에는 인증이 없으므로, 신뢰할 수 있는 네트워크에서만 사용하세요.

### HTTPS

서버 자체는 평문 HTTP만 사용합니다(VOICEVOX에는 TLS 옵션이 없습니다). 확장 프로그램은 `https://` URL을 받아들이므로, 다른 컴퓨터의 서버 앞에 TLS를 종단하는 리버스 프록시를 두고 그 프록시의 URL을 입력하세요(예: `voicevoxUrl` = `https://voicevox.lan:50443`). [Caddy](https://caddyserver.com/)는 자체 로컬 CA로 인증서를 만들어 주므로 `Caddyfile`은 다음만 있으면 됩니다:

```
voicevox.lan:50443 {
    reverse_proxy 127.0.0.1:50021
}
```

확장 프로그램을 실행하는 컴퓨터의 Chrome이 그 인증서를 신뢰해야 합니다(Caddy라면 루트 인증서를 한 번 설치). 그렇지 않으면 요청이 실패합니다. Tailscale을 쓴다면 `tailscale serve --https=50443 http://127.0.0.1:50021`로 tailnet 이름에 대해 공인 인증서를 받을 수 있어 신뢰 설정이 필요 없습니다. edge-tts 브리지와 LLM 서버에도 같은 방법을 쓸 수 있습니다. 이 프록시 구성은 이 확장 프로그램으로 시험해 보지 않았습니다.

## 대상 언어

옵션 페이지에서 `targetLang`을 설정합니다:

| `targetLang` | 언어 | edge-tts 기본 음성(여성) |
| --- | --- | --- |
| `ja` | 일본어 | `ja-JP-NanamiNeural` (기본적으로는 VOICEVOX 사용) |
| `en` | 영어 | `en-US-AriaNeural` |
| `zh-TW` | 번체 중국어(대만) | `zh-TW-HsiaoChenNeural` |
| `zh-CN` | 간체 중국어 | `zh-CN-XiaoxiaoNeural` |
| `ko` | 한국어 | `ko-KR-SunHiNeural` |

`translationLevel`은 번역문의 난이도를 정합니다: `standard`(기본값), `easy`(학습자를 위한 쉬운 단어와 짧은 문장. 일본어는 JLPT N5~N3 수준), `advanced`(더 정확하고 격식 있는 표현. 일본어는 JLPT N3~N1 수준). 의미와 전문 용어는 바뀌지 않습니다. 번역 프롬프트에 규칙을 한 줄 추가할 뿐이므로 얼마나 지켜지는지는 모델에 따라 다릅니다.

`voiceGender`(`female` 또는 `male`)로 음성을 고릅니다:

| `targetLang` | female | male |
| --- | --- | --- |
| `ja` (VOICEVOX) | 스타일 `2` (四国めたん) | 스타일 `11` (玄野武宏) |
| `ja` (edge-tts) | `ja-JP-NanamiNeural` | `ja-JP-KeitaNeural` |
| `en` | `en-US-AriaNeural` | `en-US-GuyNeural` |
| `zh-TW` | `zh-TW-HsiaoChenNeural` | `zh-TW-YunJheNeural` |
| `zh-CN` | `zh-CN-XiaoxiaoNeural` | `zh-CN-YunxiNeural` |
| `ko` | `ko-KR-SunHiNeural` | `ko-KR-InJoonNeural` |

`ttsProvider`의 기본값은 `google`(Google Cloud Text-to-Speech)입니다. `auto`는 `ja`에 VOICEVOX, 그 외에는 edge-tts를 사용합니다. `google`로 바꾸면 Google Cloud Text-to-Speech를 사용합니다(기본 음성: `ja-JP-Wavenet-B/C`, `en-US-Wavenet-F/D`, `cmn-TW-Wavenet-A/B`, `cmn-CN-Wavenet-A/B`, `ko-KR-Wavenet-A/C`. `googleVoice`로 음성을, `googleSpeed`로 말하기 속도를 바꿀 수 있습니다). `edgeVoice`로 edge-tts 음성을 바꿀 수 있고(`.venv/bin/edge-tts --list-voices`로 목록 확인), `edgeRate`(예: `+10%`)로 속도를 바꿀 수 있습니다. 언어를 추가하려면 `extension/defaults.js`의 `YTD_LANGS`에 항목을 추가하세요.

`speakerVoices`(기본값 `off`)는 인터뷰나 팟캐스트 같은 대화용입니다. 수동 자막 중에는 화자가 바뀔 때 줄 맨 앞에 `- ` 또는 `>>`를 붙이는 경우가 많습니다. `alternate`로 설정하면 이 표시를 본문에서 제거하고, 화자가 바뀔 때마다 음성을 바꿉니다. 첫 번째 화자는 `voiceGender`의 음성, 다른 화자는 반대 성별의 음성을 씁니다. 표시에는 이름이 없으므로 화자가 두 명일 때만 동작하며, 자동 생성 자막에는 보통 이 표시가 없습니다.

`voice1Provider` / `voice1Voice`와 `voice2Provider` / `voice2Voice`로 첫 번째와 두 번째 화자의 제공자와 음성을 각각 지정할 수 있습니다. `voice1*`은 모든 큐에 적용되고(화자가 한 명인 영상의 음성도 정합니다), `voice2*`는 대화(`speakerVoices`가 `alternate` 또는 `llm`)의 두 번째 화자에만 쓰입니다. 이 둘로 제공자를 섞거나 같은 성별의 음성 두 개를 쓸 수 있습니다. 예를 들어 첫 번째 화자는 VOICEVOX 스타일 `8`, 두 번째 화자는 Google의 `ja-JP-Neural2-B`로 지정합니다. 음성은 제공자에 맞춰 VOICEVOX 스타일 ID, edge-tts 음성 이름, Google 음성 이름 중 하나를 씁니다. 비워 두면 기존 동작(`ttsProvider`를 쓰고, 두 번째 화자는 `voiceGender`와 반대 성별)입니다.

표시가 없는 자막을 위해 실험적인 `llm` 모드도 있습니다. 번역에 쓰는 LLM이 15개 cue마다 텍스트만 보고 어느 줄이 진행자(`voiceGender`의 음성)이고 어느 줄이 게스트(반대 성별의 음성)인지 판정합니다. 프롬프트는 인터뷰를 가정하며, cue 15개당 요청이 약 한 번 늘어납니다. 자동 생성 자막에도 쓸 수 있습니다. 표시를 제거한 Lex Fridman #494 자막으로 한 사전 테스트(Gemma 4 12B, 300문장 × 3구간)에서는 화자 교대의 70~80%를 비슷한 정밀도로 찾아냈습니다. 교대를 놓치면 한동안 음성 역할이 뒤바뀔 수 있고, 요청이 실패하면 직전 음성을 그대로 씁니다. 처음 30개 cue가 거의 한 명의 화자로 판정되면(강의 등) 독백으로 보고 하나의 음성을 유지합니다. 화자를 확실하게 식별하는 기능이 아니라 대략적인 보조 수단으로 사용하세요.

## 화면 자막

플레이어의 **Sub** 버튼을 누르면 `off` -> `translated` -> `both`(번역 + 원문) 순으로 바뀝니다. 선택은 `subtitles` 설정(기본값 `off`)에 저장됩니다. 지금 말하고 있는 cue의 텍스트가 플레이어 아래쪽에 표시되고 cue 사이에는 숨겨지며, 사용자가 일시정지한 동안에는 계속 보입니다. 글꼴은 플레이어 너비에 맞춰 조절되므로 전체 화면에서도 사용할 수 있습니다. YouTube 자체 자막 줄보다 위에 표시되므로 YouTube 자막을 켜도 겹치지 않습니다. 긴 문장은 최대 `subtitleMaxLines`줄(기본값 2, `0`이면 제한 없음)씩 페이지로 나눠 표시되며, 페이지는 음성의 진행에 맞춰 넘어갑니다. 그래서 자막이 영상을 크게 가리지 않습니다. `both`에서는 번역과 원문을 각각 따로 제한합니다.

## 설치(개발용)

1. Chrome: `chrome://extensions`를 열고 개발자 모드를 켠 뒤 "압축해제된 확장 프로그램을 로드합니다"를 눌러 `extension/`을 선택합니다.
2. 확장 프로그램의 옵션 페이지를 열어 설정을 조정합니다. 자주 쓰는 설정(언어, 목소리 성별, 자막, TTS 제공자, API 키)은 맨 위에 있고, 나머지는 접힌 섹션(목소리 세부 설정, 서버와 모델, 자막과 문장 분할, 버퍼와 영상 속도)에 들어 있습니다. 변경한 값이 있는 섹션은 자동으로 펼쳐집니다.
3. 자막이 있는 YouTube 영상을 열고 플레이어 왼쪽 위의 **Dub (xx)** 를 누릅니다(**Sub**는 화면 번역 자막을 켜고 끕니다). 확장 프로그램을 다시 로드할 때마다 YouTube 탭도 새로고침하세요.

**Firefox(140 이상):** `about:debugging#/runtime/this-firefox`를 열고 "임시 부가 기능 로드..."로 `extension/manifest.json`을 선택합니다. 임시 부가 기능은 Firefox를 종료하면 제거됩니다. 같은 파일이 두 브라우저에서 동작합니다(Chrome은 `background.service_worker`, Firefox는 `background.scripts`를 사용). 호스트 권한은 설치할 때 확인하며 `about:addons`의 확장 기능 "권한"에서 취소할 수 있습니다. 옵션 페이지는 `about:addons`의 "설정"에서 엽니다. Linux의 Firefox에서 동작을 확인했습니다.

**Android(Firefox for Android, 실험적):** `m.youtube.com`도 지원하며, HUD 버튼과 옵션 페이지는 터치용 크기입니다. 실제 기기(Firefox for Android)에서 기본 호스팅 구성으로 동작을 확인했습니다. 시험하려면 휴대폰에서 USB 디버깅을 켜고 `npx web-ext run --source-dir extension --target firefox-android --android-device <id>`를 실행합니다(id는 `adb devices`로 확인). 휴대폰에 연결한 데스크톱 Firefox의 `about:debugging`에서 불러올 수도 있습니다. Chrome for Android는 확장 프로그램을 지원하지 않습니다. 기본 호스팅 구성(Gemini와 Google TTS)은 API 키만 있으면 휴대폰에서 동작합니다. 로컬 LLM, VOICEVOX, edge-tts 브리지는 같은 네트워크의 컴퓨터에서 실행하고 `llmBaseUrl`, `voicevoxUrl`, `edgeUrl`에 그 LAN 주소를 넣습니다. 브라우저가 백그라운드로 가거나 화면이 잠기면 음성이 멈춥니다. iOS에는 별도의 Safari Web Extension이 필요하며 아직 지원하지 않습니다.

**Udemy(실험적):** `*.udemy.com`도 지원합니다. 강의 페이지의 플레이어에 같은 **Dub** 버튼이 나타납니다. Udemy는 자막을 직접 그리고 동영상에 `<track>` 요소를 붙이지 않으므로, 플레이어가 쓰는 것과 같은 강의 API에 요청해(Udemy에 로그인해 있고 해당 강좌에 등록되어 있어야 합니다) 강의에 나열된 첫 번째 자막 파일(WebVTT)을 불러옵니다. 동영상의 표준 `<track>` 요소는 대체 수단으로만 사용합니다. 강의에 자막이 없으면 **Load captions**로 SRT/VTT 파일을 불러오세요. 사이트별 코드는 `extension/providers.js`에 있으며, 다른 사이트를 지원하려면 거기에 어댑터 하나와 `manifest.json`의 `matches` 하나를 추가하면 됩니다.

**Vimeo(실험적):** Vimeo는 모든 동영상을 `player.vimeo.com` 프레임 안에서 재생하므로(vimeo.com에서도 임베드한 페이지에서도 마찬가지입니다) 확장 프로그램은 그 프레임 안에서 동작하며 플레이어에 같은 **Dub** 버튼을 표시합니다. 자막 파일은 플레이어 설정(`/video/<id>/config`)에서 읽고, 자동 생성보다 사람이 만든 트랙을 우선합니다. 동영상의 표준 `<track>` 요소는 대체 수단입니다. 실제 Vimeo 동영상에서는 아직 시험하지 않았습니다. 자막이 없는 동영상은 **Load captions**가 필요합니다. 재생 가능한 도메인을 제한한 임베드(도메인 수준 개인정보 보호)에서는 설정 요청이 거부될 수 있습니다.

## 예시 강의

이 확장 프로그램은 슬라이드 위주의 강의를 위해 만들었습니다. 사용해 볼 수 있는 재생목록 네 개와 팟캐스트 한 편입니다.

- Adi Teman의 [Digital Integrated Circuits (2020-21)](https://www.youtube.com/playlist?list=PLZU5hLL_713yF0Lkwjj9O3ttVIuhPV-me)(Bar-Ilan University 83-313, 영상 66편). 확인한 강의에는 수동 영어 자막이 있어, 가장 잘 지원되는 경우입니다.
- Tony Chan Carusone 교수의 [CMOS Analog Integrated Circuit Design Fundamentals](https://www.youtube.com/playlist?list=PLUJOuapA83-QlWbnMJvoyQucGaBlpBF0F)(Microelectronics 채널의 대학원 수준 영상 37편). 이 영상들에는 자동 생성된 영어 자막만 있는데, 이는 테스트가 가장 적은 경로입니다(아래 "알려진 제한 사항 / TODO" 참고).
- Razavi의 [Beauty of Circuits](https://www.youtube.com/playlist?list=PLvYonHCKSWagKgNwtFKlWmkN7aKeSBPEO)(강의). 자막은 아직 확인하지 않았으며, 테스트하지 않았습니다.
- ETH Zürich의 Onur Mutlu 교수의 [Digital Design and Computer Architecture (Spring 2025)](https://www.youtube.com/playlist?list=PL5Q2soXY2Zi9Eo29LMgKVcaydS7V1zZW3)(라이브 스트리밍 강의). 자막은 아직 확인하지 않았으며, 테스트하지 않았습니다.
- Lex Fridman Podcast의 [#494 Jensen Huang](https://www.youtube.com/watch?v=vif8NQcjVf0)(슬라이드가 없는 2시간 26분 대담, 영어 자막 있음). 길고 음성 위주인 영상에서의 동작을 볼 수 있지만, 위의 강의만큼 테스트하지는 않았습니다.

수동 자막이 있는 영상이 더 잘 동작합니다. 이 영상들은 이 프로젝트의 일부가 아니며 제작자와도 관련이 없습니다. 제작자의 권리를 존중하여, 허락 없이 더빙한 사본을 다시 공개하지 마세요.

## 파일

| 파일 | 역할 |
| --- | --- |
| `extension/manifest.json` | MV3 매니페스트 |
| `extension/defaults.js` | 모든 컨텍스트가 공유하는 기본 설정 |
| `extension/page-hook.js` | MAIN 월드 스크립트. 플레이어 API로 자막 JSON을 가져옴 |
| `extension/asr.js` | ASR 자막 헬퍼. 단어 평탄화, 구두점 창, 정렬, 문장 단위 cue |
| `extension/speakers.js` | 대화용 헬퍼. 화자 교대 표시에서 자막을 나누고 음성을 번갈아 배정 |
| `extension/subtitle.js` | 자막 페이지 나누기 헬퍼. 긴 문장을 몇 줄씩의 페이지로 나눔 |
| `extension/providers.js` | 사이트별 어댑터(YouTube, Udemy, Vimeo): 동영상·플레이어 탐색, 자막 가져오기, 페이지 이동 감지 |
| `extension/content.js` | cue 생성, 선행 생성 루프, 재생 스케줄러, HUD |
| `extension/background.js` | 서비스 워커. LLM, VOICEVOX, edge-tts HTTP 브리지 |
| `extension/options.html`, `options.js` | 설정 UI |
| `tools/edge_tts_server.py` | `edge-tts`를 감싸는 로컬 HTTP 브리지 |
| `tests/` | 단위 테스트(확장 프로그램은 Node 내장 테스트 러너, 브리지는 `unittest`) |
| `.github/workflows/ci.yml` | GitHub Actions CI |

## 개발

```
npm test                                                  # 확장 프로그램 테스트 (Node 22 이상, 의존성 없음)
.venv/bin/pip install ruff
.venv/bin/ruff check tools tests                          # 브리지와 그 테스트를 lint
.venv/bin/python -m unittest discover -s tests -p "test_*.py"   # 브리지 테스트
```

GitHub Actions(`.github/workflows/ci.yml`)가 `main`에 push할 때와 모든 풀 리퀘스트마다, 확장 프로그램의 모든 스크립트에 대한 구문 검사와 두 테스트 스위트를 실행합니다.

기여 방법과 이슈 보고 방법은 [CONTRIBUTING.md](CONTRIBUTING.md)(영어)를 참고하세요.

## 알려진 제한 사항 / TODO

- 자동 생성(ASR) 자막에는 구두점이 없습니다. `asrPunctuation`이 `on`(기본값)이면 LLM이 먼저 단어 열을 서로 겹치는 창으로 나눠 구두점을 복원하므로, cue가 문장 경계에서 끝납니다. 영상 1분당 약 1.2초가 걸리며(16 GB GPU의 로컬 12B 모델에서 측정), 그동안 영상은 일시정지되고 진행 상황이 표시됩니다. 자막이 YouTube에서 올 때는 결과가 영상별로 저장되므로 다음부터는 기다리지 않습니다. 43분짜리 강의에서 cue의 74%가 문장 끝에서 끝났습니다(이 단계가 없으면 70%가 길이 제한 때문에 문장 중간에서 잘렸습니다). 모델이 단어를 바꿔 버린 창(이 테스트에서는 52개 중 3개)은 길이로 자르는 방식으로 되돌아갑니다. 이 단계를 건너뛰려면 `asrPunctuation`을 `off`로 하세요. 수동 자막이 가장 안정적입니다.
- YouTube가 `timedtext` 엔드포인트에 PO 토큰을 요구하여 자막 요청이 빈 응답을 돌려줄 수 있습니다. 그럴 때는 **Load captions** 버튼으로 SRT / WebVTT / JSON3 파일을 제공하세요. 예를 들어 `yt-dlp --skip-download --write-subs --sub-langs en --convert-subs srt <url>`로 만들 수 있습니다. 옵션 페이지에서 `localCaptionLang`(`English` 같은 *원본* 언어 이름)을 설정하세요. 불러온 파일은 다른 영상으로 이동하면 버려집니다. 롤링 방식의 자동 자막 VTT는 중복을 제거하지 않으므로, 이 경로에서는 수동 자막을 사용하세요.
- 번역은 cue 하나씩 진행하며, 앞선 `contextCues`개의 번역을 문맥으로 넘깁니다. 묶음 번역과 용어집을 지원하면 용어 일관성이 좋아질 것입니다.
- 우선순위에 맞는 첫 번째 자막 트랙만 사용합니다. 언어를 고르는 UI는 없습니다.
- 재생 위치보다 4개 넘게 앞선 cue의 디코딩된 오디오는 해제됩니다. 뒤로 탐색하면 다시 합성됩니다.
- 테스트는 설정, 매니페스트, 서비스 워커, ASR 헬퍼, edge-tts 브리지를 다룹니다. content script(cue 생성, 스케줄러, HUD)와 page hook에는 아직 자동 테스트가 없으며, 브라우저에서 직접 확인합니다.
## 라이선스

Copyright 2026 Nexplico-Ltd. Apache License 2.0에 따라 제공됩니다. [LICENSE](LICENSE)와 [NOTICE](NOTICE)를 참고하세요. 이 라이선스는 이 저장소의 코드에만 적용됩니다. 연동하는 서비스와 모델에는 각각 별도의 약관이 있습니다. VOICEVOX와 각 음성 캐릭터, edge-tts 뒤에 있는 Microsoft 온라인 음성 서비스, 그리고 실행하는 LLM(예: Gemma)입니다. 더빙한 영상을 공개하기 전에 확인하세요.
