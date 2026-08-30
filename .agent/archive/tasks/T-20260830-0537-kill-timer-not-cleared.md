---
title: "タイムアウト後の強制終了タイマーが解除されず、無関係なプロセスを撃つ余地がある"
status: completed
priority: 4
retries: 0
note: "内側の SIGKILL タイマーを settle() で解除するようにした。自動テストは既存設計の改修が必要なため見送り"
createdAt: 2026-08-30T05:37:00.000Z
updatedAt: 2026-08-30T05:56:30.828Z
---

所属フェーズ: 4(思いつく改善すべて)。内部の修理であり、人間への確認は取らずに進めてよい。

## 何が起きているか

`runClaude`(`lib/supervisor.ts:1813-1823`)は、締め切りに達すると子プロセスグループへ
`SIGTERM` を送り、その 10 秒後に `SIGKILL` を送る二段構えのタイマーを仕掛ける。

外側のタイマー(`killTimer`)は `settle()`(同 1830-1838 行)で `clearTimeout` されるが、
内側の 10 秒 `setTimeout` は変数に保持されていないため解除できない。子プロセスが `SIGTERM` に
応じて 10 秒以内に素直に終了した場合(想定どおりの挙動)でも、10 秒後に同じ pid へ向けて
`process.kill(-pid, "SIGKILL")` が必ず発行される。

## 実害

通常は対象のプロセスグループが既に存在せず `ESRCH` になり、例外は握りつぶされるだけで無害。
ただし 10 秒の間にその pid がプロセスグループのリーダーとして再利用されていた場合、
**無関係なプロセスを強制終了する**。確率は低いが、起きたときの被害は大きく、しかも原因が
まったく追えない形で現れる。

コード読解による指摘であり、pid の再利用は実測で再現していない(意図的に起こすのが非現実的なため)。

## やること

1. 内側の `setTimeout` の戻り値を保持し、`settle()` で `clearTimeout` する。
   `unref()` の扱いは現状のままでよい。
2. 子プロセスが `SIGTERM` で終了した後に `SIGKILL` が飛ばないことをテストで担保できるか
   検討する。既存のテストは実プロセスを使う作りなので、タイマーを短くできる形に
   なっていなければ無理に作らず、その旨をタスクの `## 試行履歴` に書き残してよい。
3. 利用者から見た挙動は変わらないため `CHANGELOG.md` には載せない。

## 試行履歴

### 試行 1(2026-08-30T05:56:30.828Z, セッション記録)
- 確認済みの事実: `lib/supervisor.ts` の `runClaude` で内側の 10 秒 `setTimeout` を
  `forceKillTimer`(`NodeJS.Timeout | undefined`)に保持し、`settle()` の
  `clearTimeout(killTimer)` の直後に `clearTimeout(forceKillTimer)` を追加した。
  `unref()` はチェーンから分離しただけで呼び出し順は同じ。
  `npm run typecheck` / `npm run lint` / `npm test`(31 ファイル 977 件)すべて成功。
  reviewer サブエージェントは APPROVE(指摘なし)。`settle()` の呼び出し元は
  `child.on("close")` と `child.on("error")` の 2 経路のみで、`shuttingDown` の早期 return
  より前に解除されることを確認した。緊急停止側(`emergencyStop`)は独立した
  `killAllChildren` 経路なので影響なし。
- 未検証の推測: pid 再利用による誤射は実測で再現していない(意図的に起こすのが非現実的)。
  修正が実害を防ぐという因果はコード読解に基づく。
- 自動テストは見送った。理由(調査で確認した事実): `runClaude` は export されておらず
  テストファイルから呼べない。SIGKILL 猶予の 10 秒はハードコードで注入口がなく、
  このリポジトリに `vi.useFakeTimers` の使用例もない。テスト化には
  `runClaude` の export か猶予 ms の注入が必要で、これは「組み立ては純粋関数
  (`buildClaudeArgs`)としてテスト可能にし、実行側はテストしない」という既存の設計方針
  (`lib/supervisor.ts` の `buildClaudeArgs` 直上コメント)からの逸脱になる。タスク本文が
  「無理に作らず記録してよい」としているため見送った。
- 次の試行への提案: 将来テストしたくなった場合は、猶予 ms を `runClaude` の `opts` に
  追加して注入可能にし、`vi.spyOn(process, "kill")` で SIGKILL が呼ばれないことを
  確認する形が最も安定する(実プロセスの終了タイミングに依存しないため)。
