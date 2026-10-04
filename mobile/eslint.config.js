// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*"],
  },
  {
    files: ["App.tsx", "src/**/*.ts", "src/**/*.tsx"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [{ group: ["../*", "./src/*"], message: "Use @/ paths across source directories; use ./ for neighboring modules." }],
      }],
    },
  }
]);
