# speech-clock-dub

[![CI](https://github.com/Nexplico-Ltd/speech-clock-dub/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Nexplico-Ltd/speech-clock-dub/actions/workflows/ci.yml)

[English](README.md) | **日本語** | [한국어](README.ko.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md)

> これは英語版 [README.md](README.md) の日本語訳です。内容が食い違う場合は英語版が正です。翻訳は更新が遅れることがあります。

YouTube の講義動画向けの吹き替えツール。映像が音声に合わせて動きます。

YouTube の講義動画を、日本語・英語・繁体字中国語・簡体字中国語・韓国語に吹き替える Chrome / Firefox（MV3）拡張機能です。スライドが中心の動画を想定しています。翻訳した音声を映像に合わせて詰め込むのではなく、**映像のほうが音声に合わせて動きます**。

## 仕組み

```
YouTube 字幕 -> 文単位の cue -> LLM 翻訳 -> TTS (VOICEVOX / edge-tts) -> Web Audio キュー
                                                                            |
                              <video> の playbackRate / pause / play  <------+
```

- 合成した音声が主時計です。元の音声はミュートされます。
- 各 cue で、映像の `playbackRate` を `cue の残り時間 / 音声の長さ` に設定します（`[minRate, maxRate]` の範囲に収めます）。
- 音声が cue の映像区間より長い場合、音声が終わるまで映像を一時停止します（スライドが静止します）。音声のほうが短い場合は、次の cue まで映像を速めに進めます。
- cue と cue の間の長い無音は、`gapRate` で通過します。
- 先読みのプロデューサーループが、再生に先行して cue を翻訳・音声合成します。翻訳は順番に実行し（各翻訳は直前までの訳を文脈として受け取ります）、音声合成は最大 `concurrency` 件の cue を並列に実行します。クラウド TTS は 1 リクエストに数秒かかるため、これが効きます。cue の境界で、準備済みの音声が `lowWaterSec` 秒分を下回っていたら映像を一時停止し、`highWaterSec` 秒分が溜まってから再開します（ヒステリシス）。映像が従属側なので、バッファが尽きても同期はずれず、映像が止まるだけです。文の途中で再生が中断されることはありません。
- ユーザーが一時停止・再生すると音声も一時停止・再開します。ユーザーがシークすると、cue の位置を再同期します。広告は検出され（`.ad-showing`）、その間スケジューラは停止します。

## セットアップ

### クイックスタート（既定）: ホスト型サービス

既定の設定は Google のホスト型サービス 2 つを使うので、**ローカルサーバーは不要**です。Google Cloud / AI Studio のアカウントと API キーが 2 つ必要です（両方の API を有効にした同じキーでも構いません）。

1. 翻訳用の **Gemini API キー**。[Google AI Studio](https://aistudio.google.com/apikey) で作成し、オプションページの `llmApiKey` に貼り付けます。既定値（`llmBaseUrl` = `https://generativelanguage.googleapis.com/v1beta/openai`、`llmModel` = `gemini-3.1-flash-lite`）は Gemini の OpenAI 互換エンドポイントを使います。ほかのホスト型 OpenAI 互換サービス（OpenAI、Groq、OpenRouter など）も、`llmBaseUrl`・`llmModel`・`llmApiKey` を設定すれば使えます。そのホストへのアクセスは、Save を押すと Chrome が一度だけ確認します。
2. 音声用の **Google Cloud Text-to-Speech キー**。Google Cloud のプロジェクトで Cloud Text-to-Speech API を有効にして API キーを作り、`googleApiKey` に貼り付けます。`ttsProvider` は最初から `google` です。

既定値は最も安い選択肢です。翻訳は `gemini-3.1-flash-lite`、音声は WaveNet の声を使います（執筆時点で、Google は WaveNet を Standard と同じ価格、Neural2 の 4 分の 1 としており、毎月の無料枠もあります）。価格は変わるので、Google の料金ページで確認してください。音質のよい Neural2 や Chirp 3 HD の声は、`googleVoice` で指定できます。

**どちらのサービスも有料で（無料枠はありますが、料金は Google の案内で確認してください）、字幕のテキストとその翻訳は Google に送信されます。** キーはほかの設定と同様に `chrome.storage.sync` に保存されるので、Google Cloud コンソールで Text-to-Speech のキーをその API だけに制限してください（Gemini のキーも、Google が制限に対応していれば同様に制限してください）。キーが未設定のときは、ステータス行にそのキー名を示すエラーが出ます。この既定の構成は、メンテナーがまだ最初から最後まで動かしていません。最もよく使われてきたのは、下のローカル構成です。

`host_permissions` に入っているのは `localhost` / `127.0.0.1`、`texttospeech.googleapis.com`、`generativelanguage.googleapis.com` だけです。別のホストのサーバーは、実行時に許可します（下の節を参照）。

### 上級者向け: ローカルサーバー（任意）

無料でプライベートに吹き替えるには、自分でサーバーを動かして設定をそちらに向けます。LLM には `llmBaseUrl`・`llmModel`・`llmExtraBody` を、TTS には `ttsProvider` を `auto`（日本語は VOICEVOX、それ以外は edge-tts）、`voicevox`、`edge` のいずれかに設定します。

1. **OpenAI 互換の LLM エンドポイント**（例: Unsloth サービス）で、Gemma 12B クラスのモデルを動かします。`llmBaseUrl`（`/v1` で終わる URL。例: `http://127.0.0.1:8888/v1`）と `llmModel` を設定してください。Gemma 4 では `llmExtraBody` も `{"chat_template_kwargs":{"enable_thinking":false}}` にします。そうしないと 1 行に数分かかることがあります。拡張機能は `POST {llmBaseUrl}/chat/completions` を呼び出します。
2. **VOICEVOX エンジン**（オープンソースで高品質な日本語 TTS）:

   ```
   # GPU（nvidia-container-toolkit が必要）。イメージの既定コマンドがすでに
   # --use_gpu --host 0.0.0.0 を渡しているので、引数を追加しないでください（既定コマンドが置き換わります）。
   docker run -d --rm --name voicevox --gpus all -p 50021:50021 voicevox/voicevox_engine:nvidia-latest
   # CPU のみ
   docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-latest
   ```

   VOICEVOX が必要とする VRAM は 1〜2 GB 程度なので、16 GB の GPU で 12B の LLM と同居できます。

   声のキャラクターごとに利用規約があります。吹き替えた動画を公開する前に確認してください。
   `speakerFemale` / `speakerMale` は VOICEVOX のスタイル ID です（`GET /speakers` で一覧できます）。

   **VRAM:** VOICEVOX は、声を追加するたびに GPU に別のモデルを読み込みます。12B の LLM が 16 GB のカードのほぼ全部を確保していると（たとえばコンテキストウィンドウが非常に大きい場合）、最初の声は動いても、別の声が CUDA のメモリ不足で失敗することがあります（`/synthesis` が HTTP 500）。吹き替えに必要な LLM のコンテキストは数千トークンで足りるので、モデルを読み込むときにコンテキスト長を下げてください。16 GB の RTX 4060 Ti と Gemma 4 12B（Q4）での実測: コンテキスト 262144 トークンでは llama-server が 14.2 GB を使い（空きは約 0.5 GB で、男性の声は失敗）、16384 では 9.5 GB でした（VOICEVOX を読み込んだ状態で空き約 3.9 GB、両方の声が動作）。翻訳も速くなりました（1 文 0.5 秒 -> 0.3 秒）。

   代わりに VOICEVOX を CPU で動かすこともできます（1 文あたり実時間の約 0.5 倍）。イメージのコマンドを上書きして `--use_gpu` を外します: `... voicevox_engine:nvidia-latest gosu user /opt/voicevox_engine/run --host 0.0.0.0`。

3. **edge-tts ブリッジ**（日本語以外をターゲットにする場合。VOICEVOX よりこちらを使いたい場合は日本語でも）。edge-tts は非公式 API 経由で Microsoft のオンライン音声サービスを使うため、**翻訳したテキストが Microsoft に送信されます**。インターネット接続が必要で、サービスの変更で動かなくなる可能性があります。拡張機能からは、小さなローカル HTTP ブリッジを通して使います:

   ```
   python3 -m venv .venv && .venv/bin/pip install edge-tts
   .venv/bin/python tools/edge_tts_server.py        # 127.0.0.1:5050 で待ち受け
   ```

   `--port` でポートを変えられます（その場合は `edgeUrl` も更新してください）。1 文あたり 2〜3 秒かかりますが、バッファが溜まれば並列プロデューサーが隠してくれます。ただし、最初の再生開始までは VOICEVOX より時間がかかります。

   合成が `403 Invalid response status` で失敗する場合は、Microsoft 側のサービスが変わって edge-tts が古くなっています。`.venv/bin/pip install -U edge-tts` を実行してブリッジを再起動してください。

## プロファイル

オプションページの **Profile** 欄で、設定一式を切り替えられます。たとえば、ノート PC ではホスト型、自宅ではローカルサーバー、といった使い分けです。組み込みのプロファイルが最初から入っています（下の一覧）。**Load** で選んだプロファイルをフォームに読み込み、**Save** で適用します。プロファイルは API キー以外のすべての設定を決めます。載っていない設定は既定値に戻るので、Load したあと、言語や声を確認してから Save してください。**Save as profile** は、入力した名前で現在のフォームを保存し（API キー以外のすべての設定を保存するので、あとで既定値が変わってもプロファイルの意味は変わりません）、**Delete** は自分で作ったプロファイルを削除します。**Export file** / **Import file** で、プロファイルを JSON ファイルとして別のブラウザに移せます。API キーはプロファイルに含まれません。すべてのプロファイルで共通で、書き出しにも読み込みにも含まれません。プロファイルは `chrome.storage.sync` に、1 つにつき 1 項目で保存されます。

組み込みのプロファイル:

| プロファイル | 翻訳 | 音声 |
| --- | --- | --- |
| `Hosted (Gemini + Google TTS)` | Gemini（ホスト型） | Google Cloud TTS（既定） |
| `Local (Unsloth + VOICEVOX / edge-tts)` | ローカルの Unsloth サーバー | 日本語は VOICEVOX、それ以外は edge-tts |
| `Gemini + edge-tts (free voice)` | Gemini（ホスト型） | edge-tts ブリッジ（Google TTS の料金なし） |
| `Local LLM + Google TTS` | ローカルの Unsloth サーバー | Google Cloud TTS |
| `Interview / podcast (two voices)` | Gemini（ホスト型） | Google Cloud TTS。話者が替わるたびに声が切り替わります（`speakerVoices` = `alternate`） |

## 別のマシンのサーバーを使う

LLM、VOICEVOX、edge-tts ブリッジは、ローカルネットワーク上の GPU マシンなど、別のコンピューターで動かせます。そのマシンで、サーバーがネットワークから届くように起動し、ファイアウォールでポートを許可します（LAN の中だけにしてください）。VOICEVOX は `--host 0.0.0.0`、ブリッジは `tools/edge_tts_server.py --host 0.0.0.0`、LLM サーバーはそれぞれのホスト指定オプションを使います。そのうえで、オプションページの `llmBaseUrl`、`voicevoxUrl`、`edgeUrl` に `http://192.168.1.20:8888/v1` のような URL を入力します。保存を押すと、Chrome がホストごとに一度だけ、拡張機能がそこへ接続してよいかを尋ねます（`optional_host_permissions`）。通信は平文の HTTP で、ブリッジと VOICEVOX には認証がないため、信頼できるネットワークでだけ使ってください。

### HTTPS

サーバー自体は平文の HTTP しか話しません（VOICEVOX には TLS のオプションがありません）。拡張機能は `https://` の URL を受け付けるので、別のマシンのサーバーの前に TLS を終端するリバースプロキシを置き、そのプロキシの URL を入力します（例: `voicevoxUrl` = `https://voicevox.lan:50443`）。[Caddy](https://caddyserver.com/) なら、自前のローカル CA で証明書を作ってくれるので、`Caddyfile` はこれだけで済みます:

```
voicevox.lan:50443 {
    reverse_proxy 127.0.0.1:50021
}
```

拡張機能を動かす側の Chrome が、その証明書を信頼している必要があります（Caddy の場合は、ルート証明書を一度インストールします）。信頼されていないと、リクエストは失敗します。Tailscale を使っているなら、`tailscale serve --https=50443 http://127.0.0.1:50021` で、tailnet 上のマシン名に対して正規に信頼される証明書が使え、信頼の設定は不要です。edge-tts ブリッジや LLM サーバーでも同じ方法が使えます。これらのプロキシ構成は、この拡張機能では試していません。

## ターゲット言語

オプションページで `targetLang` を設定します:

| `targetLang` | 言語 | edge-tts の既定の声（女性） |
| --- | --- | --- |
| `ja` | 日本語 | `ja-JP-NanamiNeural`（既定では VOICEVOX を使用） |
| `en` | 英語 | `en-US-AriaNeural` |
| `zh-TW` | 繁体字中国語（台湾） | `zh-TW-HsiaoChenNeural` |
| `zh-CN` | 簡体字中国語 | `zh-CN-XiaoxiaoNeural` |
| `ko` | 韓国語 | `ko-KR-SunHiNeural` |

`translationLevel` は訳文の難しさを決めます: `standard`（既定）、`easy`（学習者向けのやさしい語と短い文。日本語では JLPT N5〜N3 程度）、`advanced`（より正確でかたい表現。日本語では JLPT N3〜N1 程度）。意味と専門用語は変わりません。翻訳プロンプトに規則を1行足すだけなので、どこまで守られるかはモデルしだいです。

`voiceGender`（`female` または `male`）で声を選びます:

| `targetLang` | female | male |
| --- | --- | --- |
| `ja`（VOICEVOX） | スタイル `2`（四国めたん） | スタイル `11`（玄野武宏） |
| `ja`（edge-tts） | `ja-JP-NanamiNeural` | `ja-JP-KeitaNeural` |
| `en` | `en-US-AriaNeural` | `en-US-GuyNeural` |
| `zh-TW` | `zh-TW-HsiaoChenNeural` | `zh-TW-YunJheNeural` |
| `zh-CN` | `zh-CN-XiaoxiaoNeural` | `zh-CN-YunxiNeural` |
| `ko` | `ko-KR-SunHiNeural` | `ko-KR-InJoonNeural` |

`ttsProvider` の既定は `google`（Google Cloud Text-to-Speech）です。`auto` は `ja` に VOICEVOX、それ以外に edge-tts を使います。`google` にすると Google Cloud Text-to-Speech を使います（既定の声: `ja-JP-Wavenet-B/C`、`en-US-Wavenet-F/D`、`cmn-TW-Wavenet-A/B`、`cmn-CN-Wavenet-A/B`、`ko-KR-Wavenet-A/C`。`googleVoice` で声を、`googleSpeed` で話速を変えられます）。`edgeVoice` で edge-tts の声を上書きでき（`.venv/bin/edge-tts --list-voices` で一覧できます）、`edgeRate`（例: `+10%`）で速度を変えられます。言語を追加するには、`extension/defaults.js` の `YTD_LANGS` にエントリを追加します。

`speakerVoices`（既定は `off`）は、インタビューやポッドキャストのような対話向けです。手動字幕の多くは、話者の交代を行頭の `- ` や `>>` で示しています。`alternate` にすると、この印を本文から取り除き、話者が替わるたびに声を切り替えます。最初の話者には `voiceGender` の声、もう一人には反対の性別の声を使います。印には名前がないため、対応できるのは 2 人までです。また、自動生成字幕には通常この印がありません。

`voice1Provider` / `voice1Voice` と `voice2Provider` / `voice2Voice` で、1 人目と 2 人目の話者のプロバイダと声を個別に指定できます。`voice1*` は全キューに効き（話者が 1 人の動画の声も決まります）、`voice2*` は対話（`speakerVoices` が `alternate` または `llm`）の 2 人目にだけ使われます。この 2 つで、プロバイダを混ぜたり、同じ性別の声を 2 つ使ったりできます。たとえば 1 人目は VOICEVOX のスタイル `8`、2 人目は Google の `ja-JP-Neural2-B` といった指定です。声は、プロバイダに合わせて VOICEVOX のスタイル ID、edge-tts の声名、Google の声名のいずれかを指定します。空欄なら従来どおり（`ttsProvider` を使い、2 人目は `voiceGender` と反対の性別）です。

印のない字幕向けに、実験的な `llm` モードもあります。翻訳に使う LLM が、15 cue ごとにテキストだけを見て、どの行が司会者（`voiceGender` の声）で、どの行がゲスト（反対の性別の声）かを判定します。プロンプトはインタビューを想定しており、15 cue あたり約 1 回のリクエストが増えます。自動生成字幕でも使えます。印を取り除いた Lex Fridman #494 の字幕での事前テスト（Gemma 4 12B、300 文 × 3 区間）では、話者交代の 70〜80% を同程度の適合率で検出できました。交代を見逃すと、しばらく声の役割が入れ替わることがあり、リクエストが失敗した場合は直前の声のままになります。最初の 30 cue がほぼ 1 人の話者と判定された場合（講義など）は、独白とみなして 1 つの声のままにします。話者を確実に識別するものではなく、おおまかな補助として使ってください。

## 画面上の字幕

プレイヤーの **Sub** ボタンで、`off` -> `translated` -> `both`（訳＋原文）と切り替わります。選択は `subtitles` 設定（既定は `off`）に保存されます。いま喋っている cue のテキストがプレイヤー下部に表示され、cue の間は非表示になります。ユーザーが一時停止している間は表示されたままです。フォントはプレイヤーの幅に合わせて拡縮するので、全画面でも使えます。YouTube 自身の字幕行より上に表示されるため、YouTube の字幕がオンでも重なりません。 長い文は、最大 `subtitleMaxLines` 行（既定 2、`0` で無制限）のページに分けて表示され、ページは音声の進みに合わせて切り替わります。そのため、字幕が映像を大きく隠すことはありません。`both` では、訳と原文をそれぞれ別に制限します。

## インストール（開発用）

1. Chrome: `chrome://extensions` を開き、デベロッパー モードを有効にして「パッケージ化されていない拡張機能を読み込む」を押し、`extension/` を選びます。
2. 拡張機能のオプションページを開き、設定を調整します。よく使う設定（言語、声の性別、字幕、TTS プロバイダー、API キー）は上部にあり、残りは折りたたみセクション（声の詳細、サーバーとモデル、字幕と文の分割、バッファと動画速度）に入っています。変更した値を含むセクションは自動で開きます。
3. 字幕付きの YouTube 動画を開き、プレイヤー左上の **Dub (xx)** を押します（**Sub** で画面上の翻訳表示を切り替えます）。拡張機能を再読み込みしたら、YouTube のタブも毎回再読み込みしてください。

**Firefox（140 以降）:** `about:debugging#/runtime/this-firefox` を開き、「一時的なアドオンを読み込む...」から `extension/manifest.json` を選びます。一時的なアドオンは Firefox を終了すると削除されます。同じファイルが両方のブラウザーで動きます（Chrome は `background.service_worker`、Firefox は `background.scripts` を使います）。ホスト権限はインストール時に確認され、`about:addons` の拡張機能の「権限」で取り消せます。オプションページは `about:addons` の「設定」から開きます。 Linux 上の Firefox で動作を確認しています。

**Android（Firefox for Android、実験的）:** `m.youtube.com` にも対応し、HUD のボタンとオプションページはタッチ向けの大きさです。実機（Firefox for Android）で、ホスト型の既定構成を使って動作を確認しています。試すには、スマホで USB デバッグを有効にして `npx web-ext run --source-dir extension --target firefox-android --android-device <id>` を実行します（id は `adb devices` で分かります）。スマホにつないだデスクトップ版 Firefox の `about:debugging` から読み込むこともできます。Chrome for Android は拡張機能に対応していません。既定のホスト型（Gemini と Google TTS）は API キーだけでスマホ上で動きます。ローカルの LLM、VOICEVOX、edge-tts ブリッジは同じネットワーク上の PC で動かし、`llmBaseUrl`、`voicevoxUrl`、`edgeUrl` にその LAN アドレスを入れます。ブラウザーがバックグラウンドに回るか画面がロックされると音声は止まります。iOS には別に Safari Web Extension が必要で、まだ対応していません。

**Udemy（実験的）:** `*.udemy.com` にも対応します。講義ページのプレーヤーに同じ **Dub** ボタンが出ます。Udemy は字幕を独自に描画し、動画に `<track>` 要素を付けないため、プレーヤーが使うのと同じ講義 API に問い合わせ（Udemy にログインし、そのコースを受講している必要があります）、講義に載っている最初の字幕ファイル（WebVTT）を読み込みます。動画の標準の `<track>` 要素はフォールバックとしてだけ使います。講義に字幕がない場合は **Load captions** で SRT/VTT ファイルを読み込んでください。サイト別のコードは `extension/providers.js` にあり、別のサイトに対応するには、そこにアダプターを 1 つ足し、`manifest.json` の `matches` を 1 つ足します。

**Vimeo（実験的）:** Vimeo はすべての動画を `player.vimeo.com` のフレーム内で再生する（vimeo.com でも埋め込み先でも同じ）ため、拡張機能はそのフレーム内で動き、プレーヤーに同じ **Dub** ボタンを出します。字幕ファイルはプレーヤーの設定（`/video/<id>/config`）から読み、自動生成よりも人が作ったトラックを優先します。動画の標準の `<track>` 要素はフォールバックです。実際の Vimeo 動画ではまだ試していません。字幕のない動画では **Load captions** が必要です。再生できるドメインを制限した埋め込み（ドメインレベルのプライバシー）では、設定の取得が拒否されることがあります。

## 試せる講義の例

この拡張機能は、スライド中心の講義向けです。試せる再生リストを 4 つと、ポッドキャストを 1 本挙げます。

- Adi Teman 氏の [Digital Integrated Circuits (2020-21)](https://www.youtube.com/playlist?list=PLZU5hLL_713yF0Lkwjj9O3ttVIuhPV-me)（Bar-Ilan University 83-313、66 本）。確認した講義には手動の英語字幕があり、もっとも対応が進んでいるケースです。
- Tony Chan Carusone 教授の [CMOS Analog Integrated Circuit Design Fundamentals](https://www.youtube.com/playlist?list=PLUJOuapA83-QlWbnMJvoyQucGaBlpBF0F)（Microelectronics チャンネルの大学院レベルの動画 37 本）。これらの動画には自動生成の英語字幕しかなく、最もテストが少ない経路です（下の「既知の制限 / TODO」を参照）。
- Razavi 氏の [Beauty of Circuits](https://www.youtube.com/playlist?list=PLvYonHCKSWagKgNwtFKlWmkN7aKeSBPEO)（講義）。字幕はまだ確認しておらず、未テストです。
- ETH Zürich の Onur Mutlu 教授の [Digital Design and Computer Architecture (Spring 2025)](https://www.youtube.com/playlist?list=PL5Q2soXY2Zi9Eo29LMgKVcaydS7V1zZW3)（ライブ配信の講義）。字幕はまだ確認しておらず、未テストです。
- Lex Fridman Podcast の [#494 Jensen Huang](https://www.youtube.com/watch?v=vif8NQcjVf0)（スライドのない 2 時間 26 分の対談、英語字幕あり）。長い音声中心の動画での動作を見られますが、上の講義ほどテストしていません。

手動字幕のある動画のほうが、うまく動きます。これらの動画はこのプロジェクトの一部ではなく、制作者とも無関係です。制作者の権利を尊重し、許可なく吹き替えたコピーを再公開しないでください。

## ファイル

| ファイル | 役割 |
| --- | --- |
| `extension/manifest.json` | MV3 マニフェスト |
| `extension/defaults.js` | すべてのコンテキストで共有する既定設定 |
| `extension/page-hook.js` | MAIN ワールドのスクリプト。プレイヤー API 経由で字幕 JSON を取得 |
| `extension/asr.js` | ASR 字幕のヘルパー。単語の平坦化、句読点の窓、突き合わせ、文単位の cue |
| `extension/speakers.js` | 対話用ヘルパー。話者交代の印で字幕を区切り、声を交互に割り当てる |
| `extension/subtitle.js` | 字幕のページ分割ヘルパー。長い文を数行ずつのページに分ける |
| `extension/providers.js` | サイト別アダプター（YouTube、Udemy、Vimeo）。動画とプレーヤーの検出、字幕の取得、ページ遷移の検知 |
| `extension/content.js` | cue の生成、先読みループ、再生スケジューラ、HUD |
| `extension/background.js` | サービスワーカー。LLM・VOICEVOX・edge-tts との HTTP ブリッジ |
| `extension/options.html`, `options.js` | 設定 UI |
| `tools/edge_tts_server.py` | `edge-tts` を包むローカル HTTP ブリッジ |
| `tests/` | ユニットテスト（拡張機能は Node 標準のテストランナー、ブリッジは `unittest`） |
| `.github/workflows/ci.yml` | GitHub Actions の CI |

## 開発

```
npm test                                                  # 拡張機能のテスト（Node 22 以上、依存なし）
.venv/bin/pip install ruff
.venv/bin/ruff check tools tests                          # ブリッジとそのテストを lint
.venv/bin/python -m unittest discover -s tests -p "test_*.py"   # ブリッジのテスト
```

GitHub Actions（`.github/workflows/ci.yml`）が、`main` への push と、すべてのプルリクエストで、拡張機能の全スクリプトの構文チェックと、2 つのテストスイートを実行します。

貢献の方法と Issue の報告の仕方は、[CONTRIBUTING.md](CONTRIBUTING.md)（英語）を参照してください。

## 既知の制限 / TODO

- 自動生成（ASR）字幕には句読点がありません。`asrPunctuation` が `on`（既定）のとき、LLM が単語列を重なりのある窓に分けて先に句読点を復元し、cue が文の境界で終わるようにします。動画 1 分あたり約 1.2 秒かかり（16 GB の GPU 上のローカル 12B モデルでの実測）、その間は映像を一時停止して進捗を表示します。字幕が YouTube から来る場合、結果は動画ごとに保存されるので、2 回目以降は待ちません。43 分の講義では、文末で終わる cue が 74% になりました（この手順がないと、70% が長さの上限で文の途中で切られていました）。モデルが単語を変えてしまった窓（このテストでは 52 窓中 3 窓）は、長さで区切る方式に戻ります。この手順を省くには `asrPunctuation` を `off` にします。手動字幕がもっとも確実です。
- YouTube が `timedtext` エンドポイントに PO トークンを要求し、字幕の取得が空の応答になることがあります。その場合は **Load captions** ボタンで SRT / WebVTT / JSON3 ファイルを渡してください。たとえば `yt-dlp --skip-download --write-subs --sub-langs en --convert-subs srt <url>` で作れます。オプションページで `localCaptionLang`（`English` などの*元の*言語名）を設定してください。読み込んだファイルは、別の動画に移動すると破棄されます。ローリング形式の自動字幕 VTT は重複を除去しないので、この経路では手動字幕を使ってください。
- 翻訳は 1 cue ずつで、直前の `contextCues` 件の訳を文脈として渡します。まとめて翻訳する方式や用語集に対応すると、用語の一貫性が良くなります。
- 優先順位に合った最初の字幕トラックだけを使います。言語を選ぶ UI はありません。
- 再生位置より 4 つ以上前の cue のデコード済み音声は解放されます。後ろへシークすると再合成されます。
- テストが対象とするのは、設定、マニフェスト、サービスワーカー、ASR ヘルパー、edge-tts ブリッジです。content script（cue の生成、スケジューラ、HUD）と page hook には、まだ自動テストがありません。ブラウザで手動確認しています。
## ライセンス

Copyright 2026 Nexplico-Ltd. Apache License 2.0 の下で提供されます。[LICENSE](LICENSE) と [NOTICE](NOTICE) を参照してください。これはこのリポジトリのコードにだけ適用されます。連携するサービスやモデルには、それぞれ別の利用規約があります。VOICEVOX と各声のキャラクター、edge-tts の裏にある Microsoft のオンライン音声サービス、実行する LLM（たとえば Gemma）です。吹き替えた動画を公開する前に確認してください。
