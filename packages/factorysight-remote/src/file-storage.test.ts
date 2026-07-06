import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createProjectFolders, listProjectFiles, saveUploadedFile } from "./file-storage"

let cleanup: string | undefined

afterEach(async () => {
  if (cleanup) await rm(cleanup, { recursive: true, force: true })
  cleanup = undefined
})

test("creates a per-project FactorySight upload folder", async () => {
  cleanup = await mkdtemp(join(tmpdir(), "factorysight-project-"))
  const projectRoot = join(cleanup, "client-portal")

  await createProjectFolders(projectRoot)

  await expect(stat(join(projectRoot, ".factorysight", "uploads", "project"))).resolves.toMatchObject({
    isDirectory: expect.any(Function),
  })
})

test("stores project and task uploads inside sanitized project folders", async () => {
  cleanup = await mkdtemp(join(tmpdir(), "factorysight-files-"))
  const source = join(cleanup, "brief.txt")
  await writeFile(source, "product brief")

  const projectRoot = join(cleanup, "workspace")
  const projectFile = await saveUploadedFile({
    projectId: "prj_1",
    projectPath: projectRoot,
    scope: "project",
    uploadedBy: "usr_1",
    file: new File(["project notes"], "../Project Notes.md", { type: "text/markdown" }),
  })
  const taskFile = await saveUploadedFile({
    projectId: "prj_1",
    projectPath: projectRoot,
    taskId: "tsk_1",
    scope: "task",
    uploadedBy: "usr_1",
    file: new File([await Bun.file(source).arrayBuffer()], "brief.txt", { type: "text/plain" }),
  })

  expect(projectFile.relativePath).toMatch(/^\.factorysight\/uploads\/project\/Project-Notes\.md$/)
  expect(taskFile.relativePath).toMatch(/^\.factorysight\/uploads\/tasks\/tsk_1\/brief\.txt$/)
  expect(await listProjectFiles(projectRoot)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ relativePath: projectFile.relativePath, originalName: "../Project Notes.md" }),
      expect.objectContaining({ relativePath: taskFile.relativePath, taskId: "tsk_1" }),
    ]),
  )
})

test("re-uploading the same project file replaces the visible project entry", async () => {
  cleanup = await mkdtemp(join(tmpdir(), "factorysight-dedupe-"))
  const projectRoot = join(cleanup, "workspace")

  const first = await saveUploadedFile({
    projectId: "prj_1",
    projectPath: projectRoot,
    scope: "project",
    uploadedBy: "usr_1",
    file: new File(["first"], "schedule.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  })
  const second = await saveUploadedFile({
    projectId: "prj_1",
    projectPath: projectRoot,
    scope: "project",
    uploadedBy: "usr_1",
    file: new File(["second"], "schedule.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }),
  })

  const files = await listProjectFiles(projectRoot)
  expect(files.filter((file) => file.scope === "project" && file.originalName === "schedule.xlsx")).toHaveLength(1)
  expect(files[0]).toMatchObject({
    id: first.id,
    relativePath: first.relativePath,
    size: second.size,
    originalName: "schedule.xlsx",
  })
})

test("listing project files collapses existing duplicate project manifest entries", async () => {
  cleanup = await mkdtemp(join(tmpdir(), "factorysight-existing-duplicates-"))
  const projectRoot = join(cleanup, "workspace")
  await mkdir(join(projectRoot, ".factorysight", "metadata"), { recursive: true })
  await writeFile(
    join(projectRoot, ".factorysight", "metadata", "files.json"),
    JSON.stringify([
      {
        id: "file_old",
        projectId: "prj_1",
        scope: "project",
        name: "schedule.xlsx",
        originalName: "schedule.xlsx",
        relativePath: ".factorysight/uploads/project/schedule.xlsx",
        size: 10,
        type: "application/octet-stream",
        uploadedBy: "usr_1",
        createdAt: "2026-07-06T00:00:00.000Z",
      },
      {
        id: "file_new",
        projectId: "prj_1",
        scope: "project",
        name: "schedule-1.xlsx",
        originalName: "schedule.xlsx",
        relativePath: ".factorysight/uploads/project/schedule-1.xlsx",
        size: 20,
        type: "application/octet-stream",
        uploadedBy: "usr_1",
        createdAt: "2026-07-06T00:01:00.000Z",
      },
    ]),
  )

  const files = await listProjectFiles(projectRoot)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatchObject({ id: "file_new", size: 20 })
})
