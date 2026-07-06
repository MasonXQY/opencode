import { expect, test } from "bun:test"
import { artifactsForProject, defaultProjectPath, nextSelectedTaskId, slugProjectName } from "./view-model"

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

test("nextSelectedTaskId keeps an existing valid selection unless a new task is created", () => {
  const tasks = [
    { id: "new", projectId: "project", updatedAt: "2026-07-06T10:00:00.000Z" },
    { id: "old", projectId: "project", updatedAt: "2026-07-06T09:00:00.000Z" },
  ]

  expect(nextSelectedTaskId(tasks, "project", "old")).toBe("old")
  expect(nextSelectedTaskId(tasks, "project", "old", "new")).toBe("new")
})

test("nextSelectedTaskId falls back to the newest task in the active project", () => {
  const tasks = [
    { id: "other-project", projectId: "other", updatedAt: "2026-07-06T11:00:00.000Z" },
    { id: "newest", projectId: "project", updatedAt: "2026-07-06T10:00:00.000Z" },
    { id: "oldest", projectId: "project", updatedAt: "2026-07-06T08:00:00.000Z" },
  ]

  expect(nextSelectedTaskId(tasks, "project", undefined)).toBe("newest")
})
