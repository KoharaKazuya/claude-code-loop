---
title: "探索・triage セッションの起動失敗が未捕捉例外になり ccloop run ごと落ちる"
status: ready
priority: 4
dependencies: []
retries: 0
createdAt: 2026-08-30T05:58:51.146Z
---

所属フェーズ: 4(思いつく改善すべて)。堅牢性の修理であり、人間への確認は取らずに進めてよい。

## 何が起きているか

`runClaude`(`lib/supervisor.ts` 1781 行)は `new Promise((resolve) => { spawn(...) })` の形で、
executor 内で `spawn` を呼ぶ。executor 内の同期 throw はそのまま Promise の reject になる。

この reject の扱いが経路によって違う。

- タスクセッション経路: `launchTaskSession`(3195 行付近)が `started.result.then(onFulfilled, onRejected)`
  で reject を受け、`crashResultFromError` で「クラッシュ扱いの結果」に変換する。ループは継続する。
- 探索セッション経路(`runExploreSession` 2791 行の `try`)と triage 経路(4181 行付近): どちらも
  `try { ... } finally { ... }` で catch を持たない。`mainLoop` のループを包む try にも catch が無く、
  `lib/cli.ts:175` の `case "run"` にもトップレベル(202 行)にも catch が無い。
  よって reject は未捕捉例外となり、`ccloop run` プロセスがスタックトレースを吐いて落ちる。

## 実害

探索・triage セッションの起動が何らかの理由(claude 実行ファイルが消えている、実行権限が無い、
`spawn` のオプションが不正など)で失敗すると、その 1 セッションの失敗では済まず自律ループ全体が
停止する。タスクセッションでは同じ失敗が吸収されるので、経路による扱いの差がそのまま堅牢性の差に
なっている。

なお `claudeCommand` が undefined だったことによる `TypeError` は config の検証追加で塞がっており、
現時点で再現手順が確認できている経路は無い(コードを読んで catch が無いことを確認した段階)。
そのため優先度は低い。

## やること

1. 探索セッション経路と triage 経路の `runClaude` 呼び出しについて、reject をタスクセッション経路と
   同じ扱い(`crashResultFromError` 相当のクラッシュ結果へ変換し、ログを出してループを継続する)に
   寄せる。経路ごとに違う扱いをしないことを目的とする。
2. `spawn` の失敗を注入するテストを足し、`mainLoop` が落ちずに次の周回へ進むことを検証する。
3. 利用者から見た挙動が変わる(ループが落ちなくなる)ため、`CHANGELOG.md` の「## 未リリース」に
   1 行足す。

## 試行履歴
