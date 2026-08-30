---
title: "マージ衝突の解消は main 先端との差分アンカーを避けて行う"
reversibility: high
tasks: [T-20260830-0602-status-shows-dead-session-running, T-20260830-0621-conflict-retry-always-reconflicts]
createdAt: 2026-08-30T07:30:16.099Z
---

## 判断内容

T-20260830-0602-status-shows-dead-session-running の衝突解消(3 回目の試行)で、
単に目の前の衝突マーカーを消すのではなく、セッション終了後の main 先端とのマージで
再衝突しない形に解消した。

- `.agent/decisions/index.md`: 両ブランチが追加した決定の行を両方残した(main 側は
  マージ基点 54d902f 以降この ファイルを変更していないため、これで再衝突しない)
- `CHANGELOG.md`: main 側が「未リリース」節の末尾(自分の項目と同じ挿入位置)に追記
  していたため、自分の項目を節の中ほど(挿入アンカーが重ならない位置)へ移した
- 自タスクファイル: frontmatter は branch 側(completed)を基本にしつつ、Supervisor 管理の
  `retries` は main 側の実測値 2 を採った。main 側が追記した試行履歴も取り込んだ

## 理由(根因の発見)

稼働中の Supervisor はインストール版 ccloop 0.4.1 であり、機械的に解消できる衝突は
自タスクファイルのみ。ソースにある `decisions/index.md` の 3-way 自動解決
(c0f78b0)は未リリースで、index.md や CHANGELOG.md が衝突すると全体が substantive
扱いになりマージが失敗する。試行 1・2 の失敗はこれが根因。よって「解消後の内容が
main 先端との次のマージで衝突しないこと」まで確認する必要があった。

## 影響範囲

このリポジトリで次のリリースが出るまで、衝突解消セッションは同じ配慮が必要。
T-20260830-0621-conflict-retry-always-reconflicts(衝突リトライが毎回再衝突する問題)の
実装時にはこの制約(インストール版と ソースの乖離)も考慮すること。
