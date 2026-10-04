# scrobble-gateway

## 概要

Last.fm データの唯一の窓口になる独立サービス。Last.fm API キー・scrobble のマスター DB・全履歴バックフィル・差分取り込み・期間別集計をここだけが持つ。
`Last.fm API → scrobble-gateway → health-ojimpo / Last.fm MCP / Cosense 同期` の向きで、health-ojimpo と MCP はどちらも**利用者**。

## なぜ独立させたか（設計判断）

- health-ojimpo は「各 API を叩く側」として作ってきた。ここで「叩かれる API」にしたくない（2026-09-17 の本人方針）
- API キーとマスター DB を各1つに絞る。移行後の health-ojimpo は日次の再生時間など派生値だけを持ち、完全な scrobble 履歴は重複保持しない
- MCP は ChatGPT / Claude / 本人が任意の時点で履歴を探索するための必須インターフェース（Scheduled Task 用の補助ではない）

## 状態

**未着手（2026-10-04 時点でディレクトリと文書だけ）。** 仕様・判断履歴の正本は Cosense `Last.fm MCP・音楽レコメンド基盤 NAS調査引継ぎ`。経過は DEVLOG.md。

## 実装前の必須工程

1. 既存 Last.fm MCP の調査（rianvdm/lastfm-mcp ほか、GitHub / npm / PyPI / MCP Registry）。「流用 / 改変 / 設計だけ参考 / 不採用」の表を Cosense ページに追記する。**確定するまで本体コードを大量に書かない**
2. Last.fm アカウントの登録日・総 scrobble 数と health.db（2021-01-24〜、93,741件）の照合。足りなければ `user.getRecentTracks` で一度限りのバックフィル

## 移行順序

1. health.db バックアップ → 件数照合
2. 既存 93,741件をコピー → バックフィル
3. 非公開のまま集計を既存 DB と照合
4. health-ojimpo を内部 REST 利用へ変更
5. 旧取り込み停止と新取り込み開始を**同一切替**で行う（二重取り込みを作らない）
6. stdio / Tailscale 内で MCP 検証 → 4104 番と Cloudflare Tunnel（sudo、config.yml のバックアップ必須）
7. claude.ai / ChatGPT から実際に呼ぶ

旧資産（health-ojimpo 内の Last.fm 取り込み・spotify-liked-delta・scrobble-sqlite-archive）は、移行完了とロールバック期間終了まで消さない。

## 運用メモ

- ポートは 4104（4100〜4103 は既存 MCP / cosense-mcp 管理画面）
- 足場は health-mcp（TypeScript + @modelcontextprotocol/sdk、stdio / Streamable HTTP 両対応）を流用する
- 自作アプリなので Watchtower のラベルは付けない（既存運用に合わせる）
- Bash ツールの PATH に node が無い。nvm の絶対パスを使うか Docker に入れる
- Last.fm の API キーを URL に含めてログへ出さない（health-ojimpo の httpx は INFO で URL 全体を出していた）

## 初期 MCP ツール（案）

直近再生 / 期間別トップアーティスト・曲・アルバム / 期間比較 / 特定アーティスト・曲の再生履歴 / Spotify Liked との重なり。
Last.fm 側の Loved は使っていない（Like は Spotify が正本）ので読むツールは不要。

## 後回しにしたもの

Spotify Like → Last.fm Love の同期。「これから再生する曲のうち Spotify で Like 済みのものだけ、直近数日分の scrobble を毎時見直して `track.love`」という増分方式にする。書き込み認証（セッションキー）が新規で必要なので、基盤が回り始めてから足す。Like を外した場合は同期しない（一方向）。
