import { mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Artifact, Project, Task } from "./shared"

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-") || "artifact"
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function artifactRoot(projectPath: string) {
  return path.join(projectPath, "artifacts")
}

function toPosix(value: string) {
  return value.split(path.sep).join("/")
}

export async function writeTaskDeliverableArtifact(task: Task, projectPath: string, text: string) {
  const dir = path.join(artifactRoot(projectPath), "tasks", safeSegment(task.id))
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, "deliverable.html")
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(task.title)} - FactorySight Deliverable</title>`,
    "<style>",
    "body{margin:0;background:#f6f6f4;color:#242426;font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
    "main{max-width:880px;margin:48px auto;padding:32px;background:white;border:1px solid rgba(28,28,30,.12);border-radius:16px}",
    "h1{margin:0 0 8px;font-size:24px;line-height:1.2}",
    "p{margin:0 0 24px;color:#747579}",
    "pre{white-space:pre-wrap;word-break:break-word;margin:0;padding:18px;border-radius:12px;background:#f7f7f6;border:1px solid rgba(28,28,30,.1);font:13px/1.55 SFMono-Regular,Consolas,monospace}",
    "</style>",
    "</head>",
    "<body>",
    "<main>",
    `<h1>${escapeHtml(task.title)}</h1>`,
    `<p>${escapeHtml(task.agent)} / ${escapeHtml(task.model)}</p>`,
    `<pre>${escapeHtml(text)}</pre>`,
    "</main>",
    "</body>",
    "</html>",
  ].join("\n")
  await writeFile(filePath, html)
  return {
    projectId: task.projectId,
    name: `${task.title} deliverable`,
    relativePath: toPosix(path.relative(artifactRoot(projectPath), filePath)),
  } satisfies Artifact
}

export async function listProjectArtifacts(project: Project): Promise<Artifact[]> {
  const root = artifactRoot(project.path)
  const rootResolved = path.resolve(root)
  const out: Artifact[] = []

  async function walk(dir: string, depth: number) {
    if (depth > 4) return
    let entries: { name: string; isDirectory: () => boolean }[] = []
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      const full = path.resolve(dir, entry.name)
      if (!full.startsWith(rootResolved)) continue
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.name.endsWith(".html")) continue
      const relativePath = toPosix(path.relative(rootResolved, full))
      out.push({
        projectId: project.id,
        name:
          relativePath
            .replace(/\/index\.html$/i, "")
            .replace(/\/deliverable\.html$/i, " deliverable")
            .replace(/\.html$/i, "") || "artifact",
        relativePath,
      })
    }
  }

  await walk(rootResolved, 0)
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}
