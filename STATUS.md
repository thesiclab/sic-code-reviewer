# Status

## 2026-11-25, architect

Done:

- Repo created (local only, not pushed): `package.json`, `vitest.config.ts`, `LICENSE` (Apache-2.0), `NOTICE` (Comfy MIT notice, commit 63c501a0), `.gitignore`.
- `CONTRACT.md` written. Shared types in `src/types.ts`.
- `src/` scaffolded: every module's exported names and signatures, stubs throw `NotImplemented`. Comfy-derived files carry the header.
- `tests/`: `tests/setup.ts` makes any `fetch` throw; `tests/scaffold.test.ts` passes (5 tests); one `it.todo` file per module.
- Comfy source cloned read-only at `../vendor-src` (commit 63c501a0a3646f671e2f35d1a4cb35acfcbbd749).

Checks run:

- `npx vitest run`: 5 passed, 14 todo.
- Type check with tsc command-line flags matching the intended tsconfig below: no errors.

## Blocked by the config-guard hook (not bypassed)

### `tsconfig.json`

Writing it was blocked in the repo. Writing it to `../staged/tsconfig.json` was blocked too, and the hook said not to route around it. Dan: create `tsconfig.json` at the repo root with this content. Until then `npm run build` and `npm run typecheck` fail; `npm test` works.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

### Expected next

`action.yml` and the example workflow (worker F) are likely to be blocked the same way. The staged path is blocked for tsconfig too, so workers should expect the same and record the content here for Dan.

## Notes

- `npm install` warned that esbuild's postinstall script was not run (install scripts need approval). vitest works without it.
- Not read whole from Comfy: `auto-approve.py` (5,340 lines), `catalog-drift.py`, `stop-on-submit.py`, `wire-bot-identity.py`, the shell scripts, and the tests. None of them are taken. The files we take from were read in full: the three prompts, `fence-diff.py`, `incremental-diff.py`, `review-output-mcp.py`, `agent-error.py`, `aggregate-panel.py` and `gate-unresolved.py`. For `build-ledger.py`, `post-review.py` and the README we read the outline and the relevant sections.
