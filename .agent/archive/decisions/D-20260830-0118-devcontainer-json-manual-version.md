---
title: ".devcontainer/devcontainer.json のバージョン同期を廃止し手動更新にする"
reversibility: high
createdAt: 2026-08-30T01:18:49.923Z
---

`scripts/sync-version.mjs` / `scripts/check-version.mjs` の同期・検証対象から
`.devcontainer/devcontainer.json` 中の ccloop feature 参照を外した。今後この参照と
`.devcontainer/devcontainer-lock.json` はユーザーが手動で(同じタイミングで揃えて)更新する。

理由:

- `.devcontainer/devcontainer-lock.json` の digest は GHCR への publish 後にしか確定しない。
  `npm version` の時点(publish 前)で devcontainer.json だけ新バージョンに自動更新すると、
  lock は旧バージョンのまま残り、release のたびに devcontainer.json と lock が食い違う差分が
  必ず発生していた。
- CI(release ワークフロー)で publish 後に lock を自動追従させる案も検討し一時的に実装したが、
  ワークフローへの書き込み権限やタイミング調整の複雑さに見合わないと判断し不採用とした。
- 結果として、devcontainer.json の参照と lock を同じタイミングで手動更新するシンプルな運用を
  選んだ。両者は元々ユーザーが目視で対応関係を確認しながら揃える必要があり、自動化の恩恵より
  複雑さのほうが大きかった。

影響範囲: `scripts/version-files.mjs` から `DEVCONTAINER_JSON_RELATIVE` /
`readDevcontainerVersions` を削除し、`scripts/check-version.mjs` の検証対象を
package.json / devcontainer-feature.json / README.md の 3 箇所に縮小した。`package.json` の
`version` スクリプトの `git add` 対象からも `.devcontainer/devcontainer.json` を外した。
`docs/compatibility.md`(feature のタグ運用)と `docs/architecture.md`(公開 feature 経由で
ccloop を使う理由)の記述もこの実態に合わせて更新済み。
