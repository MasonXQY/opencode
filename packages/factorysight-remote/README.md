# FactorySight Remote

FactorySight Remote is the first web-facing shell around the local FactorySight engine.

It provides:

- multi-user sign-in by email for the MVP
- project registration by server-side path
- task assignment with agent, model, and visibility controls
- live task event streaming across devices
- task sharing for collaborative sessions
- a real runner that calls the local `factorysight run` command
- an optional demo runner for local UI validation

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

Only `full_auto` passes `--auto` to the local FactorySight runner.
