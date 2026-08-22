import { defineConfig } from "vitest/config";

// テスト対象をこのリポジトリの基盤(.agent/supervisor)とアプリ(src/)に限定する。
// 配下に別リポジトリのチェックアウトや生成物が置かれても拾わないようにするため。
export default defineConfig({
  test: {
    include: [".agent/**/*.test.ts", "src/**/*.test.ts"],
  },
});
