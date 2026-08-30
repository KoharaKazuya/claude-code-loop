---
title: "ccloop の管理から外れた作業場所を検出して status に出す対応は見送る"
reversibility: high
review: HR-20260830-0825-topic-orphaned-worktree-invisible
createdAt: 2026-08-30T09:34:06.873Z
---

## 判断

人間が `agent/` 以外の名前へ変えるなどして ccloop の管理下から外れた worktree を検出し、
`ccloop status` の「要対応」に出す対応は**やらない**。今後この案を再提案しない。

## 理由

`HR-20260830-0825-topic-orphaned-worktree-invisible` で人間が「やらない」と回答した。

提案時に自分で挙げた懸念(人間が意図的に手元へ持ってきた作業場所まで「放置されています」と
表示してしまい、消してはいけないものを消させる方向に働きうる)と、
「この状態は人間が能動的に決まりを破ったときにしか起きない」という事実がそのまま結論になった形である。

## 影響範囲

`lib/supervisor.ts` の孤児ブランチ回収は、これまでどおり `agent/` の名前の決まりだけを
手がかりに動く。実在する worktree の一覧を真実として扱う方向へは進まない。
