import { expect, test } from "bun:test"
import { reconcileStaleWorkflowTasks } from "./store"
import type { AppState, Task } from "./shared"

function task(input: Partial<Task> & Pick<Task, "id" | "status" | "updatedAt">): Task {
  return {
    projectId: "prj_1",
    creatorId: "usr_mason",
    title: input.id,
    prompt: input.id,
    agent: "build",
    model: "anthropic/claude-opus-4-8",
    collaboration: "project",
    createdAt: input.updatedAt,
    events: [],
    ...input,
  }
}

function state(tasks: Task[]): AppState {
  return {
    users: [],
    sessions: [],
    projects: [],
    tasks,
  }
}

test("reconcileStaleWorkflowTasks fails child tasks left running after the parent workflow ended", () => {
  const data = state([
    task({
      id: "parent",
      kind: "orchestration",
      status: "completed",
      updatedAt: "2026-07-08T10:00:00.000Z",
      childTaskIds: ["child"],
    }),
    task({
      id: "child",
      parentTaskId: "parent",
      status: "running",
      updatedAt: "2026-07-08T09:55:00.000Z",
    }),
  ])

  expect(reconcileStaleWorkflowTasks(data, new Date("2026-07-08T10:05:00.000Z"))).toBe(1)
  expect(data.tasks.find((item) => item.id === "child")?.status).toBe("failed")
  expect(data.tasks.find((item) => item.id === "child")?.events.at(-1)?.text).toContain(
    "Parent workflow already completed",
  )
})

test("reconcileStaleWorkflowTasks fails old running tasks that have no backend session", () => {
  const data = state([
    task({
      id: "orphan-running",
      status: "running",
      updatedAt: "2026-07-08T09:00:00.000Z",
    }),
  ])

  expect(reconcileStaleWorkflowTasks(data, new Date("2026-07-08T10:00:00.000Z"))).toBe(1)
  expect(data.tasks[0]?.status).toBe("failed")
  expect(data.tasks[0]?.events.at(-1)?.text).toContain("No active backend session")
})
