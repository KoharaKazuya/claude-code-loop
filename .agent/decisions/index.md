# 決定インデックス

チェック `[x]` を付けた決定は、次回ローテーションでアーカイブされる。

- [ ] [D-20260830-0938-metrics-read-cap-limits](D-20260830-0938-metrics-read-cap-limits.md) — 実行ログの読み込み上限を末尾 512 KiB / 1000 行にする
- [ ] [D-20260830-0934-running-task-file-guard-declined](D-20260830-0934-running-task-file-guard-declined.md) — 実行中タスクの記録ファイルへの書き込みを仕組みで拒否する対応は見送る
- [ ] [D-20260830-0934-orphaned-worktree-detection-declined](D-20260830-0934-orphaned-worktree-detection-declined.md) — ccloop の管理から外れた作業場所を検出して status に出す対応は見送る
- [ ] [D-20260830-0825-fatal-stop-record-declined](D-20260830-0825-fatal-stop-record-declined.md) — ループの異常停止を status に残す対応は見送る
- [ ] [D-20260830-0825-cross-repo-ratelimit-declined](D-20260830-0825-cross-repo-ratelimit-declined.md) — 利用上限の待機状態をリポジトリ間で共有する対応は見送る
- [ ] [D-20260830-0824-missing-dependency-visible-not-blocking](D-20260830-0824-missing-dependency-visible-not-blocking.md) — 存在しない依存はスケジューリングを止めず、status の要対応で気づかせる
- [ ] [D-20260830-0812-keep-attempt-history-after-fix](D-20260830-0812-keep-attempt-history-after-fix.md) — 衝突リトライ別枠化の後は解消セッションも試行履歴を残してよい
- [x] [D-20260830-0801-ratelimit-under-timeout-evidence](D-20260830-0801-ratelimit-under-timeout-evidence.md) — タイムアウトに隠れた利用上限は stderr の文言だけを根拠に判定する
- [ ] [D-20260830-0758-housekeeping-exclusion-scope](D-20260830-0758-housekeeping-exclusion-scope.md) — 探索契機の片付けで除外するのは走行中タスクのタスクファイルだけにする
- [x] [D-20260830-0757-split-hint-covers-max-turns](D-20260830-0757-split-hint-covers-max-turns.md) — 分割を促す申し送りは時間切れとターン上限の両方に出す
- [ ] [D-20260830-0752-salvage-failure-keeps-worktree](D-20260830-0752-salvage-failure-keeps-worktree.md) — 退避に失敗した worktree は削除せず残し、state ディレクトリのマーカーで status に出す
- [ ] [D-20260830-0749-doctor-auth-check-design](D-20260830-0749-doctor-auth-check-design.md) — doctor のログイン状態検査は claude auth status --json を使い、疑わしいときは必須にしない
- [ ] [D-20260830-0746-changelog-union-merge](D-20260830-0746-changelog-union-merge.md) — CHANGELOG.md は .gitattributes の union マージで自動解決する
- [ ] [D-20260830-0745-conflict-retry-separate-budget](D-20260830-0745-conflict-retry-separate-budget.md) — マージ衝突の再試行はタスク本来のやり直し回数と別枠にする
- [x] [D-20260830-0730-conflict-resolution-anchor-strategy](D-20260830-0730-conflict-resolution-anchor-strategy.md) — マージ衝突の解消は main 先端との差分アンカーを避けて行う
- [ ] [D-20260830-0622-init-conflict-no-rollback](D-20260830-0622-init-conflict-no-rollback.md) — init のパス種別衝突は事前検出で止め、部分適用のロールバックは実装しない
