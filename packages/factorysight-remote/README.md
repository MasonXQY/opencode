# FactorySight Remote

FactorySight Remote is the web-facing shell around the local FactorySight engine.

Remote is not the product backend. FactorySight/opencode owns backend execution: task running, model calls,
agent orchestration, permissions, and generated artifacts. Remote provides the browser and desktop control
surface, plus a thin local gateway where needed for auth, uploads, static assets, and event display.

It provides:

- multi-user sign-in by email for the MVP
- project registration by server-side path
- task assignment with agent, model, and visibility controls
- live task event streaming across devices
- task sharing for collaborative sessions
- a FactorySight backend adapter for model discovery and task execution
- a local-dev backend adapter for UI development and regression testing

## Run

```sh
bun run dev:remote
```

Open `http://127.0.0.1:3090`.

For a no-model demo run:

```sh
FACTORYSIGHT_REMOTE_RUNNER=mock bun run dev:remote
```

State is stored in `~/.factorysight-remote/state.json` by default. Override it with `FACTORYSIGHT_REMOTE_DATA`.

## Backend Modes

Remote supports two backend modes:

- `FACTORYSIGHT_REMOTE_BACKEND=factorysight`: task execution and model discovery go through FactorySight. The adapter prefers `factorysight api` when available and falls back to the installed FactorySight CLI transport for current installations.
- `FACTORYSIGHT_REMOTE_BACKEND=local`: local development compatibility mode. This is the browser dev default.

The desktop app defaults to `factorysight`. Browser development defaults to `local` until the remaining MVP
storage and artifact APIs are moved behind FactorySight endpoints.

## Backend Permission Controls

Permission is a project-level backend setting. The frontend button calls these same APIs.

List available permission profiles and current project settings:

```sh
curl http://127.0.0.1:3090/api/permissions \
  -H "Authorization: Bearer $TOKEN"
```

Read one project permission:

```sh
curl http://127.0.0.1:3090/api/projects/$PROJECT_ID/permission \
  -H "Authorization: Bearer $TOKEN"
```

Set one project permission:

```sh
curl -X PUT http://127.0.0.1:3090/api/projects/$PROJECT_ID/permission \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"permissionLevel":"ask"}'
```

Available levels:

- `ask`
- `read_only`
- `auto_safe`
- `full_auto`

In `factorysight` backend mode, permission behavior is owned by FactorySight. In `local` backend mode,
only `full_auto` passes `--auto` to the compatibility runner.
