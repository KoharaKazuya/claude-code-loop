---
title: "起動時回収の衝突テスト 2 件の期待値を retries から conflictRetries へ更新した"
reversibility: high
tasks: [T-20260830-1053-startup-recovery-conflict-uses-retries]
createdAt: 2026-08-30T11:41:41.519Z
---

## 判断内容

`lib/supervisor.test.ts` の `describe("recoverStartupIn")` にある衝突ケースのテスト 2 件
(worktree を残す衝突 / worktree が無くブランチを退避する衝突)の期待値を
`retries: 1` から `retries: 0` + `conflictRetries: 1` へ変更した。

## 理由

この 2 件は修正前の実装(起動時回収経路が `kind: "recovery"` をハードコードし `retries` を
消費していた)の挙動をそのまま固定していたもので、`D-20260830-0745-conflict-retry-separate-budget`
が定めた「マージ衝突は衝突専用の枠で数える」仕様とは食い違っていた。したがってこの更新は
テストを緩めて失敗を回避したものではなく、テストが誤った挙動を正としていたのを仕様に合わせた
ものである。アサーションは 1 本から 2 本に増えており、検証はむしろ強くなっている。

## 検討した代替案

既存テストを残したまま新しいテストを足すことも考えたが、同じ経路について矛盾する期待値が
2 つ並ぶことになり、どちらが仕様かが読めなくなるため採らなかった。

## 影響範囲

テストのみ。実装側は `recordStartupRecoveryNote` への `kind` 引数追加と、衝突検知経路
(クラッシュ再生経路を含む)から `"merge-conflict"` を渡す変更に閉じている。
