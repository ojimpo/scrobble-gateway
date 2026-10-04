# scrobble-gateway 進捗ログ

意思決定を日付つきで積む（新しい日付が上、追記のみ）。確度: `[確]` = 実測、無印 = 判断。

## 2026-10-04

- **21:40 プロジェクト発足・名前決定** — 「arigato-gateway があるから scrobble-gateway とかは？」
  - 候補は lastfm-service / scrobble-hub / listening-core / lastfm-station。station はラジオ局の意味が強くデータ基盤とずれる、で見送り
  - **名前は `scrobble-gateway` で確定**（2026-10-04 本人）
  - 実在の `sync-gateway`（本人が改名して忘れていた）と並ぶ名前。README で別物と明記する
  - 9/17 に Cosense で固まった方針（独立基盤・health-ojimpo は利用者）に従う。旧案「health.db を MCP が直接読む」「health-ojimpo API を叩く」は破棄済み
- **Like 同期の方針** — 「Last.fm ではLoveはつけてない、Spotifyではつけてる」「これから再生するSpotifyのトラックがLoveされてたらLast.fmで順次していくってやり方だったら安全じゃない？」
  - [確] Last.fm 側の Loved は使っていない → MCP に Loved 読み取りは不要
  - [確] Todoist に未完了の同種タスクあり（2026-05-31、`SpotifyのLikeをLast.fmのLoved Tracksに同期する`）。本件で置き換える
  - 増分方式を採用。冪等・戻せる・影響範囲が小さい。取りこぼし防止のため最新1件でなく直近数日分を毎時見直す。初期実装には入れない
