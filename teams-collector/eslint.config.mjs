import js from "@eslint/js";

// The rules below turn the numeric limits of CODING_RULES.md into lint errors.
const BROWSER_GLOBALS = {
  window: "readonly",
  console: "readonly",
  fetch: "readonly",
  crypto: "readonly",
  URL: "readonly",
  Request: "readonly",
  XMLHttpRequest: "readonly",
  AbortSignal: "readonly",
};

export default [
  js.configs.recommended,
  {
    files: ["extension/**/*.js"],
    languageOptions: { ecmaVersion: "latest", sourceType: "script", globals: BROWSER_GLOBALS },
    rules: {
      "max-lines-per-function": ["error", { max: 30, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 4],
      "max-depth": ["error", 3],
      "no-magic-numbers": ["error", { ignore: [0, 1], ignoreArrayIndexes: true, enforceConst: true }],
      // snake_case keys are the wire format shared with the Python receiver.
      camelcase: ["error", { properties: "never" }],
      eqeqeq: "error",
      "no-var": "error",
      "prefer-const": "error",
    },
  },
];
