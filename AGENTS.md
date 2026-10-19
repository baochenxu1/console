# Agent Instructions

This repository follows the universal Git branch policy defined in:

```text
.cursor/rules/git-branch-policy.mdc
```

## Git Branch Policy

Critical rules:

- Never push directly to `main`.
- `main` accepts only `release`.
- **Hard gate for `main`:** Do not merge `release` into `main` or push any release version to `main` unless the owner gives an **explicit promotion instruction** for that release (e.g. “推送到 main” / “把这次 release 晋升到 main”). Tagging or finishing release validation alone is not permission.
- `release` is a fixed long-lived branch name; never create `release/<version>` (for example `release/v0.5.0` or `release/FaceConsole-v0.5.0`).
- When `develop` reaches a stable release-candidate state, merge `develop` into `release`.
- Version positioning uses Git tags on published commits, not release branch names.
- After release acceptance **and** an explicit promotion instruction, merge `release` into `main`.
- Release fixes on `release` must be back-merged into `develop`.
- `develop` receives accepted `feature/*`.
- New, risky, experimental, or large-version work must start from `feature/*`.
- `develop` must not merge directly into `main`.
- `feature/*` must not merge directly into `main`.
- If uncertain, do not touch `main`; ask for confirmation.

Default flow:

```text
feature/* → develop → release → main
```

Release flow:

```text
feature/* → develop
develop 定版 → release
release 验证 / 修复 / 发布准备
release 发布时打 tag
release → main
```

## Commit Messages

- Never add `Co-authored-by: Cursor <cursoragent@cursor.com>` or any Cursor-related content to commits or merge messages.
- See `.cursor/rules/git-branch-policy.mdc` section **9.1 Commit Message Policy**.

## Public Release Notes (`main` and tags)

- `main` is the public product branch. When promoting `release → main`, the merge commit message must explain the **product baseline**, **major upgrades**, and **fixes**, for external readers—not internal process notes.
- Annotated release tags must explain **why this version is published**, with clear **features/upgrades** and **fixes**.
- See `.cursor/rules/git-branch-policy.mdc` sections **3.3 Version Tags** and **3.4 Main Promotion Workflow**.
