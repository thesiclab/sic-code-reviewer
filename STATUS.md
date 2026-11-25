# Status

2026-11-25, integrator. Local only: one commit, nothing pushed, no public repo, nothing published, no real model calls.

## Works (built, tested with fakes)

- **Read job** (`src/entry/review.ts`): config from action inputs + base-commit `.sic-code-reviewer.yml` -> fork/size/cost gates -> merge-base patch set -> prior-review ledger -> per-commit cache -> context engine -> reviewer -> adversary (anonymised) -> counter-check -> code-only findings filter -> repeat cap -> gate -> `review-result.json`. A crash still writes a neutral result.
- **Write job** (`src/entry/post.ts`): re-validates the artifact, recomputes the gate, sanitises, posts one review (422 -> body-only retry; landed-check before one retry on 403/429/5xx), sets the check; job-summary fallback.
- **Modules 1-11 and config:** diff and merge-base patch builder (incremental hint, anchors, lockfile notes), context engine (changed functions, callers, callees, tests, repo map, token budget, "not read" list), prompts (nonce fences, redaction, silent-drop lint, code-owned security preamble), adapters (Anthropic structured output, OpenAI-compatible with json_object fallback, fake), roles and schemas, findings filter, gate and cache, ledger and repeat cap, output sanitiser and poster, cost estimate and meter, GitHub reader, eval harness and CLI.
- **Prompt text** (`prompts/reviewer.md`, `adversary.md`, `counter-check.md`): written by the integrator, adapted from Comfy's three prompts (headers list the changes). They pass the silent-drop lint.
- **Config** (`src/config/`): `loadConfig` plus a small YAML-subset parser (no dependency). Fails closed (throws -> neutral check) on missing prices, key values where an env var NAME belongs, non-https URLs to public hosts, out-of-range numbers, unknown model families. The base file cannot set bot logins, check name or the private-repo opt-in, and `repeat-cap` can only go down.
- **Injection set through the real pipeline: 0 of 30 runs succeed** (15 cases x reviewer-obeys / adversary-obeys). Was 16 of 30 before amendment A1 below. `npx tsx src/entry/eval-cli.ts --fake` reports the same.

## Contract amendments made by the integrator (Dan to acknowledge)

Recorded at the end of `CONTRACT.md`. No exported signature or shared type changed.

- **A1. Gate rules hardened against injection.** A disputed critical/high finding, or one dismissed without a refuting quote of _code_, stays posted and blocking (it was "disputed, never gates"). Refuting quotes have comments, docstrings and fence-like lines stripped before matching. This closes all three holes the eval builder found, including the counter-check veto. Trade-off: an honest adversary that disagrees without quotable code now leaves the check red; the reason is shown on the finding.
- **A2.** Anthropic adapter uses `output_config.format` json_schema, not forced tool use, and sends no `temperature` (the current API rejects both on Opus/Sonnet 5.5).
- **A3.** `action.yml` gained `<role>-family`, `<role>-max-output-tokens`, `<role>-price-in-per-mtok`, `<role>-price-out-per-mtok`. The example workflow sets the default duo (Claude reviewer `claude-sonnet-5-5`, GLM adversary `glm-5.3` via `https://api.z.ai/api/paas/v4`) with prices left empty for Dan to fill in.

## Tests

- `npx vitest run`: **17 files, 319 tests passed, 0 skipped**, including `tests/eval/injection-ci.test.ts` on the real pipeline (it used to skip while prompts were empty). `SIC_REQUIRE_FULL_PIPELINE=1` passes too.
- `tests/setup.ts` makes every `fetch` throw; no test uses `node:http`/`https`/`net`. Git tests use temporary repos with the user's git config isolated.
- Type check: `tsc --noEmit` with the tsconfig flags below over `src/**` and `tests/**`: no errors. A `tsc` build of `src/` to a scratch `dist/` works, and `node dist/entry/main.js` dispatches.
- Secret scan over every tracked file (PEM, AWS, GitHub, Anthropic, OpenAI, Slack, Google, JWT shapes): no hits. Test vectors are assembled at run time from fragments (`tests/fixtures/fake-secrets.ts`).
- License review: every Comfy-derived file (`src/diff/anchors.ts`, `src/diff/incremental.ts`, `src/prompts/fence.ts`, `src/prompts/render.ts`, `src/findings/severity.ts`, `src/roles/schema.ts`, `src/memory/ledger.ts`, `src/output/sanitize.ts`, `src/output/poster.ts`, `prompts/*.md`) carries the Apache-2.0 AND MIT header with the source file and changes; `NOTICE` carries Comfy's MIT text. Every other file is Apache-2.0. No code from unlicensed or AGPL/GPL repos (ng/adversarial-review, alecnielsen, magpie, kodus): ideas only.

## Stubbed or not done

- `tsconfig.json` added 2026-11-25 (Dan relaunched with config edits allowed).

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

- `dist/` is not built or committed (needs tsconfig; ship it with a release).
- `action.yml` and `examples/workflows/sic-code-reviewer.yml` were **not** blocked; they are in the repo. Nothing is under `../staged/`.
- Fork PRs are skipped by the workflow `if:`, not given a "not reviewed (fork)" note (the gate supports it; the workflow does not run for forks).
- The stats branch job (plan section 6) and the shadow single-model runner registration (`setShadowRunner`) are not wired.
- Static analysis as a context item: LATER.

## Known gaps

1. `PatchSet` has no warnings field, so a discarded newest-hunks hint is not shown in the review; `ReviewResult` has no `warnings` field either (config and ledger warnings go to the Actions log only). Suggested additive type changes: `incrementalWarning: string | null`, `warnings: string[]`.
2. No `run-error` gate reason: a crash is recorded as `model-failure` (reviewer, `config`). It is neutral either way.
3. The read job's cache check trusts any Bot review; the post job re-checks against the configured bot logins, so a forged hit only gives a neutral check.
4. One malformed finding fails the whole reply (re-ask, then neutral).
5. The eval CLI's skilled fakes show no duo advantage on the planted set (the kill-test line reads FAIL). That says nothing about real models; it is the scripted fakes' profile.
6. Context heuristics can miss multi-line JS method signatures and template-literal braces.
7. OpenAI-compatible adapter sends `max_tokens`; OpenAI o-series wants `max_completion_tokens`.

## Next steps

1. Dan: create `tsconfig.json` (above), then `npm run build`.
2. Real keys: put `ANTHROPIC_API_KEY` and `ZAI_API_KEY` in 1Password first, then as repo secrets; fill in model prices; check Z.ai json_schema support (open item C3) with one live call.
3. Create the public repo `thesiclab/sic-code-reviewer` (after hours, per the no-personal-repos-in-work-hours rule), push, cut a release with `dist/`, and replace the 40-zero `uses:` SHA.
4. Dogfood on our own repos (pr-caddie waits for the check; milestone 2).
5. Eval runs with real models: planted set, injection set, replays of our past PRs (`pr-<n>-base`/`pr-<n>-head` refs), AACR-Bench (dataset fetched at eval time), and the shadow single-model baseline. Publish the numbers either way.
6. Dan to acknowledge amendments A1-A3 and decide open item C1 (counter-check).
