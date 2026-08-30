---
title: "failed タスクを人間が断念しても status の要対応から消す手段がない"
status: completed
priority: 2
dependencies: []
retries: 0
createdAt: 2026-08-30T10:02:27.000Z
---

所属フェーズ: 4(思いつく改善すべて)。status 表示と運用が変わる話だが、**人間の承認は取得済み**
(2026-08-30、対話セッションで人間が「断念の正規手段を実装してよい」と回答済み)。追加の
Human Review は不要。変更履歴(CHANGELOG.md)には載せること。

## 何が問題か

`ccloop status` の「[要対応] failed タスク」は `status: failed` のタスクを無条件に列挙する
(`lib/supervisor.ts` の `by("failed")` 周辺)。一方で:

- 自動アーカイブ `rotate()` の対象は `status === "completed"` のみ(`lib/rotate.ts` 200 行付近)。
  failed をアーカイブする経路が存在しない。
- タスク status の有効値は `ready / working / blocked / completed / failed` の 5 つだけで、
  「人間が断念と判断した」を表す終端状態がない。5 値以外を書くと「status が不正」扱いになる。
- `ccloop retry` は再挑戦専用で、「もう挑戦しない」と判断する手段は未提供。

結果として、一度 failed になり人間が断念と判断したタスクが**永久に「要対応」へ表示され続ける**。
実例が 2 件ある(下記)。D-20260830-0546 の「failed は人間の目に触れさせる」という意図は
「人間が判断するまで」であり、判断後の終端処理は未整備の穴。

## やること

人間が断念を明示したら要対応から消え、アーカイブへ退避される正規の導線を作る。

推奨案(比較検討のうえ、より良い設計があればそちらでよい。判断は `.agent/decisions/` に記録):

1. `ccloop abandon <タスクID>` サブコマンドを追加する。`status: failed` のタスクに対してのみ有効で、
   frontmatter に断念マーカー(例: `abandonedAt: <ISO 日時>`)を記録する。`ccloop retry` と対になる
   「もう挑戦しない」側の操作。
2. `rotate()` のアーカイブ対象に「`status: failed` かつ断念マーカーあり」を加える。これにより
   status の要対応から自然に消える(表示ロジック側の特別扱いは最小で済むはず)。
3. `ccloop status` の failed 一覧の案内文に、断念する場合のコマンドを添える(retry と abandon の
   両方の選択肢が見えるように)。

避けること:

- `status: completed` への書き換えで代用しない(完了していないものが進捗率の分子に入り、記録の
  意味も歪む)。
- status の有効値へ新値(`abandoned` 等)を追加する案は、バリデーション・プロンプト・Supervisor の
  遷移処理への波及が大きい。マーカー方式と比較して波及が小さい方を選ぶこと。

## 完了条件

- 断念操作 → status の要対応から消える → アーカイブへ退避される、の一連が機械的検証
  (テスト)で確認できること。
- 既存の実例 2 件を新手段で断念処理し、`ccloop status` の要対応に出なくなること:
  - T-20260830-0621-conflict-retry-always-reconflicts(成果は main 取り込み済み。人間が断念を判断済み、
    タスクファイル末尾「人間の判断」節参照)
  - T-20260830-0808-conflict-session-timeout-mislabeled(同上)
- README「人間の関与」の failed タスクの節に abandon の使い方を追記すること。
- CHANGELOG.md の「## 未リリース」に 1 行載せること。

## 試行履歴

### 試行 1(2026-08-30T11:33:00.000Z, セッション記録)

- 確認済みの事実:
  - `ccloop abandon <ID>` を実装(`abandonedAt` マーカー方式、`status` の有効値は増やさず)。
    `rotate()` のアーカイブ対象に「failed かつ abandonedAt あり」を追加、`ccloop status` の要対応
    failed 一覧から断念済みを除外し案内文に retry/abandon を併記、`ccloop retry` は断念を解除する。
    README / CHANGELOG / help も更新。
  - `npm run typecheck` / `npm run lint` / `npm test`(1146 件)すべて成功。
  - 実例 2 件(T-20260830-0621-..., T-20260830-0808-conflict-session-timeout-mislabeled)に対し
    `./bin/ccloop abandon` を実行し exit 0。直後の `ccloop status` の「[要対応] failed タスク」から
    両件が消えることを実出力で確認した。
  - ただし **その書き込み先は worktree ではなくリポジトリ本体 `/workspaces/claude-code-loop/.agent/`
    だった**。本体側に未コミットの差分として残っている(このブランチには含まれない)。同じ差分を
    ブランチにも入れると自動マージが「ローカルの変更が上書きされる」で中断する恐れがあるため、
    worktree 側には入れないことを選んだ。本体側の差分を戻す `git restore` は permission で拒否された
    ため、そのまま残してある。次のローテーションで archive へ退避される見込み。
  - 上記の解決先の問題は T-20260830-1132-ccloop-in-worktree-targets-main-agent-dir として登録。
    保存時に `updatedAt` が消える問題は T-20260830-1132-task-frontmatter-unknown-fields-dropped。
- 未検証の推測: なし(実装・検証はすべて実出力で確認済み)。
- 次の試行への提案: 未着手のレビュー指摘が 2 件ある。(1) `cmdRetry` の archive 済み案内が
  「完了済みとして退避されています」固定で、断念退避のケースと文言が合わない。(2) idle-exit
  サマリの failed 件数(`lib/supervisor.ts` の `failedCount`)は断念済みを除外していないため
  `ccloop status` の要対応と食い違いうる。いずれも軽微で、上記 2 タスクとまとめて直すのが効率的。
