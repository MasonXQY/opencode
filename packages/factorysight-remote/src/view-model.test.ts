import { expect, test } from "bun:test"
import { artifactsForProject } from "./view-model"

test("artifactsForProject only returns artifacts for the active project", () => {
  const artifacts = [
    { projectId: "prj_current", name: "snake-game", relativePath: "snake-game/index.html" },
    { projectId: "prj_other", name: "marble-shooter", relativePath: "marble-shooter/index.html" },
    { projectId: "prj_current", name: "schedule", relativePath: "schedule/index.html" },
  ]

  expect(artifactsForProject(artifacts, "prj_current")).toEqual([
    { projectId: "prj_current", name: "snake-game", relativePath: "snake-game/index.html" },
    { projectId: "prj_current", name: "schedule", relativePath: "schedule/index.html" },
  ])
})
