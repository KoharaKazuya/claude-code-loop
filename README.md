# claude-code-loop

Claude Code ベースの自律開発エージェント基盤(Supervisor)。特定のアプリケーションに依存しない
汎用の仕組みとして抽出したもので、任意のリポジトリに `.agent/` / `.claude/` を持ち込み、
`package.json` に `agent:*` スクリプトを足すだけでループエンジニアリングを始められる。

## 考え方

人間は `.agent/GOAL.md` で方向性(ミッション・優先順位・制約)だけを与える。Supervisor が
Claude Code セッションを繰り返し起動し、GOAL.md をもとに探索・タスク分解・実装・検証を自律的に
進める。人間はループの外から進捗を確認し、必要なときだけ介入する(判断が必要な事項は
Human Review として記録され、人間の回答を待たずに他の作業は続く)。

## 構成

`.agent/` に自律実行の仕組みと状態のすべてが入る。

- `supervisor/` — タスクキューを読み、`claude -p` を新セッションで起動し続ける Supervisor(依存ゼロ TypeScript、Node の型ストリップで直接実行)
- `GOAL.md` — 人間が方向性を与える唯一の入口。**空なら新しい作業を発明しない**
- `OVERVIEW.md` — GOAL に対する現在地と次の見立て(探索セッションが生成・維持する。初期状態では存在しない)
- `PROMPT.md` — 全自律セッション共通ルール(記録ファイルの形式もここに定義)
- `tasks/` / `decisions/` / `human-review/` — 1 トピック 1 ファイルの記録。終わったもの(completed タスク・closed な Review・古い判断)は Supervisor が `archive/` へ自動退避する
- `permission-denials.jsonl` — セッションが permission により拒否された操作の記録(git 管理外。`npm run agent:status` に要約が出る)
- `config.json` / `claude-settings.json` / `hooks/` — セッションの実行設定

`.claude/CLAUDE.md` は対話セッション向けのエージェント運用ルール。`.claude/agents/reviewer.md` は
実装完了後に独立レビューを行うレビュー担当エージェントの定義。

## 前提

- **Node.js 24 以上、または 22 系なら 22.18 以上**(devcontainer は 24)。`.ts` をビルドせず
  Node の型ストリップで直接実行するため、型ストリップが既定で有効なバージョンが必要。
- **Claude Code CLI**(`claude`)。devcontainer を使う場合は feature としてインストール済み。

## 実行環境(worktree と並列実行)

タスクセッションはリポジトリ本体ではなく、外側の `<repo>-worktrees/<タスクID>` に用意された
専用ブランチ `agent/<タスクID>` の git worktree で動く。空きスロットがあれば独立した ready タスクを
`parallel.maxSessions`(既定 4、`.agent/config.json`)まで同時に起動する。探索・triage セッションは
リポジトリ本体で動き、Supervisor のメインループがその完了を await でブロックして待つため、実行中の
タスクセッションを待たず(drain せず)並走する。main への git 操作(マージ等)はこの await のおかげで
直列のまま保たれる。並走中は該当タスクの `.agent/tasks/<id>.md` を触らないよう探索プロンプトへ
走行中タスクの一覧が注入される。

- worktree には本体の `node_modules` がシンボリックリンクされる。それ以外は素の checkout から
  始まるため、Git 管理外の生成物は worktree 間で共有されない。
- セッション終了後、main への統合は Supervisor が `git merge --no-ff` で自動的に行う
  (`Agent-Auto: supervisor-state` トレーラー付き)。並列セッションが同じ `D-`/`HR-` 番号を
  採番して起きる衝突は、番号を振り直して機械的に解消する。
- 内容が対立する実質的な衝突は worktree とブランチを残し、次の試行がその続きとして衝突解消を
  試みる(作業をやり直さない)。リトライ上限に達すると `agent/conflict/<タスクID>-<時刻>` へ
  退避される。
- コミットしなかった変更は `.agent/patches/<タスクID>-<時刻>.patch` へ退避される(`git apply` で
  復元可能。14 日で自動削除)。

## 実行と停止

```sh
npm run agent          # Supervisor をループ実行
npm run agent:once     # 1 セッションだけ実行
npm run agent:status   # 要対応事項(BLOCK / failed / open な Review / 衝突の残り)を一覧表示
npm run agent:list     # タスク一覧を表示
npm run agent:rotate   # .agent/ 状態ファイルのローテーションを手動実行
npm run agent:watch    # agent:status を色付きで1秒ごとに再表示
```

停止は `touch .agent/STOP` / `echo session > .agent/STOP` のどちらでも、新規セッションを起動せず
実行中のセッション(並列実行時はすべて)が終わり次第停止する点で同じ。`clean` はさらに、`.agent/` 以外に
未コミットの差分が残っていればそれを出力してから停止する(worktree 化により、実行中セッションの側で
この差分を解消することはできないため)。Ctrl+C は段階停止で、1 回目で STOP(clean) を作成、2 回目で
session に更新、3 回目で緊急停止(強制終了。中断タスクは次回起動時に自動復旧)という自然なエスカレーション
になる。手動 `touch`/`echo` で作った STOP からも Ctrl+C で次の段階へ進められる。
`npm run agent:once` では段階化されず、Ctrl+C 1 回で緊急停止する。
再開は `rm .agent/STOP && npm run agent`。

`npm run agent` は、実行可能なタスクが無く・実行中セッションも無い状態で探索セッションを実行しても
新しいタスクが生まれなかった時点で自動的に正常終了する(STOP ファイルは残らない)。スヌーズ中のタスクが
残っている間は、時間が来て復帰するのを待つためすぐには終了しない。探索が新しいタスクを 1 件も生まなかった
場合、次の探索は `.agent/config.json` の `explore.minIntervalMs`(既定 1 時間)が経過するまで行わない
(タスクセッションが完了するたびに空振りの探索を繰り返さないため)。ただし GOAL.md の変更や Human Review
への回答があれば、この間隔を待たずに即座に探索する。要対応事項(blocked / failed /
open な Review)が残っていれば終了時にその件数を案内する。再開は改めて `npm run agent` を実行する
(前回の探索結果は持ち越さず、起動のたびに一度は探索してから終了判定に入る)。

## 人間の関与

このシステムは人間の回答を待たずに動き続ける。人間は非同期に確認し、必要なときだけ介入する。

- **方向づけ**: `.agent/GOAL.md` を書く(全セッションに注入される)。**空なら新しい作業を発明しない**。
  やりたい作業が明確なら `npm run agent:add -- "タイトル" --desc "..."` で直接タスクを積む方が速い。
- **確認**: `npm run agent:status` で要対応事項(BLOCK / failed / open な Review)を見る。
  進捗の概観(GOAL に対する現在地と次の見立て)も同じ出力に含まれる。
  Supervisor が自動で解消しない衝突の残り(衝突解消待ちの worktree、退避された
  `agent/conflict/*` ブランチ)も同じ要対応欄に並ぶ。permission により拒否された操作の
  直近の要約も同じ出力に含まれる(対応不要。許可したい操作があれば
  `.agent/claude-settings.json` の `permissions.allow` に追記する)。
- **Review への回答**: `.agent/human-review/HR-*.md` の「## 回答」節にあるチェックボックスに
  チェックを入れるだけでよい(status の書き換えは不要)。
  - 対応不要なら `- [ ] 対応不要(このままクローズしてよい)` を `- [x]` にする。
  - 回答を書くなら `- [ ] 回答を下に書いた` を `- [x]` にしたうえで、その下に決定内容を書く。
  Supervisor が変化を検出すると、次のタスクより先に 3 段階で取り込む(BLOCK は常に 3 段目のみ)。
  1. **決定論判定**: 「対応不要」だけにチェックが入っている場合、機械的に closed にする。
  2. **軽量モデル判定**: 1. で片付かなかった回答を軽量モデル(既定 haiku)が close / 新規タスク登録 /
     判断困難(次段へ委ねる)に仕分ける。
  3. **探索セッション**: 1./2. で判定できなかった回答と BLOCK エントリを取り込む(フルの探索モデル)。
  回答対応が常に最優先になるわけではない。チェックを入れ忘れて本文だけ書いた場合は
  `npm run agent:status` に注意喚起が出る。
- **failed の再実行**: `node .agent/supervisor/supervisor.ts retry T-XXX`。失敗原因を放置すると
  再び失敗するので、原因側の修正タスクを先に積むのが普通。
- **巻き戻し**: 自律コミットは main に積まれるだけで push はされない。緊急時は停止して
  `git log` / `git diff` で確認し、人間が `git revert` して経緯を `.agent/decisions/` に記録してから再開する。
- **衝突解消待ちの後始末**: `agent/conflict/<タスクID>-<時刻>` へ退避されたブランチは
  `git log agent/conflict/<...>` で内容を確認し、取り込むなら手動で `git merge`/`cherry-pick`、
  不要なら `git branch -D` で破棄する。`.agent/patches/` へ退避されたパッチは
  `git apply .agent/patches/<タスクID>-<時刻>.patch` で復元できる(14 日で自動削除される)。
- **運用コミットの見分け方**: Supervisor が `.agent/` 配下だけを自動コミットする際は
  `docs(agent):` 接頭辞 + `Agent-Auto: supervisor-state` trailer を付ける。人間が書いた変更を
  含むコミットと機械的に区別でき、`git log --oneline --invert-grep --grep='Agent-Auto: supervisor-state'`
  で運用コミットを除いた履歴だけを見られる。subject はステージした差分の内容から生成される
  (例: `docs(agent): タスク 2 件と判断記録 1 件を更新する`)。
- **設定変更**: `.agent/config.json`(モデル・リトライ・タイムアウト・並列数 `parallel.maxSessions`)は起動している supervisor
  プロセスには反映されない(`run` ループの実行中は起動時点の設定を使い続ける)。反映するには
  一度停止して起動し直すか、`npm run agent:once` で都度起動する。`.agent/claude-settings.json`
  (権限)はセッションごとに読み直されるため、次に起動するセッションから反映される。
- **supervisor 自身のコード変更**: `.agent/supervisor/` 配下を変更しても、稼働中の supervisor
  プロセスには反映されない(ホットリロードは無い)。起動時点のソースと現在のソースが食い違うと
  `npm run agent:status` の「稼働状態」に注意喚起が出るので、それを見て停止・再起動する。

## 別のリポジトリへの導入

1. `.agent/`(`tasks/` / `decisions/` / `human-review/` は `.gitkeep` のみ)と `.claude/` をコピーする
2. `package.json` に `agent:*` スクリプト(この README の「実行と停止」の一覧)を足す
3. `.gitignore` に本リポジトリの「自律実行の実行時ファイル」節をコピーする
4. `.agent/GOAL.md` にミッション・目標・制約を書く
5. devcontainer を使うなら `.devcontainer/` も持ち込む(worktree 置き場の作成と
   `node_modules` ボリュームの権限設定が `post-create.sh` に入っている)
6. プロジェクトの検証コマンド(`typecheck` / `lint` / `test` 等)を整える
   (セッションはこれらが通ってからタスクを completed にする)

## 開発(この基盤自体の検証)

```sh
npm run typecheck
npm run lint
npm test
```

セッションが失敗した際は、Supervisor が出力するセッション ID を使い、claude-code-log で
セッションログを確認できる。タスクセッションは worktree(`<repo>-worktrees/<タスクID>`)で動くため、
ログは `~/.claude/projects/` 配下のそれに対応するプロジェクトディレクトリに記録される
(探索セッションは本体リポジトリのプロジェクトディレクトリ)。セッションごとのコスト・トークンは
`.agent/metrics.jsonl` に記録され、累計は `npm run agent:status` で見られる。
