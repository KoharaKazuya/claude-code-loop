---
title: "テストの env 分離は setupFiles での CLAUDE_AGENT_* 一括削除で行う"
reversibility: high
tasks: [T-20260830-0254-test-env-isolation-session-vars]
createdAt: 2026-08-30T03:04:21.950Z
---

## 判断内容

テストが実行元セッションの `CLAUDE_AGENT_*` を継承して被テストコードの分岐を変えてしまう問題を、
vitest の setupFiles(`lib/test-setup.ts`)で `CLAUDE_AGENT_` 接頭辞の環境変数を
`process.env` から一括削除することで解決した。個別テストごとの `delete` や、
子プロセス env を組み立てる共通ヘルパーの導入は採らなかった。

## 理由

- setupFiles は既に `XDG_STATE_HOME` の差し替えで「テストプロセスの env を実行環境から
  切り離す」責務を持っており、同じ責務の追加として置き場所が自然である。
- 共通ヘルパー方式は、テストが `{ ...process.env }` を書くたびにヘルパーの使用を
  各テスト作者が思い出す必要があり、新しいテストで漏れる。setupFiles なら既定で全テストに効く。
- 削除は冪等で、リポジトリ内に `process.env.CLAUDE_AGENT_*` へ代入するコードは無い
  (spawn 用の env オブジェクト構築のみ)ため、テスト間の副作用は生じない。
  vitest の既定 pool は `forks` + `isolate: true` なので並列実行時の競合もない。

## 検討した代替案

- 個別テストで `delete` する: 散在して意図が読み取りにくく、同じ罠を再度踏む。
- 実装 `lib/hooks/stop-check.ts` の早期 exit を変えてテストを通す: 仕様どおりの挙動であり
  検証を弱めることになるため却下(絶対ルール 4)。

## 影響範囲

`lib/test-setup.ts` のみ。`lib/supervisor.test.ts` の個別 `delete` は実行上は冗長になったが、
`runHook` が「Supervisor が渡す env だけを明示的に与える」という意図を示す記述として残した。
背景は `docs/architecture.md` の「テスト実行元セッションの環境変数を継承しない理由」に記載した。
