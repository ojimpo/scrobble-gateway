# scrobble-gateway

自分の Last.fm の聴取履歴を、自宅サーバーで一手に引き受けるサービスだ。
全履歴を SQLite に持ち、毎時 Last.fm と同期し、それを MCP サーバーとして ChatGPT や Claude に開く。

```
Last.fm API ──▶ scrobble-gateway ──▶ MCP（claude.ai / ChatGPT / 自分）
                 （マスター DB）  ──▶ health-ojimpo（日次の再生件数）
                                 ──▶ Cosense 同期（予定）
```

## なぜ作ったか

2021 年から Spotify と Apple Music の再生を Last.fm に scrobble していて、2026 年 10 月時点で 9.5 万件ある。
この履歴を、AI と話しながら掘り返したかった。「9 月は何をよく聴いていたか」「去年の今ごろと比べて何が増えたか」「このアーティストに最初にハマったのはいつか」。
毎朝の音楽レコメンドを AI に作らせているので、その材料としても長期・期間別の嗜好が要る。

履歴そのものは、自作の健康ダッシュボード [health-ojimpo](https://github.com/ojimpo/health-ojimpo) がすでに毎時取り込んでいた。
最初は「health-ojimpo の DB を MCP から読めばいい」と考えたが、やめた。
health-ojimpo は各サービスの API を**叩く側**として作ってきたもので、ここで他から**叩かれる側**にすると役割が崩れる。
Last.fm の API キーと完全な履歴を持つ場所を 1 つに絞り、health-ojimpo も MCP もその利用者にする。それがこのリポジトリだ。

## 設計の考え方

- **Last.fm のデータの窓口はここだけにする。** API キーもマスター DB もここに 1 つずつ置く。移行が済めば health-ojimpo は日次の再生時間のような派生値だけを持ち、完全な履歴を重複して抱えない
- **MCP は自前の DB を読む。** Last.fm API をその場で叩かないので、任意の期間で集計でき、応答も速い（9 月 1 か月分のランキングで 0.1 秒未満）。Last.fm 側の障害やレート制限の影響も受けない
- **正本は Last.fm。** 初回は health-ojimpo の DB をコピーせず、Last.fm から全件を取り直した（9.5 万件で約 7 分）。コピーすると、取り込み側に溜まった表記揺れまで引き継ぐことになる
- **ゼロから書かない。** 既存の Last.fm MCP を 6 つ比べて、構成がいちばん近い [sptmru/lastfm-mcp](https://github.com/sptmru/lastfm-mcp) を土台にした（比較の経緯は [DEVLOG.md](DEVLOG.md)）。コピーではなく**履歴ごと merge** してあるので、上流の修正はそのまま取り込める。そのために、こちらの変更は上流のコードと衝突しにくいよう小さく保っている

## 上流から変えたこと

土台の sptmru/lastfm-mcp は良くできているが、自分の 9.5 万件を載せて運用すると足りないところがあった。

| 変更 | 理由 |
| --- | --- |
| 差分同期で直近 72 時間を取り直す | Spotify 経由の scrobble は Last.fm に**遅れて、順不同で**届く。「最新の scrobble の時刻から先」だけを取ると、後から届いた古い時刻の再生を永久に取りこぼす |
| 起動時と毎時の自動同期 | 上流はツールか CLI で手動で同期する作りで、放っておくと索引が古くなる |
| 名寄せ表に MBID のインデックスを張る | 上流は MusicBrainz ID の列にインデックスが無く、9.5 万件の初回名寄せが 25 分以上かかる計算だった。その間はサーバー全体が止まる。インデックスを張ると 22 秒で済む |
| 任意期間のツール `get_top_in_range` / `compare_ranges` | 上流の期間別トップと期間比較は、Last.fm の固定期間（7 日・1 か月・12 か月など）しか受け付けない。「9 月と 8 月」「今年と去年」に答えられない |
| OAuth 2.1 | 上流は認証を持たない。外に公開するなら必須 |

## 外部サービスとの連携

### Last.fm

使う API は `user.getRecentTracks` だけだ。API キーがあれば読めて、ユーザー認証は要らない。

実測で分かった Last.fm の癖が 2 つある。どちらも、これから Last.fm の履歴を扱う人の役に立つと思う。

- **scrobble は後から届く。** health-ojimpo の取り込みを「前回の最新時刻から先」の差分取得にした途端、2 週間で 12 件の取りこぼしが出た。抜けた曲はすべて Spotify の再生で、届くのが遅れたうえに時刻の順番も前後していた。差分取得の起点は少し遡らせる必要がある
- **全ページを順に取ると、ページの境目で同じブロックが 2 回返ってくることがある。** 一覧の総数もその分ふくらむ。主キーで重複を弾けば DB は正しくなるが、件数の検証にページ総数は使えない。`from` / `to` で期間を区切った件数を使う

### MCP（claude.ai / ChatGPT）

Streamable HTTP で MCP を話す。ツールは上流の約 30 個に、任意期間の 2 個を足した 32 個だ。
直近の再生、期間別ランキング、期間比較、アーティストの聴き込み度、セッションの切り出し、時期ごとの嗜好の変化点など。一覧と使い方は [上流の README](docs/upstream-README.md) にある。

認証は OAuth 2.1 にしている。ChatGPT のコネクタは OAuth しか受け付けず、claude.ai のカスタムコネクタは固定の Bearer トークンを送れない。両方から使うなら OAuth しかない。
認可サーバーは、別に作った Cosense 用 MCP（cosense-mcp）のものを 1 人用に絞って移した。動的クライアント登録、PKCE、`resource` による宛先の検証、`iss` パラメータの完全一致など、ChatGPT と claude.ai の両方で通すために踏んだ罠ごと持ってきている。
利用者の認証はパスフレーズ 1 つだ。

MCP SDK は v2 系を使っているが、v2 にはトークン検証の部品しか無く、トークンを発行する認可サーバーの部品が無い。そこだけ SDK v1 の `mcpAuthRouter` を使っている。

### Cloudflare Tunnel

自宅サーバー（arigato-nas）の 4104 番を Cloudflare Tunnel で公開している。ポートは開けていない。

### health-ojimpo

健康ダッシュボードが Last.fm から使っていたのは、日ごとの再生件数だけだった（件数 × 3.5 分を日次の音楽再生時間とみなしている）。
そこで、Docker ネットワークの中だけに開いた内部 REST（`GET /daily-plays`）で日次件数だけを渡している。health-ojimpo はもう Last.fm API を叩かず、完全な履歴も持たない。
このポートは外に公開していないので、Cloudflare Tunnel を通らず、OAuth も要らない。

2026 年 10 月 5 日に切り替えた。旧来の取り込みの停止と新しい取り込みの開始は、backend の差し替え 1 回で同時に起きる作りにして、二重取り込みの期間を作らなかった。
切り替え前に 1,933 日分の日次件数を突き合わせ、変わるのは旧データに表記揺れの重複があった 4 日だけだと確かめてから反映した。

## 動かし方

Node.js 22.5 以上（`node:sqlite` を使う）か Docker が要る。

```bash
cp .env.example .env
# LASTFM_API_KEY と LASTFM_USERNAME を書く
# 外に公開するなら MCP_PUBLIC_URL と MCP_OAUTH_PASSPHRASE も書く
docker compose up -d --build
curl -s http://127.0.0.1:4104/healthz
```

起動すると全履歴の取得が自動で始まり、終わると以後は毎時の差分同期になる。進み具合は `/healthz` で見られる。

主な設定は次のとおり。全項目は [.env.example](.env.example) にある。

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `HISTORY_INCREMENTAL_LOOKBACK_HOURS` | `72` | 差分同期で遡る時間。`0` で上流と同じ動きになる |
| `HISTORY_AUTO_SYNC_ENABLED` | `true` | 起動時と毎時の自動同期 |
| `MCP_PUBLIC_URL` / `MCP_OAUTH_PASSPHRASE` | なし | 両方そろうと OAuth が有効になる。片方だけなら起動しない |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | 認証なしで HTTP を開くことを明示的に許す。何も書かないと認証なしでは起動しない |
| `MCP_ALLOWED_HOSTS` | なし | 受け付ける Host ヘッダ。公開ホスト名を足し忘れると 403 になる |

テストは `npm test`、型チェックは `npm run typecheck` で回る。

## これから

- **旧資産の片付け。** health-ojimpo に残してある旧来の取り込みのコードと scrobble のテーブルは、ロールバック期間が終わったら消す
- **日本語表記と英語表記の名寄せ。** いまは「エイプリルブルー」と「AprilBlue」、「宇多田ヒカル」と「Hikaru Utada」が別のアーティストとして数えられる。MusicBrainz ID が付いていない曲が多いからだ
- **Spotify の Like を Last.fm の Love に同期する。** 上流に実装はあるが、ライブラリ全体を突き合わせる方式だ。ここでは「これから再生した曲のうち Like 済みのものだけ、直近数日分を毎時見直して Love を付ける」増分方式にしたい。冪等で、戻せて、影響範囲が小さい
- **毎朝のレコメンドへの組み込み。** 期間別の嗜好の統計を Cosense に機械的に書き出し、AI が毎朝読む嗜好プロファイルの材料にする
- **上流への還元。** 後着の取りこぼしとインデックスの修正は、上流にもそのまま効く

## ライセンスとクレジット

MIT ライセンス。土台は [sptmru/lastfm-mcp](https://github.com/sptmru/lastfm-mcp)（MIT）で、その著作権表示は [LICENSE](LICENSE) にそのまま残し、こちらの変更分の表示を足してある。
開発の経緯と判断の記録は [DEVLOG.md](DEVLOG.md) に、作業上の手引きは [CLAUDE.md](CLAUDE.md) にある。
コードの大半は [Claude Code](https://claude.com/claude-code) と一緒に書いた。
