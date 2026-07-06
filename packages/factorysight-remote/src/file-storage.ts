import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { FileAttachment } from "./shared"

const factoryDir = ".factorysight"
const uploadsDir = path.join(factoryDir, "uploads")
const metadataDir = path.join(factoryDir, "metadata")
const manifestName = "files.json"

function now() {
  return new Date().toISOString()
}

function toPosix(value: string) {
  return value.split(path.sep).join("/")
}

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-") || "file"
}

function sanitizeFileName(name: string) {
  const parsed = path.parse(path.basename(name).replaceAll("\\", "/"))
  const base = safeSegment(parsed.name).replace(/^-+|-+$/g, "") || "file"
  const ext = safeSegment(parsed.ext).replace(/^-+/g, "")
  return `${base}${ext}`
}

function manifestPath(projectPath: string) {
  return path.join(projectPath, metadataDir, manifestName)
}

async function readManifest(projectPath: string): Promise<FileAttachment[]> {
  try {
    return JSON.parse(await readFile(manifestPath(projectPath), "utf8")) as FileAttachment[]
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

async function writeManifest(projectPath: string, files: FileAttachment[]) {
  await mkdir(path.join(projectPath, metadataDir), { recursive: true })
  await writeFile(manifestPath(projectPath), JSON.stringify(files, null, 2))
}

function fileKey(file: FileAttachment) {
  if (file.scope === "project") return `${file.projectId}:project:${file.originalName}`
  return `${file.projectId}:task:${file.taskId}:${file.originalName}:${file.relativePath}`
}

function dedupeFiles(files: FileAttachment[]) {
  const byKey = new Map<string, FileAttachment>()
  for (const file of files) {
    const key = fileKey(file)
    const existing = byKey.get(key)
    if (!existing || new Date(file.createdAt).getTime() >= new Date(existing.createdAt).getTime()) {
      byKey.set(key, file)
    }
  }
  return [...byKey.values()].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
}

async function uniqueFilePath(dir: string, fileName: string) {
  const parsed = path.parse(fileName)
  let candidate = path.join(dir, fileName)
  let index = 1
  while (true) {
    try {
      await readFile(candidate)
      candidate = path.join(dir, `${parsed.name}-${index}${parsed.ext}`)
      index += 1
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return candidate
      throw error
    }
  }
}

export async function createProjectFolders(projectPath: string) {
  await mkdir(path.join(projectPath, uploadsDir, "project"), { recursive: true })
  await mkdir(path.join(projectPath, uploadsDir, "tasks"), { recursive: true })
  await mkdir(path.join(projectPath, metadataDir), { recursive: true })
}

export async function saveUploadedFile(input: {
  projectId: string
  projectPath: string
  taskId?: string
  scope: "project" | "task"
  uploadedBy: string
  file: File
}) {
  await createProjectFolders(input.projectPath)
  const targetDir =
    input.scope === "project"
      ? path.join(input.projectPath, uploadsDir, "project")
      : path.join(input.projectPath, uploadsDir, "tasks", safeSegment(input.taskId ?? "unassigned"))
  await mkdir(targetDir, { recursive: true })

  const files = await readManifest(input.projectPath)
  const existing =
    input.scope === "project"
      ? files.find(
          (file) =>
            file.scope === "project" &&
            file.projectId === input.projectId &&
            file.originalName === input.file.name,
        )
      : undefined
  const targetPath = existing
    ? path.join(input.projectPath, existing.relativePath)
    : await uniqueFilePath(targetDir, sanitizeFileName(input.file.name))
  await writeFile(targetPath, Buffer.from(await input.file.arrayBuffer()))

  const relativePath = toPosix(path.relative(input.projectPath, targetPath))
  const attachment: FileAttachment = {
    id: existing?.id ?? `file_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    projectId: input.projectId,
    taskId: input.taskId,
    scope: input.scope,
    name: path.basename(targetPath),
    originalName: input.file.name,
    relativePath,
    size: input.file.size,
    type: input.file.type || "application/octet-stream",
    uploadedBy: input.uploadedBy,
    createdAt: now(),
  }

  if (existing) {
    files.splice(files.indexOf(existing), 1, attachment)
  } else {
    files.push(attachment)
  }
  await writeManifest(input.projectPath, files)
  return attachment
}

export async function listProjectFiles(projectPath: string) {
  const files = await readManifest(projectPath)
  const deduped = dedupeFiles(files)
  if (deduped.length !== files.length) await writeManifest(projectPath, deduped)
  return deduped
}

export async function deleteTaskFiles(projectPath: string, taskIds: string[]) {
  const ids = new Set(taskIds)
  const files = await readManifest(projectPath)
  const remaining = files.filter((file) => !file.taskId || !ids.has(file.taskId))
  await writeManifest(projectPath, remaining)
  for (const taskId of ids) {
    await rm(path.join(projectPath, uploadsDir, "tasks", safeSegment(taskId)), { recursive: true, force: true })
  }
}
