# Hadrien LearnHarness

This fork supplies session windows and split views without waiting for upstream review. The macOS app uses the name **Hadrien LearnHarness**, application ID `com.hadriencornier.LearnHarness`, and a separate Application Support profile. It does not use the official update feed.

The first release uses an empty profile. It does not copy learning data, keys, provider accounts, or drafts from the installed LearnHarness app. Data migration is a separate task.

## Branches

- `feat/session-views`: the upstream feature proposal. It excludes custom branding, PNG display, and demo retry.
- `custom/main`: the feature plus the custom app configuration, PNG display, and failed-demo retry.

The PNG display change comes from commit `91dbff9`. The retry change comes from PR [#430](https://github.com/amosblomqvist/learnharness/pull/430), commit `355f545`. Check upstream before each merge. Do not keep a second copy if upstream adopts a fix.

## Build a Mac release

Use macOS with Node, npm, and Xcode installed. Signing and notarization are disabled for this custom configuration.

1. Check out `custom/main` in a separate worktree.
2. Run `npm ci`.
3. Run `npm run typecheck`, `npm test`, and `npm run lint`.
4. Run `npm run desktop:custom`.
5. Run `node scripts/smoke-workspace.mjs --app "dist-custom/mac-arm64/Hadrien LearnHarness.app/Contents/MacOS/Hadrien LearnHarness"`.
6. Run `scripts/smoke-packaged-workspace.mjs` and `scripts/smoke-demo-retry-packaged.mjs` with the packaged executable path. These use isolated profiles and local fixtures.
7. Publish the ZIP and DMG with a `custom-` release tag on this fork. Include the source commit and validation limits in the release notes.

The build script clears only `dist-custom` and `.next/standalone`. It runs the production build, provider runtime check, standalone curation, and server smoke test before packaging. It never uploads automatically.

The unsigned app can require a manual open through macOS Privacy & Security. Download updates from this fork's Releases page and replace only the custom app. Its profile stays separate from the official app.

## Merge upstream changes

```sh
git fetch origin
git switch custom/main
git merge origin/main
```

Resolve conflicts against the current upstream behavior. Keep custom identity and the disabled official updater. Repeat the regression checks and native smoke test. Inspect the rendered app before another release. Use a new custom version and release tag.

Do not merge `custom/main` into the upstream feature PR. If upstream changes require a feature update, apply those changes on `feat/session-views` first, then merge that branch into `custom/main`.

## Evidence limits

See the release validation record. Synthetic streams prove the tested UI and transport paths. They do not establish real provider reliability, microphone behavior, or placement on two physical displays. This release does not migrate the official app's data.

Native smoke tests create and focus windows. Schedule them when they will not interrupt your work. Source checks, build checks, and artifact inspection can run in the background.

## Figure recovery

Figure generation permits 16 model calls per attempt, increased from 8. Two calls before the limit, the agent receives a reminder to render its final drawing and inspect it.

A Figure job retries automatically once after an exhausted call budget or a temporary provider error. Authentication errors, content refusals, and cancellation do not trigger automatic retries. Both attempts count toward the job usage, with at most 32 calls in total. A failed Figure card supplies a Retry button and saved error details. Manual retry creates a new attempt and preserves the original job.
