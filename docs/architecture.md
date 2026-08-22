# アーキテクチャ

コードを読めば分かる事実の羅列は避け、「なぜこの形になっているか」だけをまとめる。

## ツール本体をリポジトリの外に置く

ccloop は DevContainer feature としてインストールされ、`/usr/local/share/ccloop/` に本体が置かれる。
利用側リポジトリに残るのは `.agent/` 配下の設定・記録だけである。

- ツール本体のアップデートが利用側リポジトリの diff にならない。feature のバージョンを上げてコンテナを
  再ビルドするだけで全リポジトリに反映できる。
- 複数リポジトリに同じ仕組みを持ち込むとき、コピーしたコードが各リポジトリで少しずつ乖離していく問題が
  起きない。
- 利用側は「何を自律実行に任せるか(GOAL.md)」と「実行結果の記録(tasks/decisions/human-review)」
  だけを持てばよく、実行エンジンの実装詳細を気にしなくてよい。

この設計の裏返しとして、ツールは「利用側リポジトリのどこにインストールされたか」を前提にできない
(`lib/paths.ts` のコメント参照)。リポジトリルートは `--repo` / `CCLOOP_REPO` / cwd からの `.git` 探索で
実行時に決定する。

## `.claude/` を要求しない

利用側リポジトリに `.claude/CLAUDE.md` や `.claude/agents/reviewer.md` を置く運用も可能だが、ccloop は
それを要求しない。共通ルールは `claude -p` 起動時に `--append-system-prompt-file` で、reviewer
サブエージェントは `--agents` で、permissions/hooks は生成した `--settings` で注入する。

理由は、`.claude/` を持ち込むと利用側リポジトリの他の Claude Code の使い方(人間の対話セッションなど)
と設定が衝突しうるため、ccloop の関心事(自律実行セッションの挙動)を利用側の `.claude/` 設定から
完全に切り離したいから。利用側リポジトリに元から `CLAUDE.md` があれば、それは通常どおり Claude Code が
読み込むので共存できる。

**既知の制約**: `--append-system-prompt-file` で注入した内容は、fork でないサブエージェント
(Task ツールで起動されたセッション)には引き継がれない。そのため自律実行セッションが他のサブエージェント
へ委譲するときは、守らせたいルール(AskUserQuestion を使わない、Bash は 1 コマンドずつ、等)を
委譲プロンプト本文に定型文として明示的に書く必要がある(`lib/prompt/PROMPT.md` の「委譲時の定型注意」)。
これは仕組み上の制約であり、将来 Claude Code 側の挙動が変わらない限り解消されない。

## 実行時状態を `~/.local/state` に置く

`state.json` / `metrics.jsonl` / `permission-denials.jsonl` / `patches/` / 生成された settings・system
prompt / `worktrees/` は、利用側リポジトリの外、XDG state ディレクトリ
(`${XDG_STATE_HOME:-~/.local/state}/ccloop/<リポジトリ名>-<ハッシュ>/`)に置く。

- git 管理外にしたい実行時ファイルを `.gitignore` で除外し続ける手間・漏れのリスクを無くせる。
- 利用側リポジトリの親ディレクトリへの書き込み権限が要らない(devcontainer の `/workspaces` は root
  所有で、兄弟ディレクトリを作るには sudo が要る環境がある)。
- タスクセッションの git worktree もここに置くことで、リポジトリの入れ子(リポジトリの中に別の
  worktree が checkout される)を避けられる。

ディレクトリ名はリポジトリの realpath から作る `<basename>-<sha1 の先頭 8 文字>`。人間が見て分かる
basename と、同名リポジトリ(別クローン)を取り違えないためのハッシュを組み合わせている。

## 停止を Ctrl+C のみ・オンメモリにした理由

`ccloop run` の停止は、実行しているプロセスへの Ctrl+C(SIGINT)の段階的なエスカレーション
(1 回目: 新規セッション停止 → 実行中の完了待ち、2 回目: 完了待ちのまま即終了、3 回目: 強制終了)
だけで完結し、`STOP` ファイルのような永続的な停止指示ファイルは存在しない。

- 停止状態をファイルとして永続化すると、消し忘れたまま次回 `ccloop run` を実行したときに
  「なぜ動かないのか」が分かりにくくなる。プロセスが生きている間だけ有効な状態にすることで、
  次に `ccloop run` を実行すればそのまま動く単純な挙動にできる。
- 複数リポジトリで同時に ccloop を動かす運用を考えたとき、ファイルベースの停止指示は
  「どのリポジトリの停止か」の対応関係を別途管理する必要が出る。プロセス単位の Ctrl+C なら
  対応関係は自明。

## `dependsOn` でなく `installsAfter` を使う理由

`features/ccloop/devcontainer-feature.json` は git / node / claude-code の各 feature を
`installsAfter` で指定しており、`dependsOn` ではない。ccloop feature は git / Node.js / `claude` CLI を
自分ではインストールしない(前提として要求するだけ)ため、`dependsOn` で「無ければ入れる」機能は
不要で、必要なのは「これらの feature が(利用側の設定で指定されているなら)先に完了していること」
という順序保証だけである。存在確認は実行時に `ccloop doctor` が担う。

## CI の `src -> features` シンボリックリンク

`devcontainer features test` は `--base-path-to-features` のような publish 時のオプションを持たず、
`--project-folder` 配下の `src/<feature>` 固定でしか feature を探せない。このリポジトリは feature を
`features/ccloop` に置いている(`src/ccloop` ではない)ため、CI(`feature-test` ジョブ)では
`ln -s features src` でブリッジしてから `devcontainer features test` を実行している。ファイルの複製・
移動はしない。

## Node の型ストリップ前提(`erasableSyntaxOnly`)

ccloop は `.ts` をビルドせず Node の型ストリップ機能で直接実行する(`bin/ccloop` が
`node ... cli.ts` を直接叩く)。`tsconfig.json` の `erasableSyntaxOnly: true` は、型ストリップでは
消せない TypeScript 構文(enum、パラメータプロパティ等)の使用を型検査の時点で禁止し、
「型チェックは通るが実行時にストリップできない」コードが紛れ込むのを防ぐ。ビルドステップを持たない
ことで、feature のインストールが `lib/` と `bin/` のファイルコピーだけで完結する(コンパイル済み
成果物の生成・配布を気にしなくてよい)。この前提により、実行環境には型ストリップが既定で有効な
Node.js のバージョン(24 以上、または 22.18 以上)が要る。
