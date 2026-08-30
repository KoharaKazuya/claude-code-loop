/**
 * `ccloop --help` / `ccloop <サブコマンド> --help` のヘルプ文字列。
 *
 * 「AI エージェントが --help だけで使い方に到達できる」ことを狙い、実際に argv 解析されている
 * オプションだけを載せる(推測で書かない)。実体は cli.ts(グローバルオプション)、
 * supervisor.ts(status/list/add)、watch.ts(watch)、init.ts(init)の argv 解析部を参照して同期する。
 *
 * テストから参照できるよう、文字列は定数としてエクスポートする(cli.test.ts)。
 */

export const TOP_LEVEL_HELP = `ccloop: Claude Code を使った自律開発ループ CLI。
対象リポジトリの .agent/ に記録されたタスクを順に Claude Code セッションへ割り当てて実行する。

使い方:
  ccloop [--repo <path>] <サブコマンド> [引数...]

サブコマンド:
  run      常駐ループ(自律実行)。停止は Ctrl+C(SIGINT)
  status   稼働状況・進捗の要約(--json で機械可読出力)
  watch    status を一定間隔で再描画し続ける
  list     タスク一覧(--json で機械可読出力)
  add      タスクを追加する
  retry    failed / blocked タスクをやり直す(status を ready に戻す)
  init     .agent/ の雛形を配置する
  doctor   実行環境の自己診断(副作用なし)
  version  ccloop 自身のバージョンを表示する

グローバルオプション:
  --repo <path>  対象リポジトリのルート(既定: 環境変数 CCLOOP_REPO、無ければ cwd から上方探索)。
                 サブコマンドの前でも後ろでも指定できる(例: ccloop status --repo <path>)

詳細: ccloop <サブコマンド> --help

注意点(自動実行するエージェント向け):
  - run はフォアグラウンドで動き続ける常駐プロセス。バックグラウンド/別プロセスとして起動し、
    status か watch で進捗を監視すること(run 自体の終了を待つと呼び出し元がブロックする)
  - run の停止は Ctrl+C(SIGINT)のみ。押すたびに段階が上がる(1回目 clean → 2回目 緊急停止 →
    3回目 即 SIGKILL)
  - init は非 TTY 環境では確認プロンプトを出せないため --yes が必須
  - status / list は --json を付けると機械可読な JSON を stdout に 1 オブジェクトで出力する
    (既定の人間向け整形出力とは別の出口で、挙動は変わらない)`;

export const SUBCOMMAND_HELP: Readonly<Record<string, string>> = {
  run: `使い方: ccloop [--repo <path>] run [--force]

常駐ループを起動し、.agent/ の ready なタスクを優先度順に Claude Code セッションへ割り当てて
実行する。ready なタスクが無ければまず探索セッションが動き、GOAL.md からタスクを導出する。
ready なタスクがある間も、一定間隔ごとに空いた枠で探索を挟んで GOAL.md / main の変化を取り込む
(探索は並列セッション枠を 1 つ消費し、走行中は新しいタスクセッションを起動しない)。
フォアグラウンドで動き続けるプロセスなので、エージェントから使うときはバックグラウンド/別プロセスで
起動し、\`ccloop status\` か \`ccloop watch\` で監視すること。

停止: 実行中の端末で Ctrl+C(SIGINT)。押すたびに段階が上がる。
  1回目 (clean)  新規セッションを起動せず、実行中のセッションが終わり次第停止する
                 (衝突解消待ちの worktree があれば、その解消セッションだけ 1 本ずつ起動してから停止する)
  2回目          緊急停止(SIGTERM → 猶予後 SIGKILL)
  3回目          即 SIGKILL

同一リポジトリに対して ccloop run は同時に 1 つだけ実行できる。既に動いていると判定した場合は
状態を一切書き換えずに起動を拒否する。

オプション:
  --force  同一リポジトリで既にループが動いていると判定されても起動する(通常は使わない)`,

  status: `使い方: ccloop [--repo <path>] status [--json]

稼働状況・進捗の要約(進捗バー・要対応事項・実行中/次に実行予定のタスク・稼働状態)を表示する。

オプション:
  --json  人間向け整形出力の代わりに、構造化された JSON を stdout へ 1 オブジェクトで出力する`,

  watch: `使い方: ccloop [--repo <path>] watch [--interval <秒>]

\`ccloop status\` と同じ内容を一定間隔で再描画し続ける。Ctrl+C で終了する
(\`ccloop run\` 本体には影響しない)。

オプション:
  --interval <秒>, -n <秒>  再描画間隔(秒、小数可)。既定 1 秒。下限 0.2 秒
                            (--interval=<秒> の = 形式でも指定できる)`,

  list: `使い方: ccloop [--repo <path>] list [--full] [--json]

タスク一覧を、状態(working/ready/blocked/failed/completed)ごとにグループ化して表示する。

オプション:
  --full  note(進捗・結果・ブロック理由)を全文表示する(既定は 1 行 80 文字に省略)
  --json  人間向け整形出力の代わりに、構造化された JSON を stdout へ 1 オブジェクトで出力する
          (--full の有無に関わらず全フィールドを含む。--full との併用はエラーにならない)`,

  add: `使い方: ccloop [--repo <path>] add "タイトル" [--desc <説明>] [--priority <N>]
                     [--deps <ID>,<ID>,...] [--model <モデル名>] [--slug <slug>]

新規タスクを .agent/tasks/ に追加する。

オプション:
  --desc <説明>       タスク本文。省略時はタイトルに続く位置引数を本文にし、それも無ければ
                      タイトル自体を本文にする
  --priority <N>      優先度(数値が小さいほど先に実行される)。既定 3
  --deps <ID>,<ID>    依存タスク ID(カンマ区切り)。既定は依存なし
  --model <モデル名>  このタスクだけに使うモデル。既定は .agent/config.json の model
  --slug <slug>       タスク ID に使う slug(小文字英数字とハイフンのみ)。省略時はタイトルから
                      自動生成し、生成できなければ "task" にフォールバックする`,

  retry: `使い方: ccloop [--repo <path>] retry <タスクID>

failed / blocked のタスクを再実行対象に戻す: status を ready に、retries を 0 にする
(snoozeUntil が設定されていれば併せて解除する)。実行中のタスクは対象外。
戻す前に、そのタスクの直前の失敗理由(note と本文の「## 試行履歴」の最後の記録)を表示する。

オプション: なし(--repo はグローバルオプション。サブコマンドの前後どちらでも指定可)`,

  init: `使い方: ccloop [--repo <path>] init [--yes] [--upgrade]

.agent/ の雛形(GOAL.md / OVERVIEW.md / config.json / tasks/ / decisions/ / human-review/)を
配置する。既存ファイルは絶対に上書きしない(衝突したものはスキップと表示するだけ)。

オプション:
  --yes, -y   確認プロンプトなしで配置・移行する(非 TTY 環境では必須)
  --upgrade   配置ではなく、.agent/config.json の schemaVersion を最新へ移行するモードにする`,

  doctor: `使い方: ccloop [--repo <path>] doctor

実行環境を自己診断する: git / Node.js / claude CLI の有無、claude へのログイン状態、
.agent/ の存在と schemaVersion、state ディレクトリへの書き込み可否。副作用はない(ファイルを書き込まない)。

オプション: なし(--repo はグローバルオプション)`,

  version: `使い方: ccloop version

ccloop 自身のバージョンを表示する。リポジトリに紐づかないため .agent/ が無くても実行できる。

オプション: なし`,
};

/**
 * サブコマンドのヘルプ文字列から、先頭の「使い方: ...」ブロック(最初の空行まで)だけを取り出す。
 * エラーメッセージ等で使い方だけを簡潔に出したい場合に使う(help.ts と表記がずれないようにするため)。
 * 未知のサブコマンドを渡した場合は例外を投げる(呼び出し側の誤り検出のため)。
 */
export function usageOf(sub: string): string {
  const help = SUBCOMMAND_HELP[sub];
  if (help === undefined) {
    throw new Error(`未知のサブコマンド: ${sub}`);
  }
  return help.split("\n\n")[0];
}
