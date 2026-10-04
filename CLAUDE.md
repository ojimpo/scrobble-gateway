# scrobble-gateway

## 概要

Last.fm データの唯一の窓口になる独立サービス。Last.fm API キー・scrobble のマスター DB・全履歴バックフィル・差分取り込み・期間別集計をここだけが持つ。
`Last.fm API → scrobble-gateway → health-ojimpo / Last.fm MCP / Cosense 同期` の向きで、health-ojimpo と MCP はどちらも**利用者**。

## なぜ独立させたか（設計判断）

- health-ojimpo は「各 API を叩く側」として作ってきた。ここで「叩かれる API」にしたくない（2026-09-17 の本人方針）
- API キーとマスター DB を各1つに絞る。移行後の health-ojimpo は日次の再生時間など派生値だけを持ち、完全な scrobble 履歴は重複保持しない
- MCP は ChatGPT / Claude / 本人が任意の時点で履歴を探索するための必須インターフェース（Scheduled Task 用の補助ではない）

## 状態

**2026-10-05: arigato-nas の 4104 番で稼働中。`/mcp` は OAuth 必須。** 全履歴 95,105件を Last.fm から取得済みで、health.db と1件残らず一致。毎時の差分同期が動いている。
公開ホスト名は `scrobble-gateway.ojimpo.com`（DNS の CNAME は作成済み。Tunnel の ingress 追記は sudo が要るので本人作業）。
health-ojimpo はまだ旧取り込みのまま（内部 REST 未実装）。GitHub は `ojimpo/scrobble-gateway`（private）。
仕様・判断履歴の正本は Cosense `Last.fm MCP・音楽レコメンド基盤 NAS調査引継ぎ`。経過は DEVLOG.md。

## 土台: sptmru/lastfm-mcp（MIT）を履歴ごと取り込んでいる

- 既存 MCP 6候補を比較して採用（比較表は Cosense）。1人分の scrobble を自前 SQLite に持って MCP は DB を読む、という構成がこのプロジェクトとほぼ同じだったため
- `upstream` リモートに上流がある。上流の修正は `git fetch upstream && git merge upstream/main` で取り込む。**上流に無い変更は、上流と衝突しにくいよう小さく保つ**
- 上流から変えた点（2026-10-04）
  - 差分同期を直近 72 時間遡る（`HISTORY_INCREMENTAL_LOOKBACK_HOURS`）。上流は最新 scrobble の秒から取るので後着分を落とす
  - 起動時と毎時の自動同期（`src/history-sync-scheduler.ts`）。上流はツールか CLI で手動同期する作り
  - 名寄せ表の MBID インデックスと、名寄せを同期直後に回す変更（下の落とし穴）
- MCP SDK は v2 系（`@modelcontextprotocol/server`）。health-mcp ほか既存の自作 MCP（v1 系 `@modelcontextprotocol/sdk`）とは別物。トランスポートは Streamable HTTP のみで stdio は無い

## 認証（OAuth 2.1）

- **リモート公開の認証は OAuth 一択。** ChatGPT のコネクタは OAuth しか受けず、claude.ai のカスタムコネクタは固定の Bearer トークンを送れない（2026-10-05 の判断。cosense-mcp と同じ結論）
- 実装は `src/auth/`。**cosense-mcp の認可サーバーを1人用に絞って移植したもの**。利用者ディレクトリ・招待・SID の暗号化保存は持ってきていない。パスフレーズ1つで認可する
- **SDK v2 にはトークン検証側（`requireBearerAuth`）しか無く、認可サーバー（DCR / `/authorize` / `/token`）が無い。** そこだけ SDK v1（`@modelcontextprotocol/sdk`）の `mcpAuthRouter` を使っている。MCP 本体は v2 のまま
- 設定は `.env` の `MCP_PUBLIC_URL` と `MCP_OAUTH_PASSPHRASE`（**両方そろって初めて有効、片方だけなら起動を拒否**）。パスフレーズは `grep MCP_OAUTH_PASSPHRASE ~/dev/scrobble-gateway/.env` で見る
- **認証の設定が無いと HTTP の起動自体を拒否する**（`MCP_ALLOW_UNAUTHENTICATED=true` で明示的に外せる）。cosense-mcp で「設定は書いてあるのに認証が載っていない」まま公開していた事故の再発防止
- クライアント登録とトークンのハッシュは `./data/oauth-store.json`。消すと全クライアントが再認可になる
- `/healthz` は認証なしで開いている（件数・最新時刻・ユーザー名が見える）
- cosense-mcp から引き継いだ罠（コメントにも書いてある）
  - AS メタデータに `authorization_response_iss_parameter_supported` を足す。無いと ChatGPT がコールバックごとに別のリダイレクト URI を使う。上書きのルーターは `mcpAuthRouter` より**先に**載せる
  - リダイレクトの `iss` は `issuerUrl.href`（末尾スラッシュ付き）と完全一致させる。ずれると ChatGPT が承認後に黙ってやり直す
  - 同意画面の CSP の `form-action` にリダイレクト先のオリジンを入れる。無いと承認ボタンが無反応に見える（ブラウザでしか再現しない）
  - リクエストログは OAuth ルーターより先に載せる。後ろだと `/authorize` などがログに残らない
- Tunnel 越しのパスフレーズ試行の回数制限は接続元 IP で数えるので `MCP_TRUST_PROXY=1`

### Cloudflare Tunnel への追加（sudo、本人作業）

```bash
sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak.$(date +%Y%m%d-%H%M%S)
sudo sed -i '/service: http:\/\/localhost:4102/a\  - hostname: scrobble-gateway.ojimpo.com\n    service: http://localhost:4104' /etc/cloudflared/config.yml
cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://scrobble-gateway.ojimpo.com/mcp   # → localhost:4104 なら OK
sudo systemctl restart cloudflared
```

- DNS（CNAME）は `cloudflared tunnel route dns <tunnel-id> scrobble-gateway.ojimpo.com` で作成済み（`~/.cloudflared/cert.pem` があるので sudo 不要）
- **`cloudflared tunnel ingress rule` は `--config` を `tunnel` の直後に置く。** `ingress rule ... --config` の順だと設定が読まれず、既定のルールで照合されて 404 に見える

## コマンド

- テスト: `npm test`（vitest）。型チェック: `npm run typecheck`。Node 22.5+ が要る（`node:sqlite`）
- 起動（本番）: `~/dev/scrobble-gateway` で `docker compose up -d --build`。**worktree からは起動しない**（`./data` が worktree 側にできる）
- 状態確認: `curl -s http://127.0.0.1:4104/healthz`（索引の件数・最新時刻・自動同期の結果）
- 手動同期: `docker compose exec scrobble-gateway node dist/src/sync.js incremental`
- DB: `./data/lastfm.sqlite`（bind mount）。テーブルは `scrobbles`。照合はホストから読み取り専用で開く

## 移行順序

1. health.db バックアップ → 件数照合（2026-10-04 済み）
2. ~~既存件数をコピー → バックフィル~~ → **Last.fm から全件を直接取得した**（2026-10-04 済み。health.db からのコピーはやめた。Last.fm が正本で、取得は7分で終わるため）
3. 非公開のまま集計を既存 DB と照合（件数は 2026-10-04 に一致を確認済み。日次再生時間の照合は内部 REST を作ってから）
4. health-ojimpo を内部 REST 利用へ変更
5. 旧取り込み停止と新取り込み開始を**同一切替**で行う（二重取り込みを作らない）
6. stdio / Tailscale 内で MCP 検証 → 4104 番と Cloudflare Tunnel（sudo、config.yml のバックアップ必須）
7. claude.ai / ChatGPT から実際に呼ぶ

旧資産（health-ojimpo 内の Last.fm 取り込み・spotify-liked-delta・scrobble-sqlite-archive）は、移行完了とロールバック期間終了まで消さない。

## 運用メモ

- ポートは 4104（4100〜4103 は既存 MCP / cosense-mcp 管理画面）
- 足場は health-mcp ではなく sptmru/lastfm-mcp（上の「土台」）
- **Docker の既定アドレスプールが枯渇していて、新しいネットワークを作れない**（`all predefined address pools have been fully subnetted`）。compose は `health-ojimpo_default` に相乗りしている（health-mcp と同じ）。health-ojimpo の backend からは `http://scrobble-gateway:3000`
- **`MCP_ALLOWED_HOSTS` は Host ヘッダの検証**。Tailscale や公開ホスト名で叩くときはここに足す。足さないと弾かれる
- 自作アプリなので Watchtower のラベルは付けない（既存運用に合わせる）
- Bash ツールの PATH に node が無い。nvm の絶対パスを使うか Docker に入れる
- Last.fm の API キーを URL に含めてログへ出さない（health-ojimpo の httpx は INFO で URL 全体を出していた）。2026-10-04 時点のコンテナログにキーは出ていない（確認済み）

## 落とし穴

- **名寄せ（`ensureCanonicalIndex`）は同期 API の SQLite で走るので、走っている間はイベントループごと止まる。** `/healthz` も返らない
  - 上流は MBID 列にインデックスが無く、95,105件の初回索引が1秒67件しか進まなかった（25分超）。インデックスを張って22秒になった
  - 名寄せは最初の分析ツール呼び出しで走る作りだったので、自動同期の直後に回すようにした。それでも**大量取り込み直後の最初の1回は数十秒止まる**
  - 「ツールが返らない」「CPU 100%」を見たら、まずこれを疑う。`scrobbles.canonical_artist_key IS NULL` の件数で進み具合が分かる
- **Last.fm の `user.getRecentTracks` は、全ページ取得するとページの境目で同じブロックを2回返す**（2026-10-04 に約25件）。総数（`total`）もその分ふくらむ。主キーで吸収されるので DB は正しいが、**件数の検証は `from`/`to` で区切った窓の `total` で行う**

## MCP ツール

上流の約30ツールがそのまま出ている（一覧は README）。当初の要件との差:

- **上流の期間比較（`compare_listening_periods`）と期間別トップ（`get_top_*`）は Last.fm の固定期間（7day / 1month / 12month など）しか受けず、しかも Last.fm API をその場で叩く**。任意の from/to 用に `get_top_in_range` / `compare_ranges` を足した（`src/range-analytics.ts`、`src/register-range-tools.ts`）。上流のツールの意味は変えていない
- 日付の `YYYY-MM-DD` は**UTC の1日**として解釈される（上流の `parseDateTime`）。日本時間の日で区切るなら `+09:00` 付きの ISO 8601 を渡す。ツールの説明文にも書いてある
- **名寄せは日本語表記と英語表記をまとめない**（エイプリルブルー / AprilBlue、宇多田ヒカル / Hikaru Utada）。MBID が無いと別アーティストとして数えられる。未対応
- Spotify Liked との重なりは、Spotify 連携（未設定）を有効にすれば `compare_spotify_lastfm_library` がある
- Last.fm 側の Loved は使っていない（Like は Spotify が正本）

## 後回しにしたもの

Spotify Like → Last.fm Love の同期。**上流に実装はある**（`sync_spotify_likes_to_lastfm` と自動同期）が、上流はライブラリ全体を突き合わせる方式で、ここで決めた増分方式とは違う。**`SPOTIFY_AUTO_SYNC_ENABLED` は、Spotify の認証情報を入れた時点で既定 true になる**ので、入れるなら先に false にする。以下は当初の方針:
「これから再生する曲のうち Spotify で Like 済みのものだけ、直近数日分の scrobble を毎時見直して `track.love`」という増分方式にする。書き込み認証（セッションキー）が新規で必要なので、基盤が回り始めてから足す。Like を外した場合は同期しない（一方向）。
