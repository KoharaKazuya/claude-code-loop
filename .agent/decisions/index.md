# 決定インデックス

チェック `[x]` を付けた決定は、次回ローテーションでアーカイブされる。

- [ ] [D-20260830-1018-index-backfill-defer-to-reconcile](D-20260830-1018-index-backfill-defer-to-reconcile.md) — 決定インデックスの手作業バックフィルは取りやめ、main 側の人間のチェックを優先する
- [ ] [D-20260830-1008-devcontainer-use-local-ccloop](D-20260830-1008-devcontainer-use-local-ccloop.md) — この開発 devcontainer は公開 feature をやめ checkout の bin/ccloop を使う
- [ ] [D-20260830-1006-abort-retry-single-layer](D-20260830-1006-abort-retry-single-layer.md) — merge --abort の再試行は同期待機を最小限にし、待機の層を 1 つに保つ
- [ ] [D-20260830-0947-index-reconcile-is-the-only-writer](D-20260830-0947-index-reconcile-is-the-only-writer.md) — 決定インデックスへの追記はローテーションのリコンサイルに一本化し、セッションの手作業をやめる
- [ ] [D-20260830-0938-metrics-read-cap-limits](D-20260830-0938-metrics-read-cap-limits.md) — 実行ログの読み込み上限を末尾 512 KiB / 1000 行にする
- [ ] [D-20260830-0932-test-branch-leak-scope](D-20260830-0932-test-branch-leak-scope.md) — テストのブランチ汚染対策は検出 + 作成経路の fail-closed に絞る
