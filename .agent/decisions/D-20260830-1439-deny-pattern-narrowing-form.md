---
title: "deny の狭め方は空白の前置とサブコマンド列挙で行う"
reversibility: high
tasks: [T-20260830-1407-narrow-readonly-git-deny-patterns]
createdAt: 2026-08-30T14:39:48.283Z
---

## 判断内容

`lib/settings.template.json` の deny を狭めるにあたり、次の 2 方式を使い分けた。

- `git merge`: `Bash(git merge)`(完全一致)と `Bash(git merge *)`(空白を前置)の 2 本に分割
- `git worktree` / `git stash`: 包括パターンを廃止し、変更を伴うサブコマンドを個別に列挙

## 理由(Claude Code のパターン照合規則)

claude-code 2.1.220 のバイナリ内実装を読んで確認した規則:

- `*` を含まないパターンは**完全一致**(前方一致にはならない)
- `<prefix>:*` は語境界つきの前方一致(ヘルプ文言では "legacy" と表記)
- それ以外の `*` は `.*` に開いた全体 anchor つき正規表現で、**語境界を強制しない**。
  これが `Bash(git merge*)` が `git merge-base` まで巻き込んでいた原因
- deny は `&&` `;` `|` で連結された複合コマンドの**各パーツごと**に評価される
- **否定(除外)パターンは存在しない**。deny は allow に優先し、allow で deny を打ち消せない

実機に設定を読ませての動作確認まではしていない。

## 検討した代替案

- `Bash(git merge:*)`(colon-star): 語境界つき前方一致で意図は最も明確だが、ヘルプ文言が
  "legacy" と呼んでおり、将来削除されると deny が黙って外れる。採用せず。
- `Bash(git merge *)` 1 本だけ: 実装には「末尾が空白 + `*` なら省略可能扱い」の特例があるように
  読めたが確度が落ちる。特例が無くても引数なしの `git merge` を取りこぼさないよう、完全一致の
  1 本を併記した。`git stash` も同じ理由で `Bash(git stash)` を別に持つ。
- `git worktree` / `git stash` を 1 本のまま `list` だけ除外: 否定パターンが無いため不可能。

## 影響範囲

列挙方式は、git が将来新しい変更系サブコマンドを追加した場合に追随が必要になる(取りこぼしても
deny が緩むだけで、PROMPT.md の絶対ルールという二重の担保は残る)。緩めすぎの検知は
`lib/deny-consistency.test.ts` の `MUST_STAY_DENIED` が担う。同ファイルの `matchesDenyPattern` は
本家より**厳しい**側に倒した近似であり、そこで deny と判定できるものは本家でも確実に禁止される。
