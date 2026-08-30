# claude-code-loop (ccloop)

Claude Code ベースの自律開発ループ CLI。任意のリポジトリで `ccloop run` を起動すると、
`.agent/GOAL.md` に書かれた方向性をもとに Claude Code セッションが探索・タスク分解・実装・検証を
繰り返し、人間はループの外から進捗を確認して必要なときだけ介入する。

## 考え方

人間は `.agent/GOAL.md` で方向性(ミッション・優先順位・制約)だけを与える。ccloop が Claude Code
セッションを繰り返し起動し、GOAL.md をもとに探索・タスク分解・実装・検証を自律的に進める。人間は
ループの外から進捗を確認し、必要なときだけ介入する(判断が必要な事項は Human Review として記録され、
人間の回答を待たずに他の作業は続く)。

ツール本体は DevContainer feature としてリポジトリの外にインストールされ、対象リポジトリに残すのは
`.agent/` 配下の設定・記録だけである(理由は [docs/architecture.md](docs/architecture.md) を参照)。

## 前提

ccloop feature 自身は次を前提とし、インストールしない(ベースイメージや他の feature が満たす)。

- git
- Node.js 24 以上、または 22 系なら 22.18 以上(`.ts` を型ストリップで直接実行するため)
- Claude Code CLI(`claude`)

## インストール

利用側リポジトリの `.devcontainer/devcontainer.json` に次の feature を追加する。

```jsonc
{
  "features": {
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/node:1": {},
    "ghcr.io/anthropics/devcontainer-features/claude-code:1": {},
    "ghcr.io/koharakazuya/claude-code-loop/ccloop:0.4.1": {}
  }
}
```

`installsAfter` により、上記 4 つの feature はこの順で(git → node → claude-code → ccloop)
インストールされる。コンテナを再ビルドすると `/usr/local/bin/ccloop` が使えるようになる。

## 使い方

対象リポジトリのルートで任意のサブコマンドを実行する。`.agent/` が無ければ作成予定のファイル一覧を
表示し、TTY なら確認のうえ雛形(`GOAL.md` / `OVERVIEW.md` / `config.json` / `tasks/` / `decisions/` /
`human-review/`)を配置してから続行する(非 TTY では `ccloop init --yes` を案内して終了する。
既存ファイルは上書きしない)。

1. `ccloop init` (または任意のサブコマンドの初回実行)で `.agent/` を用意する
2. `.agent/GOAL.md` にミッション・現在の目標・制約を書く(**空のままだと新しい作業を発明しない**)
3. `ccloop run` でループを起動する。ready なタスクが無ければまず探索セッションが動き、GOAL.md から
   タスクを導出する(ready なタスクがある間も、一定間隔ごとに探索を挟んで GOAL.md / main の変化を
   取り込む)。`run` は停止するまで終了しない常駐プロセスなので、起動した端末はそのまま開いておく
4. 別の端末から `ccloop watch`(既定 1 秒間隔、`--interval` で変更可)で進捗を眺める。1 回だけ見たい
   ときは `ccloop status`、タスク一覧は `ccloop list`(`--full` で詳細)。どちらも `--json` を付けると
   機械可読な JSON を出力する。`ccloop status` にはループ本体(`ccloop run`)が動いているかと
   状態の最終更新時刻も出る
5. やりたい作業が明確なら
   `ccloop add "タイトル" [--desc ...] [--priority ...] [--deps ...] [--model ...] [--slug ...]`
   で直接タスクを積める(`--slug` 省略時はタイトルから自動生成する。ASCII 化できなければ `task`)

同一リポジトリに対して `ccloop run` は同時に 1 つだけ実行できる。既に動いていると判定した場合は
状態を一切書き換えずに起動を拒否する(どうしても起動する場合は `ccloop run --force`)。

各サブコマンドの詳細は `ccloop <サブコマンド> --help`(または `-h`)で確認できる。

### 停止

`ccloop run` を実行している端末で Ctrl+C する。

- 1 回目: 新規セッションの起動を止め、実行中のセッションが完了するのを待ってから終了する
  (`.agent/` 以外に未コミットの差分が残っていれば警告する)。衝突解消待ちの worktree があれば、
  解消セッションだけを 1 本ずつ起動してから停止する(即座に止めたいときはもう一度 Ctrl+C)。
  起動するのはタスクごとに停止後 1 回までで、解消セッションが再び衝突した場合は worktree を
  残したまま停止する(次回の `ccloop run` が同じ worktree で解消を再開する)
- 2 回目: 緊急停止(SIGTERM を送り、猶予後も生きていれば SIGKILL)
- 3 回目: 即 SIGKILL

強制終了で中断されたセッションの worktree とブランチはそのまま残り、次回そのタスクを実行するときに
再利用される。STOP ファイルのような永続的な停止指示は無く、停止は Ctrl+C を受けたプロセスの中だけで
完結する。

## 人間の関与

このシステムは人間の回答を待たずに動き続ける。人間は非同期に確認し、必要なときだけ介入する。

- **方向づけ**: `.agent/GOAL.md` を書く(全セッションに注入される)。**空なら新しい作業を発明しない**。
- **確認**: `ccloop status` で要対応事項(BLOCK / failed / open な Human Review)と、GOAL に対する
  現在地・次の見立て(`.agent/OVERVIEW.md`)を見る。permission により拒否された操作の直近の要約も
  同じ出力に含まれる(対応不要。許可したい操作があれば `.agent/claude-settings.json` の
  `permissions.allow` に追記する)。
- **フェーズゲート**: プロダクトの構築・拡張では、開発を段階(フェーズ)に分けて進め、フェーズ境界を
  越えるたびに Human Review で続行の同意を取ってから次フェーズへ進む。
- **Human Review への回答**: `.agent/human-review/HR-<日時>-<slug>.md` の「## 回答」節にあるチェックボックスに
  チェックを入れるだけでよい(`status` の書き換えは不要)。
  - 対応不要なら `- [ ] 対応不要(このままクローズしてよい)` を `- [x]` にする。
  - 回答を書くなら `- [ ] 回答を下に書いた` を `- [x]` にしたうえで、その下に決定内容を書く。
  次のセッション起動時に決定論判定 → 軽量モデル判定(triage)までが即時に走り、探索セッション
  (最終段)は次に空き枠が空いたタイミングで 1 回にまとめて取り込む(BLOCK は常に最終段のみ)。
- **failed / blocked タスクの再実行**: `ccloop retry <タスクID>` を使う。実行中でなければ、直前の失敗理由
  (note と本文の「## 試行履歴」)を表示したうえで `status: ready`、`retries: 0` に戻す(snoozeUntil が
  設定されていれば併せて解除する)。失敗原因を放置すると再び失敗するので、原因側の修正を先に行うのが
  普通。手で該当タスクファイル(`.agent/tasks/T-<日時>-<slug>.md`)の frontmatter を編集する方法も
  引き続き使える。completed タスク・closed な Review は `.agent/archive/` へ自動的に退避される
  (ローテーションはループ内で自動)。判断ファイルは `.agent/decisions/index.md` で人間がチェックを
  付けたものだけが退避される。未チェックの判断が何件溜まっているかは `ccloop status` の
  `[確認推奨]` に件数とプレビューが出る。
- **巻き戻し**: 自律コミットは対象リポジトリの `git log` に積まれるだけで push はされない。緊急時は
  `ccloop run` を停止し、`git log` / `git diff` で確認したうえで人間が `git revert` し、経緯を
  `.agent/decisions/` に記録してから再開する。
- **運用コミットの見分け方**: `.agent/` 配下だけを対象にした自律コミットには
  `docs(agent):` 接頭辞 + `Agent-Auto: supervisor-state` トレーラーが付く。人間が書いた変更を含む
  コミットと機械的に区別でき、
  `git log --oneline --invert-grep --grep='Agent-Auto: supervisor-state'` で運用コミットを除いた履歴だけを
  見られる。

## リポジトリに置くファイルと実行時状態の場所

利用側リポジトリで git 管理するのは `.agent/` のみ。

- `GOAL.md` — 人間が方向性を与える唯一の入口
- `OVERVIEW.md` — GOAL に対する現在地と次の見立て(探索セッションが生成・維持する)
- `config.json` — モデル・リトライ・タイムアウト・並列数などの設定
- `tasks/` / `decisions/` / `human-review/` — 1 トピック 1 ファイルの記録
- `decisions/index.md` — 判断のチェックリスト。人間がチェックを付けた判断がアーカイブ対象になる
- `archive/` — completed タスク・closed な Review・チェック済みの判断の退避先
- (任意)`claude-settings.json` — permissions の allow/deny への追記
- (任意)`PROMPT.local.md` — 共通ルールへの追記

`.claude/` を利用側リポジトリに置く必要はない。共通ルールは `claude -p` 起動時に
`--append-system-prompt-file` で、reviewer サブエージェントは `--agents` で、permissions/hooks は
ツールが生成する `--settings` で注入される。利用側リポジトリに `CLAUDE.md` があればそれも通常どおり
読まれる。

実行時状態(`state.json` / `metrics.jsonl` / `permission-denials.jsonl` / `patches/` / 生成された
settings・system prompt / `worktrees/`)はリポジトリの外、
`${XDG_STATE_HOME:-~/.local/state}/ccloop/<リポジトリ名>-<ハッシュ>/` に置かれる。タスクセッションの
git worktree もここ(`worktrees/<タスクID>`、ブランチ `agent/<タスクID>`)に作られる。

## 設定

`.agent/config.json` の主なキー:

| キー | 内容 |
| --- | --- |
| `schemaVersion` | このファイルのスキーマバージョン(現在 1) |
| `claudeCommand` | セッションを起動するコマンド名(既定 `claude`)。ラッパースクリプト経由で起動したい場合に変える |
| `model` / `escalation` | セッションに使うモデル、リトライ超過時のエスカレーション先 |
| `permissionMode` | `claude -p` の permission mode |
| `maxRetries` / `taskTimeoutMs` / `maxTurns` | タスクセッションのリトライ上限・タイムアウト・ターン上限 |
| `rateLimit.backoffMs` | レート制限検出時のバックオフ |
| `idlePollMs` | 次に起動できるものが無いときの待機間隔(既定 60000)。短くすると状況変化への反応が早くなる代わりに空回りが増える |
| `explore` | 探索セッションの有効/無効・最小間隔(`minIntervalMs` は、実行可能タスクがある間の定期見直し間隔と、直前の探索が空振りだった場合のクールダウンを兼ねる) |
| `triage` | Human Review の軽量モデル判定の有効/無効・モデル |
| `parallel.maxSessions` | 独立な ready タスクを同時に走らせる上限(探索セッションもこの枠を 1 つ消費し、探索中は新規タスクセッションを起動しない) |
| `parallel.worktreeDir` | タスクセッションの worktree 置き場(既定は状態ディレクトリ配下の `worktrees/`)。相対パスはリポジトリルート基準で解決する |
| `parallel.linkPaths` | worktree にリポジトリ直下から symlink する gitignore 済みパス(既定 `["node_modules"]`)。セッションごとの依存インストールを省くためのもの |

`.agent/claude-settings.json`(任意)は permissions の allow/deny への追記だけを書く。
`.agent/PROMPT.local.md`(任意)はリポジトリ固有の追加ルールを書くと共通ルールの後ろに連結されて
注入される。どちらもセッション起動時に読まれるため、次に起動するセッションから反映される。

## バージョンアップ

`.agent/config.json` の `schemaVersion` で ccloop 本体とのスキーマ互換性を管理する。

- ツールが新しく `.agent/` のスキーマが古い場合: `ccloop init --upgrade` を実行する
- `.agent/` のスキーマがツールより新しい場合: ツールを更新する(`devcontainer.json` の feature 参照バージョンを最新リリースに上げて
  コンテナを再ビルドする)

詳細は [docs/compatibility.md](docs/compatibility.md) を参照。

各バージョンで何が入ったかは [CHANGELOG.md](CHANGELOG.md) にまとまっている。

## 診断

`ccloop doctor` で git / Node.js / `claude` CLI の有無、`claude` へのログイン状態、`.agent/` の存在と
`schemaVersion`、state ディレクトリへの書き込み可否を検査できる。

## セッションログを追う

`ccloop status` も実行中のコンソール出力も、セッションの結果の要約しか出さない。セッションが実際に
何をしたかは Claude Code 自身が transcript として記録しており、次の順でたどる。

1. **セッション ID を調べる。** `ccloop status --json` の `metrics` 配列(実体は状態ディレクトリの
   `metrics.jsonl`。1 セッション 1 行の JSON Lines)に `sessionId` が入っている。`taskId` で絞り込むと
   そのタスクの試行が時系列に並ぶので、最後の行が直近の試行。`sessionId` が無い行は結果 JSON を
   得られずに終わったセッション(タイムアウトや起動失敗)で、原因は同じ行の `abnormal` に出る。
   `metrics` 配列は表示が重くならないよう直近の記録までしか含まない(`metricsTruncated` が
   `true` のときは打ち切られている)。それより古いセッションの `sessionId` が要る場合は、
   消えていない `metrics.jsonl` を直接開く。
2. **セッションが動いたディレクトリを決める。** タスクセッションは worktree(既定では
   `<状態ディレクトリ>/worktrees/<タスクID>`)、探索・triage セッションはリポジトリ本体で動く。
   状態ディレクトリの絶対パスは `ccloop doctor` の「state ディレクトリ」の行に出る。
3. **記録を開く。** Claude Code は 2 のディレクトリの絶対パスの英数字以外をすべて `-` に置き換えた
   名前で `~/.claude/projects/` 配下に記録を作る。その中の、セッション ID を名前に持つものが目的の
   記録である(`<セッション ID>/subagents/` にサブエージェントの記録が並ぶ)。

記録はリポジトリの外に残るため、worktree が片付いた後のタスクでも同じ手順で追える。

## 開発(この基盤自体)

このリポジトリ自身の開発は次で検証する。

```sh
npm run typecheck
npm run lint
npm test
```

`.devcontainer/` のコンテナ内で `ccloop` コマンドが指すのは、利用者と同じ経路でインストールされた
公開済み feature(`ghcr.io/koharakazuya/claude-code-loop/ccloop:0.4.1`)であり、この checkout の
`lib/` ではない。`lib/` のローカル変更を試すときは `./bin/ccloop <subcommand>` を直接実行する
(`bin/ccloop` は自身の実体から見た `../lib` を `CCLOOP_HOME` として解決するランチャー)。feature 自体の
動作は `devcontainer features test` で検証する(CI の `feature-test` ジョブと同じ手順)。

`lib/` の変更を PATH 上の `ccloop` コマンドへ実際に反映する(手元のインストールを最新の中身へ入れ替える)
手順は [docs/architecture.md「手元の ccloop をリポジトリの最新の中身へ入れ替える」](docs/architecture.md#手元の-ccloop-をリポジトリの最新の中身へ入れ替える)
を参照。手元が古いかどうかの見分け方もそこにある。

リリースは `npm run release <patch|minor|major>` を実行する。`npm version` を直接叩いてはいけない
(`npm run release` のみを使う)。このスクリプトは main ブランチであること・作業ツリーがクリーンであること・
origin/main と同期していることを確認したうえで `check:version` / `typecheck` / `lint` / `test` を実行し、
すべて通れば `npm version <patch|minor|major>`(コミットメッセージは `build: バージョンを %s に更新` に固定)
を実行してコミットと `vX.Y.Z` タグを作成し、最後に `git push --follow-tags` する。`npm version` の
`version` フック(`scripts/sync-version.mjs`)が `features/ccloop/devcontainer-feature.json` の
`version` と README.md 中の ccloop feature 参照バージョンを同期する。これら 2 ファイルを手で編集しては
いけない(`scripts/sync-version.mjs` が上書きする)。push が失敗した場合、コミットとタグはローカルに
作成済みなので `git push --follow-tags origin main` を再実行すれば回復する。状態チェックと検証だけ
試したい場合は `npm run release -- <patch|minor|major> --dry-run`(npm 経由でオプションを渡すには `--`
が必要)を使うと、`npm version` や `git push` などの変更操作を実行する手前で止まる。

`scripts/check-version.mjs` が package.json を含む 3 箇所のバージョン一致を検証する。CI
(`.github/workflows/ci.yml`)は push 時にこれを実行し、GitHub Actions(`.github/workflows/release.yml`)は
`vX.Y.Z` タグ push 時にタグバージョンとの一致まで検証したうえで `lib/` と `bin/` を feature にバンドルし、
GHCR へ publish する。`.devcontainer/devcontainer.json` 中の ccloop feature 参照と
`.devcontainer/devcontainer-lock.json` はこの同期・検証の対象外で、リリース後に手動で更新する
(digest は publish 後にしか確定しないため、devcontainer.json だけ自動更新すると lock との整合が取れない)。
lock はコンテナ再ビルド時に devcontainer CLI が解決し直す。

## ドキュメント

- [CHANGELOG.md](CHANGELOG.md) — 各バージョンの変更点(利用者から見て何が変わったか)
- [docs/architecture.md](docs/architecture.md) — 設計上の判断とその理由
- [docs/compatibility.md](docs/compatibility.md) — 互換性の運用方針と既知の制約
- [lib/prompt/PROMPT.md](lib/prompt/PROMPT.md) — 自律実行セッション共通ルール(system prompt として注入される本体)
