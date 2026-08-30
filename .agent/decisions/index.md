# 決定インデックス

チェック `[x]` を付けた決定は、次回ローテーションでアーカイブされる。

- [ ] [D-20260830-0934-running-task-file-guard-declined](D-20260830-0934-running-task-file-guard-declined.md) — 実行中タスクの記録ファイルへの書き込みを仕組みで拒否する対応は見送る
- [ ] [D-20260830-0934-orphaned-worktree-detection-declined](D-20260830-0934-orphaned-worktree-detection-declined.md) — ccloop の管理から外れた作業場所を検出して status に出す対応は見送る
- [ ] [D-20260830-0825-cross-repo-ratelimit-declined](D-20260830-0825-cross-repo-ratelimit-declined.md) — 利用上限の待機状態をリポジトリ間で共有する対応は見送る
- [ ] [D-20260830-0825-fatal-stop-record-declined](D-20260830-0825-fatal-stop-record-declined.md) — ループの異常停止を status に残す対応は見送る
- [ ] [D-20260830-0812-keep-attempt-history-after-fix](D-20260830-0812-keep-attempt-history-after-fix.md) — 衝突リトライ別枠化の後は解消セッションも試行履歴を残してよい
- [x] [D-20260830-0801-ratelimit-under-timeout-evidence](D-20260830-0801-ratelimit-under-timeout-evidence.md) — タイムアウトに隠れた利用上限は stderr の文言だけを根拠に判定する
- [x] [D-20260830-0757-split-hint-covers-max-turns](D-20260830-0757-split-hint-covers-max-turns.md) — 分割を促す申し送りは時間切れとターン上限の両方に出す
- [ ] [D-20260830-0746-changelog-union-merge](D-20260830-0746-changelog-union-merge.md) — CHANGELOG.md は .gitattributes の union マージで自動解決する
- [ ] [D-20260830-0745-conflict-retry-separate-budget](D-20260830-0745-conflict-retry-separate-budget.md) — マージ衝突の再試行はタスク本来のやり直し回数と別枠にする
- [x] [D-20260830-0730-conflict-resolution-anchor-strategy](D-20260830-0730-conflict-resolution-anchor-strategy.md) — マージ衝突の解消は main 先端との差分アンカーを避けて行う
- [x] [D-20260830-0618-stopped-loop-running-sessions-display](D-20260830-0618-stopped-loop-running-sessions-display.md) — ループ停止時の「実行中のタスク」節は経過時間を出さず記録扱いで表示する
- [x] [D-20260830-0614-invalid-task-files-in-action-section](D-20260830-0614-invalid-task-files-in-action-section.md) — status が不正なタスクファイルは「要対応」節の 1 セクションとして出す
- [x] [D-20260830-0546-is-error-treated-as-failure](D-20260830-0546-is-error-treated-as-failure.md) — 結果 JSON の is_error は失敗として扱い、ターン上限は専用の種別に分ける
- [x] [D-20260830-0439-liveness-unreadable-record](D-20260830-0439-liveness-unreadable-record.md) — 生存記録の壊れた JSON・型不正は「読めなかった」側に寄せる
- [x] [D-20260830-0423-explore-fast-crash-input-consumption](D-20260830-0423-explore-fast-crash-input-consumption.md) — 探索の入力消費を打ち切る基準は「瞬時クラッシュ」で切る
- [x] [D-20260830-0410-explore-crash-out-of-scope](D-20260830-0410-explore-crash-out-of-scope.md) — 探索セッションの瞬時クラッシュは crash-backoff の対象に含めない
- [x] [D-20260830-0311-deny-prompt-consistency-granularity](D-20260830-0311-deny-prompt-consistency-granularity.md) — deny リストと PROMPT.md の一致は対応表 + inline code トークンの集合比較で検査する
- [x] [D-20260830-0303-phase4-consent-granularity](D-20260830-0303-phase4-consent-granularity.md) — フェーズ 4 の個別確認をリリースノート粒度で運用する
- [x] [D-20260830-0251-installed-source-drift-always-on](D-20260830-0251-installed-source-drift-always-on.md) — 自己ホスト時の乖離警告は常時点灯を許容する
- [x] [D-20260830-0236-phase-assessment-and-single-gate](D-20260830-0236-phase-assessment-and-single-gate.md) — ccloop 自身はフェーズ 4 と見なし、遡及ゲートは 1 通に集約する
- [x] [D-20260830-0221-decisions-index-mechanical-merge](D-20260830-0221-decisions-index-mechanical-merge.md) — decisions/index.md のマージ衝突を 3-way マージで機械的に解決する
- [x] [D-20260830-0209-decisions-index-approval-archive](D-20260830-0209-decisions-index-approval-archive.md) — 決定のアーカイブ条件を件数基準から人間のチェックに変更する
- [x] [D-20260830-0118-devcontainer-json-manual-version](D-20260830-0118-devcontainer-json-manual-version.md) — .devcontainer/devcontainer.json のバージョン同期を廃止し手動更新にする
- [x] [D-20260829-0314-defer-agent-commit](D-20260829-0314-defer-agent-commit.md) — `.agent/` の自動コミットを wait 時の即時実行からタイミング集約(JIT)へ変更
- [x] [D-20260823-0936-permissions-auto-mode](D-20260823-0936-permissions-auto-mode.md) — permissions テンプレートを auto モード前提に整理(allow は読み取り専用のみ、deny が実質のガードレール)
- [x] [D-20260822-1519-adopt-slug-based-ids](D-20260822-1519-adopt-slug-based-ids.md) — tasks/decisions/human-review の ID を連番から日時 + slug へ変更
- [x] [D-20260822-0846-devcontainer-self-host-feature](D-20260822-0846-devcontainer-self-host-feature.md) — devcontainer を公開版 ccloop feature (0.1.0) で自己ホストする
