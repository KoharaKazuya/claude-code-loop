---
title: "status が不正なタスクファイルは「要対応」節の 1 セクションとして出す"
reversibility: high
tasks: [T-20260830-0602-invalid-task-status-silently-dropped]
createdAt: 2026-08-30T06:14:21.637Z
---

## 判断内容

frontmatter の `status` が語彙外でタスクとして読めなかったファイルを、`StatusData.invalidTaskFiles`
として構造化データに載せ、`formatStatus()` では「要対応」節の 1 セクション(blocked タスクの直後)に
ファイル名を並べる。あわせて `collectStatusData` 経由の読み込みは `warn: false` にし、
`ccloop status` / `ccloop watch` から `console.log` の警告行が出ないようにした。
除外して集計から外す挙動自体(クラッシュ回避)は変えていない。

## 理由

- `watch` は毎フレーム画面をクリアするため、`formatStatus()` の返す文字列の外側に出した情報は残らない。
  構造化出力に載せることが必須要件だった。
- 専用の見出しを新設せず既存の「要対応」節に混ぜたのは、人間が最初に見る場所を 1 か所に保つため。
  壊れたタスクファイルは blocked / failed と同様「人間が手で直すまで進まない」種類の事象であり、
  同じ節に並ぶのが自然。
- `warn: false` にしたのは、構造化出力に出るようになった以上、描画直前に消える stray な出力を
  増やす意味がないため。ループ本体(`ccloop run`)は引き続き `loadTasks()`(`warn: true`)を通るので、
  ログ側の警告は残る。
- 案内文の有効な値は `TASK_STATUSES` から生成する。ハードコードすると語彙が増減したときに
  メッセージだけ陳腐化する。

## 検討した代替案

- 進捗バーの分母に不正ファイルも数える: 分母が「読めたタスク」を意味しなくなり、
  他の集計(次に走るタスク・依存解決)との母集団のずれが表に出る。採らない。
- 専用セクション(「壊れたファイル」など)を新設する: 節が増えるだけで、対応の緊急度は
  blocked と同程度。採らない。

## 影響範囲

`lib/supervisor.ts` の `loadTasksFrom`(戻り値が `{ tasks, invalidFiles }` に変わる)、
`StatusData`(`invalidTaskFiles` 追加 = `ccloop status --json` の出力も変わる)、`formatStatus`。
