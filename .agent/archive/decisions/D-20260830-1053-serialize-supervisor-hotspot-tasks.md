---
title: "lib/supervisor.ts に集中するタスクは依存関係で直列化する"
reversibility: high
tasks: [T-20260830-1053-status-parked-branch-merged-state, T-20260830-1053-status-config-schema-outdated, T-20260830-0934-startup-recovery-crash-leaves-no-trace]
createdAt: 2026-08-30T10:53:39.546Z
---

## 判断

`lib/supervisor.ts` を編集することが確実なタスク同士に `dependencies` を張り、並列に走らないようにする。
今回張った鎖は 2 本。

- 後始末・起動時復旧の系統: `T-20260830-1053-rescue-finish-interrupt-recovery-work`
  → `T-20260830-0934-startup-recovery-crash-leaves-no-trace`
  → `T-20260830-1053-startup-recovery-conflict-uses-retries`
- `ccloop status` の表示の系統: `T-20260830-1007-status-respect-decision-checkbox`
  → `T-20260830-1053-status-config-schema-outdated`
  → `T-20260830-1053-status-parked-branch-merged-state`

## 理由

`lib/supervisor.ts` は 5617 行あり、直近 24 時間で 84 コミットが入っている単一のホットスポットである。
`ccloop status` の表示組み立ても後始末も起動時復旧もすべてこのファイルに同居しているため、
並列 4 セッションが走ると**ほぼ確実に全員が同じファイルを編集する**。

実際、マージ衝突で `failed` に落ちたタスクがこれまでに 4 件出ている
(`T-20260830-0537` / `T-20260830-0621` / `T-20260830-0808-conflict-session-timeout-mislabeled` /
`T-20260830-0829-finish-crash-leaves-no-trace`)。うち 3 件は成果が退避ブランチに取り残され、
救出タスクを別途起こす羽目になった。**衝突は個別セッションの不手際ではなく並列度と
ファイル構成に起因する構造的な問題**と判断した。

## 検討した代替案

- **並列セッション数を下げる**(`.agent/config.json` の `parallel.maxSessions`)。
  効果は確実だが、設定ファイルの編集はセッションの権限外(deny)であり、
  かつ衝突しないタスクまで一律に遅くなる。採らない。
- **`lib/supervisor.ts` を分割する**。根本的だが、分割そのものが全タスクと衝突する巨大な変更に
  なるうえ、利用者から見た挙動が変わらないため単独では優先度を上げにくい。今回は見送る。
- **スケジューラ側で「同じファイルを触りそうなタスクを同時に選ばない」仕組みを入れる**。
  タスク側に触るファイルの申告を持たせる案。利用者から見た挙動が変わるためフェーズ 4 の
  個別確認が要る。`HR-20260830-1053-topic-conflict-prone-parallelism` で確認に出した。

## 影響範囲

`.agent/tasks/` の frontmatter のみ。鎖の途中のタスクが `failed` になると後続が待たされるが、
その状態は `ccloop status` に出るので気づける。不要になったら `dependencies` を空に戻せばよい(可逆)。
