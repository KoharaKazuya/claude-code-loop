---
title: "init が同名ファイルとの衝突で素の例外を吐き、半端な .agent/ を doctor が正常と判定する"
status: completed
priority: 4
dependencies: []
retries: 0
note: "planInit がパス種別の衝突を事前検出して何も書かずに止まるようにし、doctor が衝突・雛形不足・.gitignore 記載漏れを報告するようにした"
createdAt: 2026-08-30T06:02:18.660Z
updatedAt: 2026-08-30T06:24:44.067Z
---

所属フェーズ: 4(思いつく改善すべて)。壊れているものの修理なので、フェーズ 4 の個別確認は不要。

## 目的

`.agent/` 雛形の配置が、期待するディレクトリ名と同名のプレーンファイルに衝突したとき、
素の Node スタックトレースで落ちて中途半端な `.agent/` を残し、しかも `ccloop doctor` が
それを正常と判定する問題を直す。「doctor は正常と言うのに動かない」という
最も診断しづらい状態が残る。

## 現象(調査で実挙動確認済み)

`.agent/tasks` や `.agent/decisions`、あるいは `.agent` 自体がプレーンファイルとして
存在する状態で `ccloop init`(または他コマンドからの自動 `ensureAgentDir`)を実行すると:

- `applyInit` 内の `fs.mkdirSync(path.dirname(dest), {recursive: true})`
  (`lib/init.ts:135-145` 付近)が `EEXIST` を投げる
- `cmdInit` / `ensureAgentDir` のどちらにも try/catch が無く `cli.ts` にも
  トップレベルの catch が無いため、素のスタックトレースで落ちる
- 実測では `GOAL.md` / `OVERVIEW.md` / `config.json` / 一部の `.gitkeep` までは書き込まれ、
  `tasks/.gitkeep` と `.gitignore` の追記が行われないまま停止した
- `isAgentDirReady` は `GOAL.md` と `config.json` の存在だけで判定するため、以後
  `ensureAgentDir` はこのリポジトリを「配置済み」とみなし二度と修復を試みない
- `ccloop doctor` の `checkAgentDir`(`lib/doctor.ts:96-127` 付近)も同じ 2 ファイルの
  存在しか見ないため、全項目 ✓ を返しうる
- 再実行しても毎回同じ例外を吐くだけで自己修復しない

## 完了条件

- 配置先のパスに期待と異なる種別(ディレクトリを期待する場所にファイル、逆も同様)が
  あることを検出し、**どのパスが衝突しているかと対処方法を示す分かりやすいエラー**で
  安全に止める。既存ファイルを上書きしない現在の方針は維持する
- 部分適用をロールバックするかどうかは実装者が決めてよい。決めた理由を
  `.agent/decisions/` に短く記録する
- `ccloop doctor` がこの不整合(雛形が期待するディレクトリがディレクトリでない、
  必要な `.gitkeep` や `.gitignore` の追記が欠けている)を検出して報告する
- 上記 2 点の回帰テストを追加する
- typecheck / lint / test が通る
- 利用者から見た挙動が変わるので `CHANGELOG.md` の「## 未リリース」節に 1 行足す

## 補足

発生条件は稀(利用者が `.agent/tasks` という名前のファイルを置いた場合など)だが、
一度踏むと自己修復せず診断も効かないため、実害は小さくない。

## 試行履歴

### 試行 1(2026-08-30T06:24:44.067Z, セッション記録)
- 確認済みの事実: コミット c20ab36。`lib/init.ts`(`planInit` に `conflicts` 検出、`applyInit` /
  `runInit` / `ensureAgentDir` で書き込み前に停止、`isAgentDirReady` を雛形の完全性判定へ変更)、
  `lib/doctor.ts`(衝突・雛形不足・`.gitignore` 記載漏れの報告)、`lib/init.test.ts` +5 件・
  `lib/doctor.test.ts` +3 件、`lib/cli.test.ts` の beforeEach 調整、`CHANGELOG.md` 1 エントリ。
- 確認済みの事実: `npm run typecheck` / `npm run lint` / `npm run test`(1012 件)すべて成功。
  実バイナリでの手動確認も実施し、`.agent/tasks` がファイルの状態で `ccloop init --yes` が
  スタックトレースを出さず何も書かずに exit 1、`ccloop doctor` が同内容を ✗ で報告(exit 1)、
  `tasks/.gitkeep` 欠落・`.gitignore` 記載漏れも ✗ で検出、再 `init` で自己修復することを確認。
- 確認済みの事実: `fs.lstatSync` は `throwIfNoEntry: false` でも祖先が非ディレクトリのとき
  `ENOTDIR` を投げる(`fs.statSync` は握りつぶす)。`lib/init.ts` の `entryKind` で捕捉している。
- 確認済みの事実: 部分適用のロールバックは実装しない判断を
  `.agent/decisions/D-20260830-0622-init-conflict-no-rollback.md` に記録した。
