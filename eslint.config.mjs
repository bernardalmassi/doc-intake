import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// One logger. Code in src/lib writes logs only through src/lib/log.ts, the
// single place that decides what may reach a log line (see the comment at
// its top). The rules below close every direct or aliased route to a
// console, a process stream or a file descriptor: tests/unit/log.test.ts
// lints each known bypass and expects an error. ESLint sees syntax, not
// values, so a deliberately computed property name (x[a + b]) can still
// reach anything; that is for review.
//
// Two scopes. The strict rules apply to the server-side code that handles
// keys, documents and model output (src/lib/extraction, redact.ts,
// errors.ts). The rest of src/lib, where the UI redesign may add browser
// helpers that legitimately touch window or need an inline disable, gets
// only the console and process-stream rules. In src/app the same two rules
// cover the server-side code: the Server Actions, the auth route and the
// worker route, which log through the same module.
const LOGGER = "src/lib/log.ts";
const EXTENSIONS = "{js,mjs,cjs,ts,mts,cts,tsx,jsx}";
const STRICT_FILES = [`src/lib/extraction/**/*.${EXTENSIONS}`, "src/lib/redact.ts", "src/lib/errors.ts"];
const USE_LOGGER = `Log through ${LOGGER}.`;
const SERVER_ACTIONS = [
  "src/app/auth/actions.ts",
  "src/app/auth/confirm/route.ts",
  "src/app/app/actions.ts",
  "src/app/app/extract-action.ts",
  "src/app/api/extraction-worker/route.ts",
  "src/app/log-fields.ts",
];

// Node modules that hand out the process or console, or can write to a
// stream, a file descriptor or a child's stdio.
const WRITER_MODULES = /^(node:)?(process|console|fs|tty|net|child_process|worker_threads|module|inspector)(\/.*)?$/;

// globalThis.console, window.process and the like
const GLOBAL_WRITERS = ["globalThis", "global", "window", "self"].flatMap((object) =>
  ["console", "process"].map((property) => ({ object, property, message: USE_LOGGER })),
);
const PROCESS_STREAMS = ["stdout", "stderr"].map((property) => ({ object: "process", property, message: USE_LOGGER }));

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: [`src/lib/**/*.${EXTENSIONS}`],
    ignores: [LOGGER],
    rules: {
      "no-console": "error",
      "no-restricted-properties": ["error", ...GLOBAL_WRITERS, ...PROCESS_STREAMS],
    },
  },
  {
    files: SERVER_ACTIONS,
    rules: {
      "no-console": "error",
      "no-restricted-properties": ["error", ...GLOBAL_WRITERS, ...PROCESS_STREAMS],
    },
  },
  {
    files: STRICT_FILES,
    linterOptions: {
      // no eslint-disable comments: nothing in src/lib needs one, and one
      // would switch these rules off for a line
      noInlineConfig: true,
    },
    rules: {
      "no-console": "error",
      // any reference at all, so aliasing (const c = console) is caught too
      "no-restricted-globals": [
        "error",
        ...["console", "globalThis", "global", "window", "self"].map((name) => ({ name, message: USE_LOGGER })),
        ...["require", "module", "Function"].map((name) => ({
          name,
          message: "Not in src/lib: it loads code or modules past the import rules.",
        })),
      ],
      "no-restricted-properties": ["error", ...GLOBAL_WRITERS, ...PROCESS_STREAMS],
      "no-restricted-imports": [
        "error",
        { patterns: [{ regex: WRITER_MODULES.source, message: `${USE_LOGGER} Read configuration from process.env.` }] },
      ],
      "no-restricted-syntax": [
        "error",
        {
          // process.env is the only use: no process.stdout, no
          // process._rawDebug, no aliasing it, no passing it anywhere
          selector:
            'Identifier[name="process"]:not(MemberExpression[computed=false][property.name="env"] > Identifier.object, MemberExpression[computed=false] > Identifier.property, Property[computed=false][shorthand=false] > Identifier.key)',
          message: `Only process.env is allowed in src/lib. ${USE_LOGGER}`,
        },
        {
          selector: "ImportExpression[source.type!='Literal']",
          message: "Dynamic imports need a literal module name in src/lib, so the import rules can check it.",
        },
        {
          selector: `ImportExpression[source.value=${WRITER_MODULES}]`,
          message: USE_LOGGER,
        },
        {
          selector: "TSImportEqualsDeclaration",
          message: "Use an import declaration, which the import rules check.",
        },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
