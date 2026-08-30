---
title: "条件付きアサーションで素通りしうるテストを確実に検証させる"
status: completed
priority: 3
dependencies: []
retries: 0
note: "分岐化で素通り経路を解消。横断調査で見つかった supervisor.finish.test.ts の空虚なアサーション 1 件も併せて修正"
createdAt: 2026-08-30T13:46:18.783Z
updatedAt: 2026-08-30T13:53:36.403Z
---

所属フェーズ: 4(思いつく改善すべて)。テストの検証強化に当たるため人間の確認は不要
(`D-20260830-0303-phase4-consent-granularity` の「確認を取らない」側)。

## 背景

`lib/paths.test.ts:107-119` の `it("cwd から上方に .git が無ければエラーにする")` は、
`resolveRepoRoot` の呼び出しを try/catch で包み、`if (thrown !== null) expect(thrown).toBeInstanceOf(...)`
という**条件付きアサーション**だけを行っている。例外が投げられなかった場合はアサーションが
一度も実行されず、テストはそのまま成功する。

このリポジトリは `expect.hasAssertions()` 相当の強制を入れていない(`lib/test-global-setup.ts` に
該当設定なし)ため、アサーション 0 回でも失敗にならない。つまりテスト名が主張している
「エラーにする」ことを実際には保証していない。

テスト自身のコメントが理由を述べているとおり、素直に書けない事情がある。一時ディレクトリの
祖先に `.git` が存在するかどうかを制御できないため、`resolveRepoRoot` が上方探索で
リポジトリを見つけてしまう可能性を排除できない。現在の環境ではたまたま例外が投げられている
と思われるが、それはテストが保証している事柄ではない。

## やること

1. 当該テストを、**どの環境でも必ず 1 回以上アサーションが実行される**形に書き換える。
   環境依存を消せないなら、消せないこと自体をテスト側で明示的に分岐させ、どちらの経路でも
   期待値を検証する形にする(例: 探索起点の祖先に `.git` があるかを先に判定し、ある場合は
   「そのリポジトリのルートに解決されること」を、無い場合は「`RepoRootNotFoundError` を投げること」を
   それぞれ検証する)。方式は着手セッションが判断してよいが、**どちらに転んでも何も検証しない
   経路が残らないこと**を必ず満たす。
2. 同種の弱いアサーション(`if (...) expect(...)` のように条件付きで期待値を検証している箇所)が
   他の `.test.ts` にも無いか確認し、あれば併せて直す。無ければ「無かった」ことを試行履歴に書く。
3. `expect.hasAssertions()` をグローバルに強制する案は**採らないこと**。既存 1215 件への影響が
   読めず、このタスクの範囲を超える。必要だと判断したなら別タスクとして登録する。

## 完了条件

- 当該テストが、例外が投げられない経路でも必ず何かを検証する形になっていること。
- `npm test` / lint / typecheck が通ること。
- 検証を弱める方向の変更(テストの削除、期待値の緩和)をしていないこと。

## 注意

- 利用者から見た挙動は変わらないので `CHANGELOG.md` には追記しない。
- 触るのは `lib/paths.test.ts`(および他に同種箇所があればそのテストファイル)のみ。
  `lib/paths.ts` の実装を変える必要は無いはずで、変えたくなった場合は理由を
  `.agent/decisions/` に記録すること。

## 試行履歴

### 試行 1(2026-08-30T13:53:36.403Z, セッション記録)

- 確認済みの事実:
  - `lib/paths.test.ts` の当該テストを分岐構造へ書き換えた。`findGitRoot(orphan)` が `null` なら
    `toThrow(RepoRootNotFoundError)`、非 null なら `resolved !== orphan` と
    `findGitRoot(resolved) === resolved` を検証する。どちらの経路でもアサーションが 1 回以上走る。
  - else 側が同語反復でないことを実装で確認: `mainWorktreeRoot` は `.git` を持たない候補を返す
    全経路を潰している(`lib/paths.ts:99` の `if (!hasGitEntry(candidate)) return dir`)ため、
    `findGitRoot(resolved) === resolved` は実装の不変条件であり flaky にならない。
  - 両分岐を実測。現環境では `findGitRoot(orphan)` が `null` を返し throw 側が実行される。
    一時ディレクトリの祖先に `.git` を作った状態では else 側の 2 アサーションが真になる。
  - 横断調査(全 34 テストファイル)の結果、`if (...) expect(...)` 型の素通り箇所は他に無かった。
    ただし別種の空虚なアサーションを 1 件発見し修正した: `lib/supervisor.finish.test.ts:547` の
    `expect(state.rateLimit?.resumeAt).not.toBeNull()` は、`rateLimit` フィールド自体が
    書かれていない場合 `undefined` となり通過してしまう。`toBeDefined()` と
    `typeof ... === "string"` の 2 段に分けた。同型の箇所は grep でこの 1 件のみ。
  - `lib/liveness.test.ts` の `if (result.allow) expect(...)` 5 箇所は、直前行で
    `expect(result.allow).toBe(...)` を実行済みの上での型 narrowing 用であり、素通りしない。未修正。
  - `npm test` 1215 件成功 / `npm run lint` 成功 / `npm run typecheck` 成功。
  - reviewer サブエージェントのレビュー結果は APPROVE、重大・軽微いずれの指摘も無し。
- 未検証の推測: 無し(`expect.hasAssertions()` の全体強制は指示どおり採用せず、別タスクの登録も
  不要と判断した。横断調査で素通り箇所が 2 件しか無く、強制導入の費用対効果が低いため)。
- 次の試行への提案: 無し(完了)。
