# 決定インデックス

チェック `[x]` を付けた決定は、次回ローテーションでアーカイブされる。

- [x] [D-20260830-1156-archived-task-read-strategy](D-20260830-1156-archived-task-read-strategy.md) — 書庫タスクは frontmatter の部分読み + mtime キャッシュで読む
- [x] [D-20260830-1150-agent-dir-follows-current-worktree](D-20260830-1150-agent-dir-follows-current-worktree.md) — .agent/ の基準は実行中の作業ツリー、git 操作と state は本体ワークツリー
- [x] [D-20260830-1141-startup-conflict-test-expectations](D-20260830-1141-startup-conflict-test-expectations.md) — 起動時回収の衝突テスト 2 件の期待値を retries から conflictRetries へ更新した
- [x] [D-20260830-1129-abandon-marker-over-status-value](D-20260830-1129-abandon-marker-over-status-value.md) — 断念は status の新値ではなく abandonedAt マーカーで表す
- [x] [D-20260830-1128-startup-recovery-note-marker](D-20260830-1128-startup-recovery-note-marker.md) — 起動時復旧の削除と記録の間も、state のマーカーで塞ぐ
- [x] [D-20260830-1127-task-extra-frontmatter-passthrough](D-20260830-1127-task-extra-frontmatter-passthrough.md) — タスクの未知 frontmatter は Task.extra で素通しし、updatedAt は型に持たせない
- [x] [D-20260830-1121-status-shows-config-outdated-only](D-20260830-1121-status-shows-config-outdated-only.md) — status の要対応に出すのは「設定が古い」向きのみとする
- [x] [D-20260830-1110-rescue-branch-omissions](D-20260830-1110-rescue-branch-omissions.md) — 退避ブランチから取り込まなかった差分とその理由
- [x] [D-20260830-1109-discarded-ours-always-recorded](D-20260830-1109-discarded-ours-always-recorded.md) — 衝突解消で捨てた main 側の変更は、機械記録か人間編集かを見分けず常にコミットメッセージへ残す
- [x] [D-20260830-1053-serialize-supervisor-hotspot-tasks](D-20260830-1053-serialize-supervisor-hotspot-tasks.md) — lib/supervisor.ts に集中するタスクは依存関係で直列化する
- [x] [D-20260830-1018-index-backfill-defer-to-reconcile](D-20260830-1018-index-backfill-defer-to-reconcile.md) — 決定インデックスの手作業バックフィルは取りやめ、main 側の人間のチェックを優先する
- [x] [D-20260830-1008-devcontainer-use-local-ccloop](D-20260830-1008-devcontainer-use-local-ccloop.md) — この開発 devcontainer は公開 feature をやめ checkout の bin/ccloop を使う
- [x] [D-20260830-1006-abort-retry-single-layer](D-20260830-1006-abort-retry-single-layer.md) — merge --abort の再試行は同期待機を最小限にし、待機の層を 1 つに保つ
- [x] [D-20260830-0947-index-reconcile-is-the-only-writer](D-20260830-0947-index-reconcile-is-the-only-writer.md) — 決定インデックスへの追記はローテーションのリコンサイルに一本化し、セッションの手作業をやめる
- [x] [D-20260830-0945-finish-interrupt-recovery-approach](D-20260830-0945-finish-interrupt-recovery-approach.md) — 後始末の中断は順序入れ替えではなく起動時復旧で塞ぐ
- [x] [D-20260830-0938-metrics-read-cap-limits](D-20260830-0938-metrics-read-cap-limits.md) — 実行ログの読み込み上限を末尾 512 KiB / 1000 行にする
- [x] [D-20260830-0932-test-branch-leak-scope](D-20260830-0932-test-branch-leak-scope.md) — テストのブランチ汚染対策は検出 + 作成経路の fail-closed に絞る
