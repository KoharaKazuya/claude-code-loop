---
title: "衝突ブランチに取り残された「失敗理由の優先順」の成果を main へ取り込む"
status: completed
priority: 1
dependencies: []
retries: 0
note: "退避ブランチの成果(classifyTaskSessionResult の切り出しと単体テスト、判断記録、CHANGELOG)を取り込んだ。typecheck/lint/test(1099 件)通過"
createdAt: 2026-08-30T09:34:06.873Z
---

所属フェーズ: 4(思いつく改善すべて)。

## 目的

タスク `T-20260830-0808-conflict-session-timeout-mislabeled` は 3 回の試行がすべてマージ衝突で
失敗し `failed` になったが、**実装は完成しており**退避ブランチに残っている。これを main へ
取り込む。放置すると退避ブランチが削除された時点で成果が失われる。

先例が 2 件ある(`T-20260830-0621-rescue-max-turns-work` /
`T-20260830-0825-rescue-conflict-retry-work`)。同じ手順が使える。

## 対象

退避ブランチ: `agent/conflict/T-20260830-0808-conflict-session-timeout-mislabeled-20260830T092322Z`

main 分岐後 4 コミット。差分の内訳(調査済み):

- `lib/supervisor.ts`(+174 行) — `finishTaskSession` にベタ書きだった失敗理由の if/else 連鎖を
  純関数 `classifyTaskSessionResult`(`TaskSessionVerdict` を返す)として切り出し、判定順序を
  **レートリミット → 衝突未解消(mergeStuck) → タイムアウト → それ以外** に修正する。
  衝突未解消をタイムアウトより先に判定することで、両方成立したときに「衝突を解消せよ」という
  正しい申し送りが残る(タイムアウトだった事実は reason の末尾に併記)。
- `lib/supervisor.test.ts`(+147 行) — `classifyTaskSessionResult` の単体テスト。
  レートリミット + 衝突 + タイムアウトが同時成立するケースを含む。
- `.agent/decisions/D-20260830-0825-failure-kind-priority-order.md` — 優先順を決めた判断記録。
- `.agent/decisions/index.md` / `CHANGELOG.md` / 当該タスクファイルの更新。

## 完了条件

- 上記の成果が main に入っている(3-way マージまたは手作業での再適用)。
- `npm run` の typecheck / lint / test が通る。
- `T-20260830-0808-conflict-session-timeout-mislabeled` の `note` に取り込み済みである旨を書く
  (当該タスクは `failed` のままでよい。既に実行中セッションは無い)。
- `.agent/decisions/index.md` に取り込んだ判断記録の行がある。

## 注意(統合時の衝突点)

退避ブランチが分岐した後、main 側に「衝突リトライを本来の retries と別枠にする」実装が入っており、
`recordFailure` のシグネチャが変わっている(`maxConflictRetries` を要求するようになった。
`lib/supervisor.ts` の `fail` クロージャ付近)。退避ブランチ側の `recordFailure` 呼び出しは
旧シグネチャのままなので、**単純なマージでは通らない**。`classifyTaskSessionResult` が返す
失敗種別を main 側の新シグネチャへ配線し直すこと。

なお 3 回の失敗はすべて別枠化が main に入る前(2026-08-30T09:24:29Z 以前)に起きており、
別枠化の不具合ではないことを確認済み。この救出後は同種の事故は起きにくくなっているはずである。

## 試行履歴
