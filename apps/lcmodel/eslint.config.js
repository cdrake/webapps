// Flat ESLint config so `pnpm lint` works out of the box in a scaffolded app.
export default [
  { ignores: ["dist/**"] },
  {
    files: ["**/*.js"],
    // 'latest' parses the JSON import attributes in main.js.
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: {},
  },
];
