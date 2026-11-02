# Custom session views validation

Validation date: 2026-11-02. Custom version: `0.4.1-hc.1`. Upstream base: `e69e852` (0.4.1).

The custom app uses `com.hadriencornier.LearnHarness`, a separate profile, and manual updates. The installed official app stays running. Its `app.asar` checksum matches the checksum from before this task.

## Native results

The final packaged executable passes these checks with temporary profiles and no personal credentials:

| Check | Evidence |
| --- | --- |
| Two windows, four distinct sessions, streamed replies, responsive session requests | 13-check workspace smoke |
| Pane-specific Find, drafts, refused submission, inactive-pane replacement | Workspace smoke |
| Narrow switcher, duplicate focus, reload, transfer, deliberate close, restart | Workspace smoke |
| Bundled backend, custom updater disabled, separate window storage | Packaged workspace smoke |
| PNG preview outside the collapsed tool trace and decoded full-size image | Packaged workspace smoke |
| Retry creates a successor and preserves the failed job and unsent draft | Packaged demo retry smoke |
| Actual job runner writes a demo, runs Chromium verification, and delivers it | Packaged demo retry smoke |
| Delivered counter responds to a user click, from Count 0 to Count 1 | Packaged demo retry smoke |

The four session responses use a deterministic local stream fixture. The completed retry uses a keyless local OpenAI-compatible fixture. Its four model requests include three builder requests and one teacher request. Chromium executes the real `run_demo` check. No paid model calls run.

Wide layout uses simulated 2000-pixel renderer geometry. This is not proof of placement on two physical displays. Real microphone capture and provider reliability remain unverified. Unit tests cover corrupt saved state, missing display geometry, invalid IPC, duplicate assignments, and pending-question draft identity. A mounted regression verifies resize observation after Settings navigation.

## Build and automated checks

Typecheck, lint, production build, provider runtime isolation, standalone curation, and the Electron-bundled server smoke pass. Lint retains one existing `source-name-ui.test.tsx` warning. ZIP and DMG integrity checks run before release publication.

The full local custom suite reports 3220/3222 pass under Node 24.14. The fork homepage changed one packaging assertion. That assertion was corrected, and the 60-test desktop/identity regression run passes. The remaining `subscription-auth` import-only package export failure also reproduces on unchanged upstream `e69e852` under this local runtime.

The first upstream CI run passes quality and standalone builds on macOS, Windows, and Linux at feature commit `630500f`. The latest feature commit is `3492fa4`; its new CI run is separate and must be checked before claiming it passes. Local tests do not substitute for remote CI.

Independent agents reviewed desktop coordination, renderer scope and draft handling, custom release isolation, and the completed-retry test. The reported defects were corrected before the final packaged checks.

## Reproduce

Run source checks and build commands from [custom-release.md](custom-release.md). Run these native tests one at a time with the packaged executable path:

```sh
node scripts/smoke-workspace.mjs --app '<app>/Contents/MacOS/Hadrien LearnHarness'
node scripts/smoke-packaged-workspace.mjs '<app>/Contents/MacOS/Hadrien LearnHarness'
node scripts/smoke-demo-retry-packaged.mjs '<app>/Contents/MacOS/Hadrien LearnHarness'
```

These scripts create and focus native windows. Do not run them during the user's other work. The user requested no further foreground tests in this session. Subsequent delivery checks use background CLI and file operations only.

Evidence is saved in `/Users/HCornier/Robotics/learnharness-custom-evidence/2026-11-02` and in the release validation archive. The official app's learning data and credentials were not migrated.
