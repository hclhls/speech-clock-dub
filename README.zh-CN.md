# speech-clock-dub

[![CI](https://github.com/Nexplico-Ltd/speech-clock-dub/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Nexplico-Ltd/speech-clock-dub/actions/workflows/ci.yml)

[English](README.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [繁體中文](README.zh-TW.md) | **简体中文**

> 本文档是英文版 [README.md](README.md) 的简体中文翻译。如有出入，以英文版为准。翻译可能落后于最新内容。

让画面跟着语音走的 YouTube 讲课视频配音工具。

这是一个 Chrome / Firefox（MV3）扩展程序，可以把 YouTube 讲课视频配音成日语、英语、繁体中文、简体中文或韩语。它面向以幻灯片为主的视频：不是把翻译后的语音硬压进画面的节奏，而是 **让画面跟着语音走**。

## 工作原理

```
YouTube 字幕 -> 句子级 cue -> LLM 翻译 -> TTS (VOICEVOX / edge-tts) -> Web Audio 队列
                                                                            |
                              <video> 的 playbackRate / pause / play  <------+
```

- 合成的语音是主时钟，原始音频会被静音。
- 每个 cue 的 `playbackRate` 会设为 `cue 剩余时间 / 语音时长`，并限制在 `[minRate, maxRate]` 范围内。
- 如果语音比该 cue 的画面片段长，视频会暂停（幻灯片定格），直到语音说完；如果语音更短，视频会以更快的速度播放到下一个 cue。
- cue 之间较长的静默间隙以 `gapRate` 速度通过。
- 预生成（producer）循环会在播放之前先翻译并合成 cue。翻译按顺序进行（每句都会把前面的译文作为上下文），语音合成则最多同时处理 `concurrency` 个 cue；对于每次请求要几秒的云端 TTS，这一点很重要。在 cue 的边界，如果已准备好的语音少于 `lowWaterSec` 秒，视频就暂停，直到积累到 `highWaterSec` 秒才继续（迟滞机制）。因为视频是从属的一方，缓冲耗尽不会造成不同步，只会让视频暂停。播放不会在一句话的中途被打断。
- 用户暂停/播放时，语音也会随之暂停/继续；用户拖动进度（seek）时，会重新对齐 cue 的位置。广告会被检测到（`.ad-showing`），期间调度器会暂停。

## 设置

### 快速开始（默认）：云端托管服务

默认设置使用 Google 的两项云端托管服务，**不需要任何本地服务器**。你需要一个 Google Cloud / AI Studio 账号和两个 API 密钥（若同一个密钥已启用两个 API，也可以共用）。

1. 用于翻译的 **Gemini API 密钥**。在 [Google AI Studio](https://aistudio.google.com/apikey) 创建，粘贴到选项页面的 `llmApiKey`。默认值（`llmBaseUrl` = `https://generativelanguage.googleapis.com/v1beta/openai`、`llmModel` = `gemini-3.1-flash-lite`）使用 Gemini 兼容 OpenAI 的端点。其他云端托管、兼容 OpenAI 的服务（OpenAI、Groq、OpenRouter 等）只要设置 `llmBaseUrl`、`llmModel` 和 `llmApiKey` 也能使用。按下 Save 时，Chrome 会就该主机询问一次访问权限。
2. 用于语音的 **Google Cloud Text-to-Speech 密钥**。在 Google Cloud 项目中启用 Cloud Text-to-Speech API，创建 API 密钥并粘贴到 `googleApiKey`。`ttsProvider` 一开始就是 `google`。

默认值是最便宜的选择：翻译用 `gemini-3.1-flash-lite`，语音用 WaveNet 声音（撰写时 Google 将 WaveNet 与 Standard 列为相同价格，是 Neural2 的四分之一，且每月有免费额度）。价格会变动，请查看 Google 的价格页面。音质更好的 Neural2 和 Chirp 3 HD 声音可用 `googleVoice` 指定。

**这两项服务都要付费（有免费额度，费用请以 Google 的说明为准），字幕文字及其翻译会发送给 Google。** 密钥和其他设置一样保存在 `chrome.storage.sync`，请在 Google Cloud 控制台把 Text-to-Speech 密钥限制为只能用于该 API（若 Google 支持，Gemini 密钥也请同样限制）。缺少密钥时，状态栏会显示指出该密钥名称的错误。维护者尚未把这个默认配置从头到尾实际运行过一次；使用最多的是下面的本地配置。

`host_permissions` 中只有 `localhost` / `127.0.0.1`、`texttospeech.googleapis.com` 和 `generativelanguage.googleapis.com`。其他主机上的服务器会在运行时请求权限（见下一节）。

### 高级：本地服务器（可选）

想要免费且私密的配音，可以自己运行服务器，并把设置指向它们：LLM 设置 `llmBaseUrl`、`llmModel` 和 `llmExtraBody`；TTS 则把 `ttsProvider` 设为 `auto`（日语用 VOICEVOX，其他语言用 edge-tts）、`voicevox` 或 `edge`。

1. **兼容 OpenAI 的 LLM 端点**（例如 Unsloth 服务），运行 Gemma 12B 级别的模型。设置 `llmBaseUrl`（以 `/v1` 结尾的 URL，例如 `http://127.0.0.1:8888/v1`）和 `llmModel`。使用 Gemma 4 时，还要把 `llmExtraBody` 设为 `{"chat_template_kwargs":{"enable_thinking":false}}`，否则每一行可能要花数分钟。扩展会调用 `POST {llmBaseUrl}/chat/completions`。
2. **VOICEVOX 引擎**（开源、高质量的日语 TTS）：

   ```
   # GPU（需要 nvidia-container-toolkit）。镜像的默认命令已经带有
   # --use_gpu --host 0.0.0.0，所以请不要再追加参数：它们会替换该默认命令。
   docker run -d --rm --name voicevox --gpus all -p 50021:50021 voicevox/voicevox_engine:nvidia-latest
   # 仅 CPU
   docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-latest
   ```

   VOICEVOX 大约需要 1-2 GB 的 VRAM，所以可以和 12B 的 LLM 共用一张 16 GB 的 GPU。

   每个声音角色都有各自的使用条款，公开配音后的视频之前请先确认。
   `speakerFemale` / `speakerMale` 是 VOICEVOX 的风格 ID（可用 `GET /speakers` 列出）。

   **VRAM：** 每多用一个 VOICEVOX 声音，就会在 GPU 上多加载一个模型。如果 12B 的 LLM 几乎占满 16 GB 的显卡（例如上下文窗口非常大），第一个声音可能正常，另一个声音却会因 CUDA 内存不足而失败（`/synthesis` 返回 HTTP 500）。配音只需要几千个 token 的 LLM 上下文，所以加载模型时请调低上下文长度。在 16 GB 的 RTX 4060 Ti 与 Gemma 4 12B（Q4）上的实测：上下文为 262144 个 token 时，llama-server 用了 14.2 GB（剩余约 0.5 GB，男声失败）；调成 16384 后用了 9.5 GB（加载 VOICEVOX 后剩余约 3.9 GB，两种声音都正常），翻译也变快了（每句 0.5 秒 -> 0.3 秒）。

   另一个做法是让 VOICEVOX 在 CPU 上运行（每句约为实时速度的 0.5 倍）。覆盖镜像的命令来省略 `--use_gpu`：`... voicevox_engine:nvidia-latest gosu user /opt/voicevox_engine/run --host 0.0.0.0`。

3. **edge-tts 桥接程序**（仅用于日语以外的目标语言；如果你想用它代替 VOICEVOX，日语也可以）。edge-tts 通过非官方 API 使用 Microsoft 的在线语音服务，因此 **翻译后的文本会发送给 Microsoft**，需要互联网连接，而且服务一旦变动就可能失效。扩展程序通过一个小型的本地 HTTP 桥接程序来使用它：

   ```
   python3 -m venv .venv && .venv/bin/pip install edge-tts
   .venv/bin/python tools/edge_tts_server.py        # 监听 127.0.0.1:5050
   ```

   `--port` 可更改端口（之后请同步更新 `edgeUrl`）。每句约需 2-3 秒；缓冲填满之后，并行的 producer 会把这段延迟掩盖掉，但第一次开始播放会比 VOICEVOX 久。

   如果合成以 `403 Invalid response status` 失败，说明 Microsoft 的服务已变更，而你的 edge-tts 已过时：请运行 `.venv/bin/pip install -U edge-tts` 并重启桥接程序。

## 配置文件

选项页面的 **Profile** 栏可以切换整套设置，例如在笔记本上用云端托管设置、在家里用本地服务器。内置了一些配置文件（见下表）。**Load** 会把所选配置文件载入表单，**Save** 才会应用。配置文件会决定 API 密钥以外的所有设置：没有列出的设置会回到默认值，所以 Load 之后请先确认语言和声音再 Save。**Save as profile** 会用你输入的名称保存当前表单（会保存 API 密钥以外的所有设置，所以之后默认值改变时，配置文件的含义也不会变），**Delete** 会删除你自己创建的配置文件，**Export file** / **Import file** 可以用 JSON 文件把配置文件转移到另一个浏览器。API 密钥不属于任何配置文件：所有配置文件共用，也不会被导出或导入。配置文件保存在 `chrome.storage.sync`，每个配置文件一个条目。

内置配置文件：

| 配置文件 | 翻译 | 语音 |
| --- | --- | --- |
| `Hosted (Gemini + Google TTS)` | Gemini（云端托管） | Google Cloud TTS（默认） |
| `Local (Unsloth + VOICEVOX / edge-tts)` | 本地 Unsloth 服务器 | 日语用 VOICEVOX，其他语言用 edge-tts |
| `Gemini + edge-tts (free voice)` | Gemini（云端托管） | edge-tts 桥接器（没有 Google TTS 费用） |
| `Local LLM + Google TTS` | 本地 Unsloth 服务器 | Google Cloud TTS |
| `Interview / podcast (two voices)` | Gemini（云端托管） | Google Cloud TTS，每次换讲者就切换声音（`speakerVoices` = `alternate`） |

## 使用另一台机器上的服务器

LLM、VOICEVOX 和 edge-tts 桥接程序可以运行在另一台电脑上，例如局域网中的 GPU 主机。请在那台机器上让服务器监听网络，并在防火墙开放端口（仅限你的局域网）：VOICEVOX 使用 `--host 0.0.0.0`，桥接程序使用 `tools/edge_tts_server.py --host 0.0.0.0`，LLM 服务器则使用它自己的主机选项。然后在选项页面的 `llmBaseUrl`、`voicevoxUrl`、`edgeUrl` 填入如 `http://192.168.1.20:8888/v1` 的地址。点击保存时，Chrome 会针对每个主机询问一次，是否允许扩展程序连接（`optional_host_permissions`）。通信是明文 HTTP，桥接程序和 VOICEVOX 也没有认证机制，请只在你信任的网络中使用。

### HTTPS

服务器本身只使用明文 HTTP（VOICEVOX 没有 TLS 选项）。扩展程序接受 `https://` 地址，所以请在另一台机器的服务器前面放一个负责终结 TLS 的反向代理，并填入代理的地址（例如 `voicevoxUrl` = `https://voicevox.lan:50443`）。[Caddy](https://caddyserver.com/) 会用自己的本地 CA 生成证书，`Caddyfile` 只需要这样：

```
voicevox.lan:50443 {
    reverse_proxy 127.0.0.1:50021
}
```

运行扩展程序那台电脑上的 Chrome 必须信任该证书（使用 Caddy 时，安装一次它的根证书），否则请求会失败。如果你使用 Tailscale，`tailscale serve --https=50443 http://127.0.0.1:50021` 会为机器在 tailnet 中的名称提供公开受信任的证书，不需要设置信任。edge-tts 桥接程序和 LLM 服务器也可以用同样的方法。这些代理配置尚未在本扩展程序上测试过。

## 目标语言

在选项页面设置 `targetLang`：

| `targetLang` | 语言 | edge-tts 默认声音（女声） |
| --- | --- | --- |
| `ja` | 日语 | `ja-JP-NanamiNeural`（默认使用 VOICEVOX） |
| `en` | 英语 | `en-US-AriaNeural` |
| `zh-TW` | 繁体中文（台湾） | `zh-TW-HsiaoChenNeural` |
| `zh-CN` | 简体中文 | `zh-CN-XiaoxiaoNeural` |
| `ko` | 韩语 | `ko-KR-SunHiNeural` |

`translationLevel` 决定译文的难度：`standard`（默认）、`easy`（给学习者的简单词汇和短句；日语约 JLPT N5～N3）、`advanced`（更精确、较正式的用语；日语约 JLPT N3～N1）。意思和专业术语不会改变。这只是在翻译提示中加一条规则，遵守的程度取决于模型。

`voiceGender`（`female` 或 `male`）用来选择声音：

| `targetLang` | female | male |
| --- | --- | --- |
| `ja`（VOICEVOX） | 风格 `2`（四国めたん） | 风格 `11`（玄野武宏） |
| `ja`（edge-tts） | `ja-JP-NanamiNeural` | `ja-JP-KeitaNeural` |
| `en` | `en-US-AriaNeural` | `en-US-GuyNeural` |
| `zh-TW` | `zh-TW-HsiaoChenNeural` | `zh-TW-YunJheNeural` |
| `zh-CN` | `zh-CN-XiaoxiaoNeural` | `zh-CN-YunxiNeural` |
| `ko` | `ko-KR-SunHiNeural` | `ko-KR-InJoonNeural` |

`ttsProvider` 默认为 `google`（Google Cloud Text-to-Speech）；`auto` 表示 `ja` 使用 VOICEVOX，其他语言使用 edge-tts；设为 `google` 则使用 Google Cloud Text-to-Speech（默认声音：`ja-JP-Wavenet-B/C`、`en-US-Wavenet-F/D`、`cmn-TW-Wavenet-A/B`、`cmn-CN-Wavenet-A/B`、`ko-KR-Wavenet-A/C`；`googleVoice` 可覆盖声音，`googleSpeed` 可设置语速）。`edgeVoice` 可覆盖 edge-tts 的声音（用 `.venv/bin/edge-tts --list-voices` 列出），`edgeRate`（例如 `+10%`）可调整语速。如需添加语言，请在 `extension/defaults.js` 的 `YTD_LANGS` 中加入一个条目。

`speakerVoices`（默认 `off`）适用于访谈、播客之类的对话。许多手动字幕会在换人说话时，在行首加上 `- ` 或 `>>`。设为 `alternate` 后，这些标记会从文本中去掉，并在每次换人时切换声音：第一位说话者使用 `voiceGender` 的声音，另一位使用相反性别的声音。标记中没有姓名，所以只适用于两个人；自动生成的字幕通常也没有这些标记。

`voice1Provider` / `voice1Voice` 与 `voice2Provider` / `voice2Voice` 可分别指定第一位和第二位说话者的提供者与声音。`voice1*` 适用于所有字幕句（单人视频的声音也由它决定），`voice2*` 只用于对话（`speakerVoices` 为 `alternate` 或 `llm`）中的第二位说话者。两者搭配可以混用不同提供者，或使用两个相同性别的声音，例如第一位用 VOICEVOX 样式 `8`，第二位用 Google 的 `ja-JP-Neural2-B`。声音取决于提供者，可以是 VOICEVOX 样式 ID、edge-tts 声音名称或 Google 声音名称。留空则保持原有行为（使用 `ttsProvider`，第二位说话者的性别与 `voiceGender` 相反）。

对于没有标记的字幕，另有实验性的 `llm` 模式：翻译所用的 LLM 每 15 个 cue 只根据文本，判断哪些行属于主持人（`voiceGender` 的声音）、哪些属于嘉宾（相反性别的声音）。提示词以访谈为前提，每 15 个 cue 约多一次请求，自动生成的字幕也能使用。在去掉标记的 Lex Fridman #494 字幕上做的离线测试（Gemma 4 12B，3 段各 300 句）中，它找出了 70–80% 的换人处，精确率相近；漏掉换人时，声音角色可能会对调一阵子，请求失败则沿用前一个声音。如果前 30 个 cue 几乎都被判定为同一位说话人（例如讲课），就视为独白，只使用一个声音。请把它当作粗略的辅助，而不是可靠的说话人识别。

## 屏幕字幕

播放器中的 **Sub** 按钮会依次切换 `off` -> `translated` -> `both`（译文加原文）。选择会保存在 `subtitles` 设置中（默认 `off`）。正在朗读的 cue 的文字会显示在播放器下方，cue 之间会隐藏；用户暂停时则保持显示。字体大小会随播放器宽度缩放，所以全屏也适用。它显示在 YouTube 自带的字幕行上方，因此即使开启了 YouTube 字幕也不会重叠。 较长的句子会分成每页最多 `subtitleMaxLines` 行（默认 2，`0` 表示不限制）的页面显示，页面会随语音的进度切换，因此字幕不会大面积遮住视频。在 `both` 模式下，译文与原文各自分开限制。

## 安装（开发用）

1. Chrome：打开 `chrome://extensions`，启用“开发者模式”，点击“加载已解压的扩展程序”，选择 `extension/`。
2. 打开扩展程序的选项页面并调整设置。常用设置（语言、声音性别、字幕、TTS 提供者、API 密钥）在最上方，其余收在折叠区段（声音细节、服务器与模型、字幕与断句、缓冲与视频速度）中。含有已更改值的区段会自动展开。
3. 打开一个有字幕的 YouTube 视频，点击播放器左上角的 **Dub (xx)**（**Sub** 用来切换屏幕上的翻译字幕）。每次重新加载扩展程序之后，也要刷新 YouTube 标签页。

**Firefox（140 及以上）：** 打开 `about:debugging#/runtime/this-firefox`，点击“临时载入附加组件...”并选择 `extension/manifest.json`。临时附加组件会在 Firefox 退出时移除。两个浏览器使用同一份文件（Chrome 使用 `background.service_worker`，Firefox 使用 `background.scripts`）。主机权限会在安装时询问，可在 `about:addons` 的扩展“权限”中撤销。选项页面在 `about:addons` 的“偏好设置”。 已在 Linux 上的 Firefox 中测试通过。

**Android（Firefox for Android，实验性）：** 也支持 `m.youtube.com`，HUD 按钮和选项页面已调整为适合触控的大小。已在真机（Firefox for Android）上用默认的云端组合测试通过。要试用，请在手机上开启 USB 调试，运行 `npx web-ext run --source-dir extension --target firefox-android --android-device <id>`（id 可用 `adb devices` 查看），或从连接手机的桌面版 Firefox 的 `about:debugging` 载入。Chrome for Android 不支持扩展程序。默认的云端组合（Gemini 与 Google TTS）只要有 API 密钥就能在手机上运行；本地的 LLM、VOICEVOX 或 edge-tts 桥接必须在同一网络的电脑上运行，并把它的局域网地址填入 `llmBaseUrl`、`voicevoxUrl`、`edgeUrl`。浏览器进入后台或屏幕锁定时，声音会停止。iOS 需要另外的 Safari Web Extension，目前尚未支持。

**Udemy（实验性）：** 也支持 `*.udemy.com`。在课程页面的播放器上会出现同样的 **Dub** 按钮。Udemy 自行绘制字幕，不会给视频添加 `<track>` 元素，因此扩展会请求播放器所用的同一个课时 API（需要已登录 Udemy 并已加入该课程），并载入课时中列出的第一个字幕文件（WebVTT）。视频的标准 `<track>` 元素只作为备用。课时没有字幕时，请用 **Load captions** 载入 SRT/VTT 文件。站点专用的代码在 `extension/providers.js` 中；要支持其他站点，只需在那里加一个适配器，并在 `manifest.json` 中加一个 `matches`。

**Vimeo（实验性）：** Vimeo 的所有视频都在 `player.vimeo.com` 框架内播放（vimeo.com 和嵌入它的页面都一样），因此扩展会在该框架内运行，并在播放器上显示同样的 **Dub** 按钮。字幕文件从播放器配置（`/video/<id>/config`）读取，优先使用人工制作的轨道而不是自动生成的轨道，视频的标准 `<track>` 元素作为备用。尚未在真实的 Vimeo 视频上测试。没有字幕的视频需要使用 **Load captions**。限制了可播放域名的嵌入（域名级隐私）可能会拒绝配置请求。

## 示例课程视频

这个扩展程序面向以幻灯片为主的讲课视频。以下四个播放列表和一期播客可以拿来试用：

- Adi Teman 的 [Digital Integrated Circuits (2020-21)](https://www.youtube.com/playlist?list=PLZU5hLL_713yF0Lkwjj9O3ttVIuhPV-me)（Bar-Ilan University 83-313，共 66 个视频）。我们检查过的课程都有手动的英文字幕，是支持最完善的情况。
- Tony Chan Carusone 教授的 [CMOS Analog Integrated Circuit Design Fundamentals](https://www.youtube.com/playlist?list=PLUJOuapA83-QlWbnMJvoyQucGaBlpBF0F)（Microelectronics 频道上 37 个研究生水平的视频）。这些视频只有自动生成的英文字幕，这是测试最少的路径（见下方的“已知限制 / TODO”）。
- Razavi 的 [Beauty of Circuits](https://www.youtube.com/playlist?list=PLvYonHCKSWagKgNwtFKlWmkN7aKeSBPEO)（课程）。我们尚未检查其字幕，请视为未经测试。
- ETH Zürich Onur Mutlu 教授的 [Digital Design and Computer Architecture (Spring 2025)](https://www.youtube.com/playlist?list=PL5Q2soXY2Zi9Eo29LMgKVcaydS7V1zZW3)（直播课程）。我们尚未检查其字幕，请视为未经测试。
- Lex Fridman Podcast 的 [#494 Jensen Huang](https://www.youtube.com/watch?v=vif8NQcjVf0)（没有幻灯片的 2 小时 26 分钟对谈，有英文字幕）。可以用它看看在较长的纯语音视频上的表现，但测试不如上面的课程充分。

有手动字幕的视频效果更好。这些视频不属于本项目，本项目与其作者也没有关联。请尊重作者的权利，未经许可不要重新发布配音后的副本。

## 文件

| 文件 | 用途 |
| --- | --- |
| `extension/manifest.json` | MV3 清单 |
| `extension/defaults.js` | 所有上下文共用的默认设置 |
| `extension/page-hook.js` | MAIN world 脚本；通过播放器 API 获取字幕 JSON |
| `extension/asr.js` | ASR 字幕辅助函数：单词展平、标点窗口、对齐、以句子为单位的 cue |
| `extension/speakers.js` | 对话辅助函数：按换人标记切分字幕，并交替分配声音 |
| `extension/subtitle.js` | 字幕分页辅助函数：把较长的文字分成几行一页 |
| `extension/providers.js` | 站点适配器（YouTube、Udemy、Vimeo）：查找视频与播放器、获取字幕、检测页面切换 |
| `extension/content.js` | cue 的构建、预生成循环、播放调度器、HUD |
| `extension/background.js` | Service worker；与 LLM、VOICEVOX、edge-tts 的 HTTP 桥接 |
| `extension/options.html`, `options.js` | 设置界面 |
| `tools/edge_tts_server.py` | 封装 `edge-tts` 的本地 HTTP 桥接程序 |
| `tests/` | 单元测试（扩展程序使用 Node 内置的测试运行器，桥接程序使用 `unittest`） |
| `.github/workflows/ci.yml` | GitHub Actions CI |

## 开发

```
npm test                                                  # 扩展程序测试（Node 22 及以上，无依赖）
.venv/bin/pip install ruff
.venv/bin/ruff check tools tests                          # 对桥接程序及其测试做 lint
.venv/bin/python -m unittest discover -s tests -p "test_*.py"   # 桥接程序测试
```

每次推送到 `main`，以及每个 pull request，GitHub Actions（`.github/workflows/ci.yml`）都会对所有扩展程序脚本做语法检查，并运行两组测试。

参与贡献与反馈问题的方式，请见 [CONTRIBUTING.md](CONTRIBUTING.md)（英文）。

## 已知限制 / TODO

- 自动生成（ASR）的字幕没有标点。当 `asrPunctuation` 为 `on`（默认）时，LLM 会先把单词序列分成相互重叠的窗口来恢复标点，让 cue 在句子边界结束。这大约每分钟视频需要 1.2 秒（在 16 GB GPU 上用本地 12B 模型实测），期间视频会暂停并显示进度。字幕来自 YouTube 时，结果会按视频保存，之后再开始就不用等。在一个 43 分钟的课程上，74% 的 cue 结束于句尾（没有这一步时，70% 会因长度上限而在句子中途被切断）。模型改动了单词的窗口（该测试中 52 个有 3 个）会退回按长度切分。如需跳过这一步，请把 `asrPunctuation` 设为 `off`。手动字幕仍然效果最好。
- YouTube 可能要求 `timedtext` 端点提供 PO token，导致字幕请求返回空内容。这时请用 **Load captions** 按钮提供 SRT / WebVTT / JSON3 文件，例如用 `yt-dlp --skip-download --write-subs --sub-langs en --convert-subs srt <url>` 生成。请在选项页面设置 `localCaptionLang`（*源*语言的名称，例如 `English`）。切换到其他视频时，加载的文件会被丢弃。滚动式（rolling）的自动字幕 VTT 不会去除重复；这条路径请使用手动字幕。
- 翻译一次处理一个 cue，并以前面 `contextCues` 句的译文作为上下文。支持批量翻译和术语表可改善用词一致性。
- 只会使用符合偏好顺序的第一条字幕轨，没有语言选择界面。
- 比播放位置更早 4 个以上的 cue，其解码后的音频会被释放；向回拖动时会重新合成。
- 测试覆盖设置、清单、service worker、ASR 辅助函数和 edge-tts 桥接程序。content script（cue 构建、调度器、HUD）和 page hook 目前还没有自动化测试，是在浏览器中手动检查。
## 许可证

Copyright 2026 Nexplico-Ltd. 依据 Apache License 2.0 授权，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。这仅适用于本仓库中的代码。它所对接的服务和模型各有自己的条款：VOICEVOX 及其每个声音角色、edge-tts 背后的 Microsoft 在线语音服务，以及你所运行的 LLM（例如 Gemma）。公开配音后的视频之前请先确认。
