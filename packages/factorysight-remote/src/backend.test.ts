import { expect, test } from "bun:test"
import { mergeFactorySightTasks } from "./backend"
import type { Task } from "./shared"

function task(input: Partial<Task> & Pick<Task, "id" | "updatedAt">): Task {
  return {
    projectId: "prj_1",
    creatorId: "usr_mason",
    title: input.id,
    prompt: input.id,
    agent: "build",
    model: "anthropic/claude-opus-4-8",
    status: "completed",
    collaboration: "project",
    createdAt: input.updatedAt,
    events: [],
    ...input,
  }
}

test("mergeFactorySightTasks filters hidden FactorySight sessions after delete", () => {
  const local = [task({ id: "tsk_local", updatedAt: "2026-07-07T10:00:00.000Z" })]
  const backend = [
    task({ id: "fs_ses_keep", sessionId: "ses_keep", updatedAt: "2026-07-07T11:00:00.000Z" }),
    task({ id: "fs_ses_deleted", sessionId: "ses_deleted", updatedAt: "2026-07-07T12:00:00.000Z" }),
  ]

  expect(mergeFactorySightTasks(local, backend, ["ses_deleted"]).map((item) => item.id)).toEqual([
    "fs_ses_keep",
    "tsk_local",
  ])
})
