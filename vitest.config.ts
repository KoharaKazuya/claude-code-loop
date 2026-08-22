import { defineConfig } from "vitest/config";

// テスト対象を ccloop 本体(lib/)に限定する。
// 配下に別リポジトリのチェックアウトや生成物が置かれても拾わないようにするため。
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    setupFiles: ["lib/test-setup.ts"],
  },
});
