// PreToolUse hook: 自律実行中の AskUserQuestion を拒否し、続行方法をモデルへ返す
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "自律実行モードでは人間への質問は使えない。人間への質問として停止せず、" +
        ".agent/human-review/ に REVIEW(または BLOCK)ファイルを作成し、" +
        "合理的な暫定判断(可逆性が高く変更範囲が小さい選択肢)を .agent/decisions/ に記録して作業を続けるか、" +
        "他の実行可能な作業を続けること。",
    },
  }),
);
