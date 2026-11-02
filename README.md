# cockpit（案件ボード）

案件単位の進捗を1画面で見るローカルツール。どのチャットの Claude からでも CLI で更新でき、開いているブラウザにリアルタイムで反映される。Node.js の標準ライブラリだけで動く（npm install 不要）。

> 公開リポジトリ。コード・README・コミットメッセージの例に、実在の顧客名・人名・社内のパスを書かない。案件データは `data/` に置き、`data/` はコミットしない。

## 動かす

```bash
git clone https://github.com/mitsudaman/cockpit.git
cd cockpit
node server.mjs                # http://localhost:4747/ （Ctrl+C で止める）
bash menubar/install.sh        # 任意: launchd で常駐させ、メニューバーから起動・停止する（初回とサーバー設定を変えたとき）
```

- 常駐させると launchd（`local.cockpit`）で動く。オン/オフはメニューバーのアイコンから。止めた状態はログインし直しても保たれる
- メニューバー: ボードを開く／サーバーの起動・停止・再起動／ログ（`~/Library/Logs/cockpit.log`）
- `server.mjs` や `lib.mjs` を変えたら、サーバーを再起動して反映する（`index.html` は再読み込みだけでよい）

## 安全モード（セキュリティの厳しいMac向け）

`data/config.json` に `{"safe": true}` と書いてサーバーを起動すると、次の機能が止まる。

- VS Code のドック（`open` コマンドを起動し、VS Code の記録ファイルを読む）
- INBOX・LINKS（ホームのファイルを配信する）
- Claude のメモリ表示（`~/.claude/projects` を読む）
- Google Fonts の読み込み（外への通信。システムフォントになる）

あわせて、常駐（`menubar/install.sh`）は使わず、使うときだけ `node server.mjs` で起動する。

どのモードでも、サーバーは `127.0.0.1` だけで待ち受け、Host が `localhost` / `127.0.0.1` でない要求と、他のサイトからの書き込み（Origin が違う・JSON でない POST/PATCH）は 403 で断る。

## 仕組み

- データ: `data/cases/<id>.json`（1案件1ファイル）
- サーバーはファイルを監視しているので、CLI や JSON の直接編集もそのまま画面に流れる
- 現在地レポートの HTML も1.5秒ごとに更新時刻を見ていて、書き換えると開いているレポート（ボードの中・全画面の別タブとも）が自動で読み直される。ボードの中ではスクロール位置とタブ（`#…`）を残す
- 画面からも、ステータス・ボール・次の一手・工程・メモを編集できる
- まとまりは「ディレクトリ ＞ サブプロジェクト（任意）」。`board new` は今いるディレクトリを自動で入れる（worktree からでも本体リポジトリに寄せる）
- ディレクトリの表示名と並び順は `data/dirs.json`（例: `{"~/work/sample-app": "SAMPLE APP"}`。書いた順にサイドバーと一覧が並ぶ）。なければフォルダ名
- ディレクトリの色は順番に割り当てる。決まった色にしたいものは `data/dir-colors.json`（例: `{"~/work/sample-app": "#a67c5b"}`）
- サイドバーの INBOX は `data/inbox/` の中身（HTML・画像・PDF）。Claude が見せたいもの（見本・レポート・スクショ）を置くと新しい順に並び、`/inbox/<ファイル名>` で新しいタブに開く。ほかの場所のファイルはシンボリックリンクで置いてよい（実体はホーム配下だけ）。要らなくなったら消す
- INBOX の見本に「選んで決定」を付けるには、HTML に `<script src="/inbox-kit.js"></script>` を入れ、選べる要素に `data-pick="H1"`（案の種類が複数なら `data-group="ヘッダー"` も）を付ける。決定は `data/inbox/.answers.jsonl` に残り、`board wait <ファイル名>` が受け取って JSON で出す（Claude は run_in_background で待つ）。決定済みのものはサイドバーに「✓ 決定」と出る
- 見本で「決定」を押すと、横に「タブを閉じる」が出る（ボードから新しいタブで開いたものだけ閉じられる。閉じられないときは「⌘W で閉じてね」に変わる）
- 画面の下・真ん中に浮かぶドック（VS Code のアイコン）は `data/dirs.json` に書いたフォルダごと。中の字は英語なら単語の頭文字、日本語なら1文字目。案件の詳細を開いている間は隠れる。押すと、そのフォルダをいま開いている VS Code のウィンドウが前に出る（デスクトップも切り替わる）。どのウィンドウかは VS Code の storage.json の記録から探す。複数フォルダをまとめた名前のないワークスペースの中にあるときは、`vscode://file/…` のリンクでフォルダ直下の CLAUDE.md（なければ README.md）を開いてそのウィンドウに着地させる（そのファイルのタブが開く）。どこにも開いていなければ新しいウィンドウで開く。dirs.json にないフォルダは開かない
- サイドバーの LINKS は `data/links.json`（例: `[{"title": "ダッシュボード", "path": "~/notes/dashboard/index.html"}]`）。`/link/<番号>/` で、その HTML と同じフォルダの中のファイルだけを配信する。外のサイトは `{"title": "サンプル", "url": "https://example.com/"}` のように `url` で書くとそのまま開く

## CLI

```bash
B=<クローンした場所>/board.mjs
node $B list                                   # 進行中の一覧（--all で完了も、--here で今いるディレクトリだけ）
node $B new <id> title=... client=... next=...  # project=管理画面 でサブプロジェクト
node $B set <id> status=review next="レビュー依頼" log="PR #123 作成"
node $B set <id> ball=other waiting_on=田中さん
node $B step <id> 5 done                       # 工程の状態（todo / next / done）
node $B log <id> "QA依頼済み"
node $B link <id> "PR #123" https://...
```

- status: `investigating`(調査) `implementing`(実装) `review`(レビュー) `verify`(検証) `release`(マージ・リリース) `report`(報告) `hold`(保留) `done`(完了)
- ball: `me`（自分が動く） / `other`（相手待ち。`waiting_on` に誰か）
- `memory` に `~/.claude/projects` からの相対パスを入れると、詳細画面で Claude のメモリ本文を読める
- `report` にホーム配下の `.html` のパス（`~/` 始まり可）を入れると、詳細画面の「現在地レポートを開く」で全画面表示できる（`/report/<id>` で配信）
  - 置き場所は基本 `data/reports/<id>/現在地.html`。カードと同じくボードのデータとして Mac ごとに持ち、git に入れない。案件のリポジトリに資料として残したいものだけ、その案件のフォルダに置く
  - レポートと同じフォルダの直下にある資料（HTML・画像・PDF）は `/report/<id>/<ファイル名>` で開ける。サブフォルダ・ドットファイル・それ以外の種類は出さない。レポート側は相対リンク（`<a data-sibling href="資料.html">`）のままにして、ボードで開いたときだけ JS でこの URL に向け直す
