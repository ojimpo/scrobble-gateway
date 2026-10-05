# scrobble-gateway

自分のLast.fmの聴取履歴を一か所に集めて扱う、自宅サーバー上のサービスである。
全履歴をSQLiteに保存し、毎時Last.fmと同期したうえで、MCPサーバーとしてChatGPTやClaudeから読めるようにしている。

```
Last.fm API ──▶ scrobble-gateway ──▶ MCP（claude.ai / ChatGPT / 自分）
                 （マスター DB）  ──▶ health-ojimpo（日次の再生件数）
                                 ──▶ Cosense 同期（予定）
```

## なぜ作ったか

2021年から、SpotifyとApple Musicで再生した曲をLast.fmにscrobbleしてきた。2026年10月時点で9.5万件ある。
この履歴を、AIと話しながら掘り返したかった。「9月は何をよく聴いていたか」「去年の今ごろと比べて何が増えたか」「このアーティストに最初にハマったのはいつか」といった問いである。
毎朝の音楽レコメンドもAIに作らせていて、その材料としても長期・期間別の嗜好が要る。

履歴そのものは、自作の健康ダッシュボード[health-ojimpo](https://github.com/ojimpo/health-ojimpo)がすでに毎時取り込んでいた。
最初は「health-ojimpoのDBをMCPから読めばいい」と考えたが、やめた。
health-ojimpoは各サービスのAPIを**叩く側**として作ってきた。ここで他から**叩かれる側**にすると、役割が崩れる。
Last.fmのAPIキーと完全な履歴を持つ場所を1つに絞り、health-ojimpoもMCPもその利用者にする。そのために作ったのがこのリポジトリである。

## 設計の考え方

- **Last.fmのデータの窓口はここだけにする。** APIキーもマスターDBも、ここに1つずつ置く。移行が済めば、health-ojimpoが持つのは日次の再生時間のような派生値だけになり、完全な履歴を重複して抱えることはない
- **MCPは自前のDBを読む。** その場でLast.fm APIを叩かないので、任意の期間で集計でき、応答も速い（9月1か月分のランキングで0.1秒未満）。Last.fm側の障害やレート制限にも左右されない
- **正本はLast.fm。** 初回はhealth-ojimpoのDBをコピーせず、Last.fmから全件を取り直した（9.5万件で約7分）。コピーすると、取り込み側に溜まった表記揺れまで引き継いでしまう
- **ゼロから書かない。** 既存のLast.fm MCPを6つ比べ、構成がいちばん近い[sptmru/lastfm-mcp](https://github.com/sptmru/lastfm-mcp)を土台にした（比較の経緯は[DEVLOG.md](DEVLOG.md)）。コピーではなく**履歴ごとmerge**してあるので、上流の修正はそのまま取り込める。そのため、こちらの変更は上流のコードと衝突しにくいよう小さく保っている

## 上流から変えたこと

土台のsptmru/lastfm-mcpはよくできているが、自分の9.5万件を載せて運用してみると、足りないところがあった。

| 変更 | 理由 |
| --- | --- |
| 差分同期で直近72時間を取り直す | Spotify経由のscrobbleは、Last.fmに**遅れて、順不同で**届く。「最新のscrobbleの時刻より後」だけを取ると、あとから届いた古い時刻の再生を永久に取りこぼす |
| 起動時と毎時の自動同期 | 上流はツールかCLIから手動で同期する作りなので、放っておくと索引が古くなる |
| 名寄せ表にMBIDのインデックスを張る | 上流はMusicBrainz IDの列にインデックスが無く、9.5万件の初回名寄せに25分以上かかる計算になっていた。その間はサーバー全体が止まる。インデックスを張れば22秒で済む |
| SpotifyのLikeをLast.fmのLoveに同期する（直近に再生した曲だけ） | 上流にも同期はあるが、5,000曲を超えるLikeライブラリ全体を一度に突き合わせる方式である。こちらは毎時、直近72時間に再生した曲のうちLike済みのものにだけLoveを付ける。書き込みが必ず自分の再生に結びつくので、覚えのない書き込みが大量に起きることはない。同期は一方向で、Likeを外してもLoveは外さない。書くのは確実に一致した曲だけである |
| 任意期間のツール `get_top_in_range` / `compare_ranges` | 上流の期間別トップと期間比較は、Last.fmの固定期間（7日・1か月・12か月など）しか受け付けない。これでは「9月と8月」「今年と去年」に答えられない |
| OAuth 2.1 | 上流には認証が無い。外に公開するなら必須である |

## 外部サービスとの連携

### Last.fm

読み取りに使うAPIは`user.getRecentTracks`だけで、APIキーさえあればユーザー認証なしで読める。
書き込みはLike同期の`track.love`だけである。こちらはShared secretで署名し、一度だけブラウザで承認して得たセッションキーを使う。

実際に動かして分かったLast.fmの癖が2つある。どちらも、これからLast.fmの履歴を扱う人の役に立つと思う。

- **scrobbleは後から届く。** health-ojimpoの取り込みを「前回の最新時刻より後」だけを取る差分取得にしたところ、2週間で12件の取りこぼしが出た。抜けた曲はすべてSpotifyで再生したもので、届くのが遅れたうえに、時刻の順番も前後していた。差分取得の起点は少し遡らせておく必要がある
- **全ページを順に取ると、ページの境目で同じブロックが2回返ってくることがある。** そのぶん一覧の総数もふくらむ。主キーで重複を弾けばDBは正しくなるが、件数の検証にページ総数は使えない。`from` / `to`で期間を区切った件数を使う

### MCP（claude.ai / ChatGPT）

MCPはStreamable HTTPで話す。ツールは上流の約30個に任意期間の2個を足した、32個である。
直近の再生、期間別ランキング、期間比較、アーティストの聴き込み度、セッションの切り出し、時期ごとの嗜好の変化点などを扱える。一覧と使い方は[上流の README](docs/upstream-README.md)にある。

認証はOAuth 2.1にした。ChatGPTのコネクタはOAuthしか受け付けず、claude.aiのカスタムコネクタは固定のBearerトークンを送れない。両方から使うなら、OAuthしか選択肢がない。
認可サーバーは、別に作ったCosense用MCP（cosense-mcp）のものを1人用に絞って移植した。動的クライアント登録、PKCE、`resource`による宛先の検証、`iss`パラメータの完全一致など、ChatGPTとclaude.aiの両方で通すために踏んだ罠への対処も、そのまま持ってきている。
利用者の認証はパスフレーズ1つで行う。

MCP SDKはv2系を使っている。ただ、v2にはトークンを検証する部品しか無く、トークンを発行する認可サーバーの部品が無い。そこだけSDK v1の`mcpAuthRouter`を使っている。

### Cloudflare Tunnel

自宅サーバー（arigato-nas）の4104番をCloudflare Tunnelで公開している。ポートは開けていない。

### health-ojimpo

健康ダッシュボードがLast.fmから使っていたのは日ごとの再生件数だけで、件数×3.5分をその日の音楽再生時間とみなしている。
そこで、Dockerネットワークの中だけに開いた内部REST（`GET /daily-plays`）で、日次の件数だけを渡すようにした。health-ojimpoはもうLast.fm APIを叩かず、完全な履歴も持たない。
このポートは外に公開していないので、Cloudflare Tunnelを通らず、OAuthも要らない。

切り替えは2026年10月5日に行った。backendの差し替え1回で旧来の取り込みの停止と新しい取り込みの開始が同時に起きるようにしておき、二重取り込みの期間を作らなかった。
切り替え前に1,933日分の日次件数を突き合わせ、違いが出るのは旧データに表記揺れの重複があった4日だけだと確かめてから反映した。

## 動かし方

Node.js 22.5以上（`node:sqlite`を使うため）か、Dockerが必要である。

```bash
cp .env.example .env
# LASTFM_API_KEY と LASTFM_USERNAME を書く
# 外に公開するなら MCP_PUBLIC_URL と MCP_OAUTH_PASSPHRASE も書く
docker compose up -d --build
curl -s http://127.0.0.1:4104/healthz
```

起動すると全履歴の取得が自動で始まり、終わったあとは毎時の差分同期に切り替わる。進み具合は`/healthz`で確認できる。

主な設定は次のとおり。全項目は[.env.example](.env.example)にある。

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `HISTORY_INCREMENTAL_LOOKBACK_HOURS` | `72` | 差分同期で遡る時間。`0`にすると上流と同じ動きになる |
| `HISTORY_AUTO_SYNC_ENABLED` | `true` | 起動時と毎時の自動同期 |
| `MCP_PUBLIC_URL` / `MCP_OAUTH_PASSPHRASE` | なし | 両方そろうとOAuthが有効になる。片方だけでは起動しない |
| `MCP_ALLOW_UNAUTHENTICATED` | `false` | 認証なしでHTTPを開くことを明示的に許可する。指定しなければ、認証なしでは起動しない |
| `MCP_ALLOWED_HOSTS` | なし | 受け付けるHostヘッダ。公開ホスト名を足し忘れると403になる |

テストは`npm test`、型チェックは`npm run typecheck`で実行できる。

## これから

- **旧資産の片付け。** health-ojimpoに残してある旧来の取り込みコードとscrobbleのテーブルは、ロールバック期間が終わったら消す
- **日本語表記と英語表記の名寄せ。** いまは「エイプリルブルー」と「AprilBlue」、「宇多田ヒカル」と「Hikaru Utada」が別のアーティストとして数えられている。MusicBrainz IDの付いていない曲が多いためである
- **毎朝のレコメンドへの組み込み。** 期間別の嗜好の統計をCosenseへ機械的に書き出し、AIが毎朝読む嗜好プロファイルの材料にする
- **上流への還元。** 後着分の取りこぼしとインデックスの修正は、上流でもそのまま効く

## ライセンスとクレジット

MITライセンス。土台は[sptmru/lastfm-mcp](https://github.com/sptmru/lastfm-mcp)（MIT）で、その著作権表示は[LICENSE](LICENSE)にそのまま残したうえで、こちらの変更分の表示を足してある。
開発の経緯と判断の記録は[DEVLOG.md](DEVLOG.md)に、作業上の手引きは[CLAUDE.md](CLAUDE.md)にまとめてある。
コードの大半は[Claude Code](https://claude.com/claude-code)と一緒に書いた。
