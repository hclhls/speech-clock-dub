# speech-clock-dub

[![CI](https://github.com/Nexplico-Ltd/speech-clock-dub/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Nexplico-Ltd/speech-clock-dub/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | **繁體中文** | [简体中文](README.zh-CN.md)

> 本文件是英文版 [README.md](README.md) 的繁體中文翻譯。若內容不一致，以英文版為準。翻譯可能落後於最新內容。

讓畫面跟著語音走的 YouTube 講課影片配音工具。

這是一個 Chrome / Firefox（MV3）擴充功能，可把 YouTube 講課影片配音成日文、英文、繁體中文、簡體中文或韓文。它是為以投影片為主的影片設計的：不是把翻譯後的語音硬壓進畫面的節奏，而是 **讓畫面跟著語音走**。

## 運作方式

```
YouTube 字幕 -> 句子級 cue -> LLM 翻譯 -> TTS (VOICEVOX / edge-tts) -> Web Audio 佇列
                                                                            |
                              <video> 的 playbackRate / pause / play  <------+
```

- 合成的語音是主時鐘，原始音訊會被靜音。
- 每個 cue 的 `playbackRate` 會設為 `cue 剩餘時間 / 語音長度`，並限制在 `[minRate, maxRate]` 範圍內。
- 若語音比該 cue 的畫面區段長，影片會暫停（投影片定格）直到語音說完；若語音比較短，影片會以較快的速度播到下一個 cue。
- cue 之間較長的靜默空檔以 `gapRate` 速度通過。
- 預先生成（producer）迴圈會在播放之前先翻譯並合成 cue。翻譯依序進行（每句都會把前面的譯文當作上下文），語音合成則最多同時處理 `concurrency` 個 cue；對於每次請求要好幾秒的雲端 TTS，這一點很重要。在 cue 的邊界，若已備妥的語音少於 `lowWaterSec` 秒，影片就暫停，直到累積到 `highWaterSec` 秒才繼續（遲滯機制）。因為影片是從屬的一方，緩衝耗盡不會造成不同步，只會讓影片暫停。播放不會在一句話的中途被打斷。
- 使用者暫停／播放時，語音也會跟著暫停／繼續；使用者拖曳進度（seek）時，會重新對齊 cue 的位置。廣告會被偵測到（`.ad-showing`），期間排程器會暫停。

## 設定

### 快速開始（預設）：雲端託管服務

預設設定使用 Google 的兩項雲端託管服務，**不需要任何本機伺服器**。你需要一個 Google Cloud / AI Studio 帳號和兩把 API 金鑰（若同一把金鑰已啟用兩個 API，也可以共用）。

1. 用於翻譯的 **Gemini API 金鑰**。在 [Google AI Studio](https://aistudio.google.com/apikey) 建立，貼到選項頁面的 `llmApiKey`。預設值（`llmBaseUrl` = `https://generativelanguage.googleapis.com/v1beta/openai`、`llmModel` = `gemini-3.1-flash-lite`）使用 Gemini 相容 OpenAI 的端點。其他雲端託管、相容 OpenAI 的服務（OpenAI、Groq、OpenRouter 等）只要設定 `llmBaseUrl`、`llmModel` 和 `llmApiKey` 也能使用。按下 Save 時，Chrome 會就該主機詢問一次存取權限。
2. 用於語音的 **Google Cloud Text-to-Speech 金鑰**。在 Google Cloud 專案中啟用 Cloud Text-to-Speech API，建立 API 金鑰並貼到 `googleApiKey`。`ttsProvider` 一開始就是 `google`。

預設值是最便宜的選擇：翻譯用 `gemini-3.1-flash-lite`，語音用 WaveNet 聲音（撰寫時 Google 將 WaveNet 與 Standard 列為相同價格，是 Neural2 的四分之一，且每月有免費額度）。價格會變動，請查看 Google 的價格頁面。音質更好的 Neural2 和 Chirp 3 HD 聲音可用 `googleVoice` 指定。

**這兩項服務都要付費（有免費額度，費用請以 Google 的說明為準），字幕文字及其翻譯會傳送給 Google。** 金鑰和其他設定一樣存放在 `chrome.storage.sync`，請在 Google Cloud 主控台把 Text-to-Speech 金鑰限制為只能用於該 API（若 Google 支援，Gemini 金鑰也請同樣限制）。缺少金鑰時，狀態列會顯示指出該金鑰名稱的錯誤。維護者尚未把這個預設設定從頭到尾實際跑過一次；使用最多的是下面的本機設定。

`host_permissions` 中只有 `localhost` / `127.0.0.1`、`texttospeech.googleapis.com` 和 `generativelanguage.googleapis.com`。其他主機上的伺服器會在執行時請求權限（見下一節）。

### 進階：本機伺服器（選用）

想要免費且私密的配音，可以自己執行伺服器，並把設定指向它們：LLM 設定 `llmBaseUrl`、`llmModel` 和 `llmExtraBody`；TTS 則把 `ttsProvider` 設為 `auto`（日文用 VOICEVOX，其他語言用 edge-tts）、`voicevox` 或 `edge`。

1. **相容 OpenAI 的 LLM 端點**（例如 Unsloth 服務），執行 Gemma 12B 等級的模型。設定 `llmBaseUrl`（以 `/v1` 結尾的 URL，例如 `http://127.0.0.1:8888/v1`）和 `llmModel`。使用 Gemma 4 時，也要把 `llmExtraBody` 設為 `{"chat_template_kwargs":{"enable_thinking":false}}`，否則每一行可能要花上數分鐘。擴充功能會呼叫 `POST {llmBaseUrl}/chat/completions`。
2. **VOICEVOX 引擎**（開源、高品質的日文 TTS）：

   ```
   # GPU（需要 nvidia-container-toolkit）。映像檔的預設指令已經帶有
   # --use_gpu --host 0.0.0.0，所以請不要再附加參數：它們會取代該預設指令。
   docker run -d --rm --name voicevox --gpus all -p 50021:50021 voicevox/voicevox_engine:nvidia-latest
   # 僅 CPU
   docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-latest
   ```

   VOICEVOX 大約需要 1-2 GB 的 VRAM，所以可以和 12B 的 LLM 共用一張 16 GB 的 GPU。

   每個聲音角色都有各自的使用條款，公開配音後的影片之前請先確認。
   `speakerFemale` / `speakerMale` 是 VOICEVOX 的風格 ID（可用 `GET /speakers` 列出）。

   **VRAM：** 每多用一個 VOICEVOX 聲音，就會在 GPU 上多載入一個模型。若 12B 的 LLM 幾乎佔滿 16 GB 的顯示卡（例如上下文視窗非常大），第一個聲音可能正常，另一個聲音卻會因 CUDA 記憶體不足而失敗（`/synthesis` 回傳 HTTP 500）。配音只需要幾千個 token 的 LLM 上下文，所以載入模型時請調低上下文長度。在 16 GB 的 RTX 4060 Ti 與 Gemma 4 12B（Q4）上的實測：上下文為 262144 個 token 時，llama-server 用了 14.2 GB（剩餘約 0.5 GB，男聲失敗）；調成 16384 後用了 9.5 GB（載入 VOICEVOX 後剩餘約 3.9 GB，兩種聲音都正常），翻譯也變快了（每句 0.5 秒 -> 0.3 秒）。

   另一個做法是讓 VOICEVOX 在 CPU 上執行（每句約為即時速度的 0.5 倍）。覆寫映像檔的指令來省略 `--use_gpu`：`... voicevox_engine:nvidia-latest gosu user /opt/voicevox_engine/run --host 0.0.0.0`。

3. **edge-tts 橋接程式**（僅用於日文以外的目標語言；若你想用它取代 VOICEVOX，日文也可以）。edge-tts 透過非官方 API 使用 Microsoft 的線上語音服務，因此 **翻譯後的文字會傳送給 Microsoft**，需要網際網路連線，而且服務一旦變動就可能失效。擴充功能透過一個小型的本機 HTTP 橋接程式來使用它：

   ```
   python3 -m venv .venv && .venv/bin/pip install edge-tts
   .venv/bin/python tools/edge_tts_server.py        # 監聽 127.0.0.1:5050
   ```

   `--port` 可變更連接埠（之後請同步更新 `edgeUrl`）。每句約需 2-3 秒；緩衝填滿之後，平行的 producer 會把這段延遲遮掉，但第一次開始播放會比 VOICEVOX 久。

   如果合成以 `403 Invalid response status` 失敗，代表 Microsoft 的服務已變更，而你的 edge-tts 已過時：請執行 `.venv/bin/pip install -U edge-tts` 並重新啟動橋接程式。

## 設定檔

選項頁面的 **Profile** 欄可以切換整組設定，例如在筆電上用雲端託管設定、在家裡用本機伺服器。內建了一些設定檔（見下表）。**Load** 會把所選設定檔載入表單，**Save** 才會套用。設定檔會決定 API 金鑰以外的所有設定：沒有列出的設定會回到預設值，所以 Load 之後請先確認語言和聲音再 Save。**Save as profile** 會以你輸入的名稱儲存目前的表單（會儲存 API 金鑰以外的所有設定，所以之後預設值改變時，設定檔的意義也不會變），**Delete** 會刪除你自己建立的設定檔，**Export file** / **Import file** 可以用 JSON 檔把設定檔搬到另一個瀏覽器。API 金鑰不屬於任何設定檔：所有設定檔共用，也不會被匯出或匯入。設定檔存放在 `chrome.storage.sync`，每個設定檔一個項目。

內建設定檔：

| 設定檔 | 翻譯 | 語音 |
| --- | --- | --- |
| `Hosted (Gemini + Google TTS)` | Gemini（雲端託管） | Google Cloud TTS（預設） |
| `Local (Unsloth + VOICEVOX / edge-tts)` | 本機 Unsloth 伺服器 | 日文用 VOICEVOX，其他語言用 edge-tts |
| `Gemini + edge-tts (free voice)` | Gemini（雲端託管） | edge-tts 橋接器（沒有 Google TTS 費用） |
| `Local LLM + Google TTS` | 本機 Unsloth 伺服器 | Google Cloud TTS |
| `Interview / podcast (two voices)` | Gemini（雲端託管） | Google Cloud TTS，每次換講者就切換聲音（`speakerVoices` = `alternate`） |

## 使用另一台機器上的伺服器

LLM、VOICEVOX 與 edge-tts 橋接程式可以跑在另一台電腦上，例如區域網路中的 GPU 主機。請在那台機器上讓伺服器監聽網路，並在防火牆開放連接埠（僅限你的區域網路）：VOICEVOX 使用 `--host 0.0.0.0`，橋接程式使用 `tools/edge_tts_server.py --host 0.0.0.0`，LLM 伺服器則使用它自己的主機選項。接著在選項頁面的 `llmBaseUrl`、`voicevoxUrl`、`edgeUrl` 填入如 `http://192.168.1.20:8888/v1` 的網址。按下儲存時，Chrome 會針對每個主機詢問一次，是否允許擴充功能連線（`optional_host_permissions`）。通訊是明文 HTTP，橋接程式與 VOICEVOX 也沒有驗證機制，請只在你信任的網路中使用。

### HTTPS

伺服器本身只使用明文 HTTP（VOICEVOX 沒有 TLS 選項）。擴充功能接受 `https://` 網址，所以請在另一台機器的伺服器前面放一個負責終結 TLS 的反向代理，並填入代理的網址（例如 `voicevoxUrl` = `https://voicevox.lan:50443`）。[Caddy](https://caddyserver.com/) 會用自己的本機 CA 產生憑證，`Caddyfile` 只需要這樣：

```
voicevox.lan:50443 {
    reverse_proxy 127.0.0.1:50021
}
```

執行擴充功能那台電腦上的 Chrome 必須信任該憑證（使用 Caddy 時，安裝一次它的根憑證），否則請求會失敗。如果你使用 Tailscale，`tailscale serve --https=50443 http://127.0.0.1:50021` 會為機器在 tailnet 中的名稱提供公開受信任的憑證，不需要設定信任。edge-tts 橋接程式與 LLM 伺服器也可以用同樣的方法。這些代理設定尚未在本擴充功能上測試過。

## 目標語言

在選項頁面設定 `targetLang`：

| `targetLang` | 語言 | edge-tts 預設聲音（女聲） |
| --- | --- | --- |
| `ja` | 日文 | `ja-JP-NanamiNeural`（預設使用 VOICEVOX） |
| `en` | 英文 | `en-US-AriaNeural` |
| `zh-TW` | 繁體中文（台灣） | `zh-TW-HsiaoChenNeural` |
| `zh-CN` | 簡體中文 | `zh-CN-XiaoxiaoNeural` |
| `ko` | 韓文 | `ko-KR-SunHiNeural` |

`translationLevel` 決定譯文的難度：`standard`（預設）、`easy`（給學習者的簡單詞彙和短句；日文約 JLPT N5～N3）、`advanced`（更精確、較正式的用語；日文約 JLPT N3～N1）。意思和專業術語不會改變。這只是在翻譯提示中加一條規則，遵守的程度取決於模型。

`voiceGender`（`female` 或 `male`）用來選擇聲音：

| `targetLang` | female | male |
| --- | --- | --- |
| `ja`（VOICEVOX） | 風格 `2`（四国めたん） | 風格 `11`（玄野武宏） |
| `ja`（edge-tts） | `ja-JP-NanamiNeural` | `ja-JP-KeitaNeural` |
| `en` | `en-US-AriaNeural` | `en-US-GuyNeural` |
| `zh-TW` | `zh-TW-HsiaoChenNeural` | `zh-TW-YunJheNeural` |
| `zh-CN` | `zh-CN-XiaoxiaoNeural` | `zh-CN-YunxiNeural` |
| `ko` | `ko-KR-SunHiNeural` | `ko-KR-InJoonNeural` |

`ttsProvider` 預設為 `google`（Google Cloud Text-to-Speech）；`auto` 表示 `ja` 使用 VOICEVOX，其他語言使用 edge-tts；設為 `google` 則使用 Google Cloud Text-to-Speech（預設聲音：`ja-JP-Wavenet-B/C`、`en-US-Wavenet-F/D`、`cmn-TW-Wavenet-A/B`、`cmn-CN-Wavenet-A/B`、`ko-KR-Wavenet-A/C`；`googleVoice` 可覆寫聲音，`googleSpeed` 可設定語速）。`edgeVoice` 可覆寫 edge-tts 的聲音（用 `.venv/bin/edge-tts --list-voices` 列出），`edgeRate`（例如 `+10%`）可調整語速。若要新增語言，請在 `extension/defaults.js` 的 `YTD_LANGS` 加入一個項目。

`speakerVoices`（預設 `off`）適用於訪談、Podcast 之類的對話。許多手動字幕會在換人說話時，在行首加上 `- ` 或 `>>`。設為 `alternate` 後，這些標記會從文字中移除，並在每次換人時切換聲音：第一位說話者使用 `voiceGender` 的聲音，另一位使用相反性別的聲音。標記中沒有姓名，所以只適用於兩個人；自動產生的字幕通常也沒有這些標記。

`voice1Provider` / `voice1Voice` 與 `voice2Provider` / `voice2Voice` 可分別指定第一位與第二位說話者的提供者與聲音。`voice1*` 適用於所有字幕句（單人影片的聲音也由它決定），`voice2*` 只用於對話（`speakerVoices` 為 `alternate` 或 `llm`）中的第二位說話者。兩者搭配可以混用不同提供者，或使用兩個相同性別的聲音，例如第一位用 VOICEVOX 樣式 `8`，第二位用 Google 的 `ja-JP-Neural2-B`。聲音依提供者而定，可以是 VOICEVOX 樣式 ID、edge-tts 聲音名稱或 Google 聲音名稱。留空則維持原本行為（使用 `ttsProvider`，第二位說話者的性別與 `voiceGender` 相反）。

對於沒有標記的字幕，另有實驗性的 `llm` 模式：翻譯所用的 LLM 每 15 個 cue 只根據文字，判斷哪些行屬於主持人（`voiceGender` 的聲音）、哪些屬於來賓（相反性別的聲音）。提示詞以訪談為前提，每 15 個 cue 約多一次請求，自動產生的字幕也能使用。在移除標記的 Lex Fridman #494 字幕上做的離線測試（Gemma 4 12B，3 段各 300 句）中，它找出了 70–80% 的換人處，精確率相近；漏掉換人時，聲音角色可能會對調一陣子，請求失敗則沿用前一個聲音。如果前 30 個 cue 幾乎都被判定為同一位說話者（例如講課），就視為獨白，只使用一個聲音。請把它當作粗略的輔助，而不是可靠的說話者辨識。

## 畫面字幕

播放器中的 **Sub** 按鈕會依序切換 `off` -> `translated` -> `both`（譯文加原文）。選擇會儲存在 `subtitles` 設定中（預設 `off`）。正在朗讀的 cue 的文字會顯示在播放器下方，cue 之間會隱藏；使用者暫停時則維持顯示。字體大小會隨播放器寬度縮放，所以全螢幕也適用。它顯示在 YouTube 自己的字幕列上方，因此就算開啟了 YouTube 字幕也不會重疊。 較長的句子會分成每頁最多 `subtitleMaxLines` 行（預設 2，`0` 表示不限制）的頁面顯示，頁面會隨語音的進度切換，因此字幕不會大面積遮住影片。在 `both` 模式下，譯文與原文各自分開限制。

## 安裝（開發用）

1. Chrome：開啟 `chrome://extensions`，啟用「開發人員模式」，按下「載入未封裝項目」，選擇 `extension/`。
2. 開啟擴充功能的選項頁面並調整設定。常用設定（語言、聲音性別、字幕、TTS 提供者、API 金鑰）在最上方，其餘收在摺疊區段（聲音細節、伺服器與模型、字幕與斷句、緩衝與影片速度）中。含有已變更值的區段會自動展開。
3. 開啟一支有字幕的 YouTube 影片，按下播放器左上角的 **Dub (xx)**（**Sub** 用來切換畫面上的翻譯字幕）。每次重新載入擴充功能之後，也要重新整理 YouTube 分頁。

**Firefox（140 以上）：** 開啟 `about:debugging#/runtime/this-firefox`，按「載入暫時性附加元件...」並選擇 `extension/manifest.json`。暫時性附加元件會在 Firefox 結束時移除。兩個瀏覽器使用同一份檔案（Chrome 使用 `background.service_worker`，Firefox 使用 `background.scripts`）。主機權限會在安裝時詢問，可在 `about:addons` 的擴充功能「權限」中撤銷。選項頁面在 `about:addons` 的「偏好設定」。 已在 Linux 上的 Firefox 測試通過。

**Android（Firefox for Android，實驗性）：** 也支援 `m.youtube.com`，HUD 按鈕和選項頁面已調整為適合觸控的大小。已在實機（Firefox for Android）上用預設的雲端組合測試通過。要試用，請在手機上開啟 USB 偵錯，執行 `npx web-ext run --source-dir extension --target firefox-android --android-device <id>`（id 可用 `adb devices` 查看），或從連接手機的桌面版 Firefox 的 `about:debugging` 載入。Chrome for Android 不支援擴充功能。預設的雲端組合（Gemini 與 Google TTS）只要有 API 金鑰就能在手機上運作；本機的 LLM、VOICEVOX 或 edge-tts 橋接必須在同一網路的電腦上執行，並把它的區域網路位址填入 `llmBaseUrl`、`voicevoxUrl`、`edgeUrl`。瀏覽器進入背景或螢幕鎖定時，聲音會停止。iOS 需要另外的 Safari Web Extension，目前尚未支援。

**Udemy（實驗性）：** 也支援 `*.udemy.com`。在課程頁面的播放器上會出現同樣的 **Dub** 按鈕。Udemy 自行繪製字幕，不會替影片加上 `<track>` 元素，因此擴充功能會請求播放器所用的同一個課程單元 API（需要已登入 Udemy 並已加入該課程），並載入單元中列出的第一個字幕檔（WebVTT）。影片的標準 `<track>` 元素只作為備用。單元沒有字幕時，請用 **Load captions** 載入 SRT/VTT 檔案。站點專用的程式碼在 `extension/providers.js` 中；要支援其他站點，只需在那裡加一個適配器，並在 `manifest.json` 中加一個 `matches`。

**Vimeo（實驗性）：** Vimeo 的所有影片都在 `player.vimeo.com` 框架內播放（vimeo.com 和嵌入它的頁面都一樣），因此擴充功能會在該框架內執行，並在播放器上顯示同樣的 **Dub** 按鈕。字幕檔從播放器設定（`/video/<id>/config`）讀取，優先使用人工製作的軌道而不是自動產生的軌道，影片的標準 `<track>` 元素作為備用。尚未在真實的 Vimeo 影片上測試。沒有字幕的影片需要使用 **Load captions**。限制了可播放網域的嵌入（網域層級隱私）可能會拒絕設定請求。

## 範例講課影片

這個擴充功能是為以投影片為主的講課影片設計的。以下四個播放清單和一集 Podcast 可以拿來試用：

- Adi Teman 的 [Digital Integrated Circuits (2020-21)](https://www.youtube.com/playlist?list=PLZU5hLL_713yF0Lkwjj9O3ttVIuhPV-me)（Bar-Ilan University 83-313，共 66 支影片）。我們檢查過的課程都有手動的英文字幕，是支援最完整的情況。
- Tony Chan Carusone 教授的 [CMOS Analog Integrated Circuit Design Fundamentals](https://www.youtube.com/playlist?list=PLUJOuapA83-QlWbnMJvoyQucGaBlpBF0F)（Microelectronics 頻道上 37 支研究所等級的影片）。這些影片只有自動產生的英文字幕，這是測試最少的路徑（請見下方的「已知限制 / TODO」）。
- Razavi 的 [Beauty of Circuits](https://www.youtube.com/playlist?list=PLvYonHCKSWagKgNwtFKlWmkN7aKeSBPEO)（課程）。我們尚未檢查其字幕，請視為未經測試。
- ETH Zürich Onur Mutlu 教授的 [Digital Design and Computer Architecture (Spring 2025)](https://www.youtube.com/playlist?list=PL5Q2soXY2Zi9Eo29LMgKVcaydS7V1zZW3)（直播課程）。我們尚未檢查其字幕，請視為未經測試。
- Lex Fridman Podcast 的 [#494 Jensen Huang](https://www.youtube.com/watch?v=vif8NQcjVf0)（沒有投影片的 2 小時 26 分鐘對談，有英文字幕）。可以用它看看在較長的純語音影片上的表現，但測試不如上面的課程充分。

有手動字幕的影片效果更好。這些影片不屬於本專案，本專案與其作者也沒有關係。請尊重作者的權利，未經許可不要重新發布配音後的副本。

## 檔案

| 檔案 | 用途 |
| --- | --- |
| `extension/manifest.json` | MV3 資訊清單 |
| `extension/defaults.js` | 所有環境共用的預設設定 |
| `extension/page-hook.js` | MAIN world 腳本；透過播放器 API 取得字幕 JSON |
| `extension/asr.js` | ASR 字幕輔助函式：單字攤平、標點視窗、對齊、以句子為單位的 cue |
| `extension/speakers.js` | 對話輔助函式：依換人標記切分字幕，並交替分配聲音 |
| `extension/subtitle.js` | 字幕分頁輔助函式：把較長的文字分成幾行一頁 |
| `extension/providers.js` | 站點適配器（YouTube、Udemy、Vimeo）：尋找影片與播放器、取得字幕、偵測頁面切換 |
| `extension/content.js` | cue 的建立、預先生成迴圈、播放排程器、HUD |
| `extension/background.js` | Service worker；與 LLM、VOICEVOX、edge-tts 的 HTTP 橋接 |
| `extension/options.html`, `options.js` | 設定介面 |
| `tools/edge_tts_server.py` | 包裝 `edge-tts` 的本機 HTTP 橋接程式 |
| `tests/` | 單元測試（擴充功能用 Node 內建的測試執行器，橋接程式用 `unittest`） |
| `.github/workflows/ci.yml` | GitHub Actions CI |

## 開發

```
npm test                                                  # 擴充功能測試（Node 22 以上，無相依套件）
.venv/bin/pip install ruff
.venv/bin/ruff check tools tests                          # 對橋接程式及其測試做 lint
.venv/bin/python -m unittest discover -s tests -p "test_*.py"   # 橋接程式測試
```

每次推送到 `main`，以及每個 pull request，GitHub Actions（`.github/workflows/ci.yml`）都會對所有擴充功能腳本做語法檢查，並執行兩組測試。

參與貢獻與回報問題的方式，請見 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。

## 已知限制 / TODO

- 自動產生（ASR）的字幕沒有標點。當 `asrPunctuation` 為 `on`（預設）時，LLM 會先把單字序列分成彼此重疊的視窗來還原標點，讓 cue 在句子邊界結束。這大約每分鐘影片需要 1.2 秒（在 16 GB GPU 上以本機 12B 模型實測），期間影片會暫停並顯示進度。字幕來自 YouTube 時，結果會依影片儲存，之後再開始就不用等。在一支 43 分鐘的課程上，74% 的 cue 結束於句尾（沒有這個步驟時，70% 會因長度上限而在句子中途被切斷）。模型改動了單字的視窗（該測試中 52 個有 3 個）會退回依長度切分。若要略過這個步驟，請把 `asrPunctuation` 設為 `off`。手動字幕仍然效果最好。
- YouTube 可能要求 `timedtext` 端點提供 PO token，使字幕請求回傳空內容。這時請用 **Load captions** 按鈕提供 SRT / WebVTT / JSON3 檔案，例如用 `yt-dlp --skip-download --write-subs --sub-langs en --convert-subs srt <url>` 產生。請在選項頁面設定 `localCaptionLang`（*來源*語言的名稱，例如 `English`）。切換到其他影片時，載入的檔案會被丟棄。滾動式（rolling）的自動字幕 VTT 不會去除重複；這條路徑請使用手動字幕。
- 翻譯一次處理一個 cue，並以前面 `contextCues` 句的譯文作為上下文。支援批次翻譯與術語表可改善用語一致性。
- 只會使用符合偏好順序的第一條字幕軌，沒有語言選擇介面。
- 比播放位置更早 4 個以上的 cue，其解碼後的音訊會被釋放；往回拖曳時會重新合成。
- 測試涵蓋設定、資訊清單、service worker、ASR 輔助函式與 edge-tts 橋接程式。content script（cue 建立、排程器、HUD）與 page hook 目前還沒有自動化測試，是在瀏覽器中手動檢查。
## 授權

Copyright 2026 Nexplico-Ltd. 依 Apache License 2.0 授權，詳見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。這僅適用於本儲存庫中的程式碼。它所串接的服務與模型各有自己的條款：VOICEVOX 及其每個聲音角色、edge-tts 背後的 Microsoft 線上語音服務，以及你所執行的 LLM（例如 Gemma）。公開配音後的影片之前請先確認。
