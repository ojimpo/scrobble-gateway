# scrobble-gateway 進捗ログ

意思決定を日付つきで積む（新しい日付が上、追記のみ）。確度: `[確]` = 実測、無印 = 判断。

## 2026-10-04

- **22:58 既存 Last.fm MCP の比較表を Cosense に追記** — 「ChatGPT DeepResearchも併用する？」「とりあえず依頼文だけここに出してよ」
  - Deep Research の結果を下敷きにして、GitHub API でソースを直接確認した。比較表の正本は Cosense `Last.fm MCP・音楽レコメンド基盤 NAS調査引継ぎ` の「既存Last.fm MCPの比較」節
  - **最有力は sptmru/lastfm-mcp（改変して流用）。** [確] TypeScript・MIT、自前 SQLite（`node:sqlite`）に全履歴を持ち、差分同期・集計・MCP をまとめた構成で、scrobble-gateway とほぼ同じ形。テスト17本、Dockerfile・compose あり。Spotify Like→Last.fm Love 同期も実装済み（既定は dry-run）
  - [確] **sptmru も差分同期の起点が「最新scrobbleの時刻」なので、今日 health-ojimpo で直したのと同じ後着 scrobble の取りこぼしを抱えている。** 流用するならまずここを直す
  - [確] sptmru は MCP SDK v2 系（`@modelcontextprotocol/server`）。health-mcp の足場は v1 系なので、「足場は health-mcp を流用」の前提と食い違う
  - rianvdm（49スター、Cloudflare Workers・OAuth 前提）、ndyakov（Go）、kud（stdio のみ）は設計だけ参考。dkfancska・ScrobblerContext は不採用
  - **Deep Research の結果はそのまま使えなかった。** [確] rianvdm のスター数（「ほぼ0」→ 実際は49）、kud のテスト有無（「無し」→ 実際はあり）、lastfm-ts-api を「公式」とした点が誤り。sptmru の流用範囲も過小評価していた。README を読んだだけの記述が多く、現物での裏取りは必須
  - 未確定（本人判断）: A = sptmru をベースに足す / B = health-mcp の足場で自作して sptmru から移植する
  - 罠: 調査用のバックグラウンドエージェントが 21:49 を最後に、完了通知も無いまま消えていた。呼んだツールは全部結果を返していて、どこかで詰まった形跡も無い。**完了通知が来ないときは、subagents/ の jsonl の最終時刻を見て生死を確かめる**

- **22:30 health-ojimpo 側の取りこぼしをその場で修正** — 「今直そう」「やっていいよ　全部」
  - 移行を待たずに旧取り込みを直した。移行完了まで health-ojimpo が scrobble の正本なので、抜けたまま新基盤へコピーすると照合がずっとずれる
  - 修正は「差分取得を直近72時間遡る」（health-ojimpo `1aa7da0` / テスト `58b1deb` / CLAUDE.md `a6ee26e`、push 済み）。22:19 の毎時 ingest 完了を待って backend を差し替え、事前に `data/health.db.bak-20261004-lookback` を取った
  - 3/9 以降を手動トリガー（`POST /api/ingest/trigger`、from_date=2026-03-09）で一度だけ取り直した。[確] 17,178件取得、95,098 → 95,110件
  - [確] 取り直し後に 2026-03 以降を日単位で再照合。**Last.fm にあってローカルに無いものは 0 件**。残る差はローカル側の大小文字違いの重複 5 件（Rosa Walton）だけ
  - 踏んだ罠: `docker compose exec backend python -c "run_ingest_pipeline(...)"` は `Unknown source: lastfm` で何もしない。アダプタはアプリ起動時に登録されるので、別プロセスからは見えない。手動取り込みは HTTP の trigger を使う

- **22:08 Last.fm 全履歴と health.db の照合（読み取りのみ）** — lab-7b からの引き継ぎ「登録日・総 scrobble 数と health.db を照合し、2021-01-24 以前のバックフィル要否を判断材料として出す」
  - [確] user.getInfo: playcount 95,129（照合中に 95,130 へ増加）、登録 2021-01-24 23:03:22 UTC。health.db は 95,097件、最古 2021-01-24 11:34:33 UTC
  - **2021-01-24 より前のバックフィルは不要。** [確] Last.fm 側も 2021 年より前は 0 件
  - 登録時刻より約11時間前の scrobble が**ちょうど50件**ある。[確] Last.fm 側も登録前は 50 件で一致。50 は Spotify recently-played の上限なので、Spotify 連携時の遡り取り込みと読める（推測）
  - **件数差 32 は「毎時 ingest の未反映」ではなかった。** [確] Last.fm の全 scrobble がローカル最新時刻以前に収まっている
  - 月単位 → 日単位の窓（`from`/`to` 付き `total`）で突き合わせた。[確] 2026-02 以前は全月一致。差があるのは次の3種類だけ
    1. **ローカルに無い 13件**（2026-03-09 1件、2026-09-18 以降 12件。照合中に1件増えた）。[確] 抜けた曲はすべて `spotify_play_history` にあり、Spotify 経由の scrobble。**Last.fm に遅れて・順不同で届いた scrobble を、`from=last_timestamp` の差分取得が飛び越えている**のが原因と読める。9/17 の last_timestamp 修正までは毎回 3/9 以降を取り直していたので表面化しなかった（3/9 の1件は当時の固定起点 14:42 UTC より前で、同じ仕組み）
    2. **ローカルにだけある 5件**。Rosa Walton「I REALLY WANT TO STAY AT YOUR HOUSE」。Last.fm 側で曲名の大小文字が直され、`UNIQUE(artist, track, scrobbled_at)` が大小文字を区別するため旧表記と新表記の2行になっている
    3. **Last.fm の総数そのものが窓の合計より約25件多い。** [確] 全ページ取得すると 2025-09-28 と 2025-03-25 付近のブロックが重複して返る（計26行）。同じ時間帯を狭い窓で取ると重複は無く、件数もローカルと一致する。Last.fm 側のページングの重複であってデータの欠落ではない
  - **新基盤の取り込みに効く教訓**
    - 差分取得は `from=last_timestamp` ちょうどにしない。直近数日を毎回取り直して `INSERT OR IGNORE` する（Like→Love 同期と同じ「直近数日の見直し」）
    - 全件取得は `user.getRecentTracks` のページングで重複が出る。件数の検証はページ総数ではなく `from`/`to` 窓の `total` で行う
    - 重複排除キーは大小文字の表記揺れを考慮する（タイムスタンプ＋正規化した名前か、Last.fm の表記を後勝ちで更新）
  - health-ojimpo 側の取りこぼしは health-ojimpo-ef と衝突するので触っていない。直すかどうかは本人判断（移行で取り込みが新基盤へ移るなら、旧側は直さず移行時に全件取得で埋める手もある）

- **21:40 プロジェクト発足・名前決定** — 「arigato-gateway があるから scrobble-gateway とかは？」
  - 候補は lastfm-service / scrobble-hub / listening-core / lastfm-station。station はラジオ局の意味が強くデータ基盤とずれる、で見送り
  - **名前は `scrobble-gateway` で確定**（2026-10-04 本人）
  - 実在の `sync-gateway`（本人が改名して忘れていた）と並ぶ名前。README で別物と明記する
  - 9/17 に Cosense で固まった方針（独立基盤・health-ojimpo は利用者）に従う。旧案「health.db を MCP が直接読む」「health-ojimpo API を叩く」は破棄済み
- **Like 同期の方針** — 「Last.fm ではLoveはつけてない、Spotifyではつけてる」「これから再生するSpotifyのトラックがLoveされてたらLast.fmで順次していくってやり方だったら安全じゃない？」
  - [確] Last.fm 側の Loved は使っていない → MCP に Loved 読み取りは不要
  - [確] Todoist に未完了の同種タスクあり（2026-05-31、`SpotifyのLikeをLast.fmのLoved Tracksに同期する`）。本件で置き換える
  - 増分方式を採用。冪等・戻せる・影響範囲が小さい。取りこぼし防止のため最新1件でなく直近数日分を毎時見直す。初期実装には入れない
