---
title: "hook スクリプトのテストは hook の隣に置き、worktree.test.ts の重複ブロックは削除する"
reversibility: high
tasks: [T-20260830-0254-hook-scripts-regression-tests]
createdAt: 2026-08-30T03:20:00.000Z
---

## 判断内容

`lib/hooks/worktree-create.ts` のテストを追加する際、`lib/worktree.test.ts` の末尾に
同じ hook を子プロセス起動して検証する `describe` が既に存在することが分かった。
両方を残さず、カバレッジを `lib/hooks/worktree-create.test.ts` へ集約し、
`lib/worktree.test.ts` 側の重複ブロックを削除した。

## 理由

- hook スクリプトのテストは hook ファイルの隣にある方が発見しやすい。
  `lib/hooks/stop-check.test.ts` が既にその配置になっており、揃う。
- 同じ子プロセス起動フィクスチャが 2 箇所にあると、hook の入出力契約が変わったときに
  片方だけ直して「テストは通っているのに実態と食い違う」状態を作りやすい。
- `lib/worktree.test.ts` の責務は `lib/worktree.ts` の関数単体の検証であり、
  hook のグルーはその責務の外側にある。

## 検討した代替案

- 両方残す: 二重管理になる。削除側にしか無かったカバレッジ(`.agent/config.json` 未設置時に
  `lib/config.ts` の既定 worktreeDir を使うこと)は新ファイルへケースとして移したため、
  残す理由が無くなった。
- 逆に新ファイルを作らず `worktree.test.ts` 側を拡張する: hook のテストが
  `lib/worktree.ts` のテストファイルに埋もれ、上の理由と逆行する。

## 影響範囲

テストコードのみ。プロダクションコードは無変更。`lib/worktree.test.ts` の他の
`describe`(createWorktree / linkSharedPaths / salvagePatch など)には触れていない。
