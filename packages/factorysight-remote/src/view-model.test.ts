import { expect, test } from "bun:test"
import { artifactsForProject, defaultProjectPath, slugProjectName } from "./view-model"

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

test("defaultProjectPath creates a unique project folder outside the source checkout", () => {
  expect(slugProjectName("Snake Game!")).toBe("snake-game")
  expect(defaultProjectPath("Snake Game!", "abc123", "/tmp/factorysight")).toBe("/tmp/factorysight/snake-game-abc123")
})
