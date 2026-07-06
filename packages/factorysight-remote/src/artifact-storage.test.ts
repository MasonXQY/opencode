import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { listProjectArtifacts, writeTaskDeliverableArtifact } from "./artifact-storage"
import type { Project, Task } from "./shared"

let cleanup: string | undefined

afterEach(async () => {
  if (cleanup) await rm(cleanup, { recursive: true, force: true })
  cleanup = undefined
})

function project(path: string): Project {
  return {
    id: "prj_1",
    name: "Workspace",
    path,
    permissionLevel: "ask",
    createdAt: new Date(0).toISOString(),
    memberships: { usr_1: "owner" },
  }
}

function task(): Task {
  return {
    id: "tsk_1",
    projectId: "prj_1",
    creatorId: "usr_1",
    title: "Build product",
    prompt: "Build product",
    agent: "build",
    model: "anthropic/claude-opus-4-8",
    status: "completed",
    collaboration: "project",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    events: [],
  }
}

test("writeTaskDeliverableArtifact creates an openable project artifact", async () => {
  cleanup = await mkdtemp(join(tmpdir(), "factorysight-artifact-"))
  const workspace = join(cleanup, "workspace")
  const item = task()

  const artifact = await writeTaskDeliverableArtifact(item, workspace, "Final deliverable\n\nFiles changed:\n- app.ts")

  expect(artifact).toMatchObject({
    projectId: "prj_1",
    relativePath: "tasks/tsk_1/deliverable.html",
  })
  await expect(readFile(join(workspace, "artifacts", artifact.relativePath), "utf8")).resolves.toContain(
    "Final deliverable",
  )
})

test("listProjectArtifacts includes generated deliverables and existing html artifacts", async () => {
  cleanup = await mkdtemp(join(tmpdir(), "factorysight-artifacts-"))
  const workspace = join(cleanup, "workspace")
  await writeTaskDeliverableArtifact(task(), workspace, "Final deliverable")
  await mkdir(join(workspace, "artifacts"), { recursive: true })
  await Bun.write(join(workspace, "artifacts", "demo.html"), "<html>demo</html>")

  const artifacts = await listProjectArtifacts(project(workspace))

  expect(artifacts.map((artifact) => artifact.relativePath)).toEqual(["demo.html", "tasks/tsk_1/deliverable.html"])
})
