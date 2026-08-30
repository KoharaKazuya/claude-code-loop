---
title: "テストが親セッションの CLAUDE_AGENT_* を継承して失敗する問題を直す"
status: completed
priority: 1
dependencies: []
retries: 0
note: "lib/test-setup.ts で CLAUDE_AGENT_* を一括削除。自律実行セッション内の素の npm test で 767 件全通過"
createdAt: 2026-08-30T02:54:00.229Z
---

所属フェーズ: 現在フェーズ内の修理作業(自己ホスト環境で機械的検証が信用できない状態の解消)。新機能の追加ではない。

## 目的

このリポジトリは ccloop 自身で自律運用されているため、セッションの中で `npm test` を実行すると、
そのセッションが持つ環境変数(`CLAUDE_AGENT_SESSION_KIND` / `CLAUDE_AGENT_AUTONOMOUS` など)が
テストの子プロセスへそのまま漏れる。その結果、`lib/hooks/stop-check.test.ts` の 3 件が
自律実行セッション内でだけ失敗する。

- 原因: `lib/hooks/stop-check.test.ts:37-46` の `runStopCheck` が子プロセスの env を
  `{ ...process.env, CCLOOP_REPO, CLAUDE_AGENT_TASK_ID }` として組み立てており、
  親セッションの `CLAUDE_AGENT_SESSION_KIND` を消していない。
- 症状: 検証対象の `lib/hooks/stop-check.ts:24` が「探索セッションなら即 exit 0」で早期終了するため、
  exit 2 を期待するケースが 0 を受け取り、fail-open 時の stderr も空になる。
- 確認済み: `env -u CLAUDE_AGENT_SESSION_KIND -u CLAUDE_AGENT_AUTONOMOUS npm test` で 6/6 通過する。
  つまり実装 `stop-check.ts` 側は正しく、テストの環境分離が不十分なだけである。

これは人間の導線に直接響く。`stop-check` は「タスクセッションが担当タスクファイルを更新せずに
終了しようとしたら差し戻す」機構であり、`ccloop status` が最新状況を映すことを担保する唯一の
仕掛けである。そのテストが自己ホスト環境で常に赤いままだと、本物の退行が入っても
「いつもの失敗」として見逃される。加えて、全セッションが着手前に見る `npm test` が
常時 3 件失敗している状態は、絶対ルール 3(検証を通してから完了にする)の判断を鈍らせる。

## 対象

- `lib/hooks/stop-check.test.ts`(直接の原因)
- 同種のパターンを持つ他のテスト: `lib/supervisor.test.ts:3128` / `:3191`、`lib/worktree.test.ts:403`。
  いずれも `{ ...process.env }` を基点にしているので、`CLAUDE_AGENT_*` の継承で
  挙動が変わりうるかを確認し、変わるなら同じ対策を適用する(変わらないなら触らない)。

## 完了条件

- 自律実行セッションの中(`CLAUDE_AGENT_SESSION_KIND` などが設定された状態)で `npm test` を
  実行しても全件通過する。
- 対策は個別テストへの場当たり的な `delete` の散在ではなく、テスト側で
  「`CLAUDE_AGENT_*` を継承しない子プロセス env を作る」共通ヘルパー、または
  `lib/test-setup.ts` での一括除去のいずれかで、意図が読み取れる形にする。どちらを採るかは
  実装時に判断し、理由を `.agent/decisions/` に残す。
- 実装 `lib/hooks/stop-check.ts` の挙動(探索セッションでの早期 exit)は変更しない。
  これは仕様どおりであり、テストを通すために実装を緩めてはならない(絶対ルール 4)。
- `npm run typecheck` / `npm run lint` / `npm run test` が通る。
- 検証手順として「自己ホスト環境では親セッションの env が漏れる」という制約を docs/ の
  適切な箇所へ反映する(テストを書く人が同じ罠を踏まないため)。掲載可否は docs/ 運用ルールに従う。
