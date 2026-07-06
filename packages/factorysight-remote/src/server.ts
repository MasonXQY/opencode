import { Hono } from "hono"
import { cors } from "hono/cors"
import { z } from "zod"
import path from "node:path"
import { readFile, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import {
  appendEvent,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getState,
  getVisibleTask,
  login,
  patchTask,
  setTaskStatus,
  shareTask,
  subscribe,
  updateProject,
  userForToken,
  visibleProjects,
  visibleTasks,
} from "./store"
import { enqueueTask } from "./runner"
import { agentProfiles, defaultAgents, permissionProfiles, type Artifact, type Project, type Task, type User } from "./shared"
import { availableModels } from "./models"
import { listProjectFiles, saveUploadedFile } from "./file-storage"

export const app = new Hono<{ Variables: { user: User } }>()
const sourceDir = typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(new URL(import.meta.url).pathname)
const clientDir = path.resolve(process.env.FACTORYSIGHT_REMOTE_CLIENT_DIR ?? path.resolve(sourceDir, "..", "dist", "client"))

const loginSchema = z.object({ email: z.string().email() })
const createProjectSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  permissionLevel: z.enum(["ask", "read_only", "auto_safe", "full_auto"]).optional(),
  collaboratorIds: z.array(z.string()).optional(),
})
const updateProjectSchema = z.object({
  permissionLevel: z.enum(["ask", "read_only", "auto_safe", "full_auto"]).optional(),
})
const createTaskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  agent: z.string().min(1),
  model: z.string().min(1),
  collaboration: z.enum(["private", "project", "shared"]).default("project"),
})
const createOrchestrationSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  prompt: z.string().min(1),
  model: z.string().min(1),
  collaboration: z.enum(["private", "project", "shared"]).default("project"),
  scale: z.enum(["focused", "balanced", "wide"]).default("balanced"),
})
const addMessageSchema = z.object({ text: z.string().min(1) })
const updateTaskSchema = z.object({
  status: z.enum(["archived"]).optional(),
})
const shareTaskSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["owner", "collaborator", "reviewer", "viewer"]).default("collaborator"),
})
const maxUploadBytes = 25 * 1024 * 1024
type FormLike = {
  get(key: string): unknown
  getAll(key: string): unknown[]
}

function tokenFromHeader(header: string | undefined) {
  if (!header) return
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match?.[1]
}

function tokenFromCookie(header: string | undefined) {
  if (!header) return
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=")
    if (rawKey === "factorysight_artifact_token") return decodeURIComponent(rawValue.join("="))
  }
}

async function requireUser(c: any, next: any) {
  const user = await userForToken(
    tokenFromHeader(c.req.header("authorization")) ?? c.req.query("token") ?? tokenFromCookie(c.req.header("cookie")),
  )
  if (!user) return c.json({ error: "unauthorized" }, 401)
  c.set("user", user)
  return next()
}

app.use("/api/*", cors())

app.post("/api/login", async (c) => {
  const body = loginSchema.parse(await c.req.json())
  return c.json(await login(body.email))
})

app.use("/api/app/*", requireUser)
app.use("/api/projects", requireUser)
app.use("/api/projects/*", requireUser)
app.use("/api/permissions", requireUser)
app.use("/api/tasks", requireUser)
app.use("/api/tasks/*", requireUser)
app.use("/api/orchestrations", requireUser)

function isMultipart(c: any) {
  return c.req.header("content-type")?.toLowerCase().includes("multipart/form-data")
}

function formString(form: FormLike, key: string, fallback = "") {
  const value = form.get(key)
  return typeof value === "string" ? value : fallback
}

function formFiles(form: FormLike) {
  return [...form.getAll("files"), ...form.getAll("attachments")].filter(
    (value): value is File => value instanceof File && value.size > 0,
  )
}

function assertUploadLimits(files: File[]) {
  for (const file of files) {
    if (file.size > maxUploadBytes) throw new Error(`${file.name} is larger than 25MB`)
  }
}

async function visibleProject(projectId: string, userId: string) {
  return (await visibleProjects(userId)).find((item) => item.id === projectId)
}

async function parseCreateTask(c: any) {
  if (!isMultipart(c)) return { body: createTaskSchema.parse(await c.req.json()), files: [] as File[] }
  const form = await c.req.raw.formData()
  const files = formFiles(form)
  assertUploadLimits(files)
  return {
    body: createTaskSchema.parse({
      projectId: formString(form, "projectId"),
      title: formString(form, "title"),
      prompt: formString(form, "prompt"),
      agent: formString(form, "agent"),
      model: formString(form, "model"),
      collaboration: formString(form, "collaboration", "project"),
    }),
    files,
  }
}

async function parseCreateOrchestration(c: any) {
  if (!isMultipart(c)) return { body: createOrchestrationSchema.parse(await c.req.json()), files: [] as File[] }
  const form = await c.req.raw.formData()
  const files = formFiles(form)
  assertUploadLimits(files)
  return {
    body: createOrchestrationSchema.parse({
      projectId: formString(form, "projectId"),
      title: formString(form, "title"),
      prompt: formString(form, "prompt"),
      model: formString(form, "model"),
      collaboration: formString(form, "collaboration", "project"),
      scale: formString(form, "scale", "balanced"),
    }),
    files,
  }
}

async function attachFiles(project: Project, task: Task, files: File[], userId: string) {
  if (files.length === 0) return task
  const saved = await Promise.all(
    files.map((file) =>
      saveUploadedFile({
        projectId: project.id,
        projectPath: project.path,
        taskId: task.id,
        scope: "task",
        uploadedBy: userId,
        file,
      }),
    ),
  )
  await patchTask(task.id, { fileIds: saved.map((file) => file.id) })
  await appendEvent(task.id, {
    type: "system",
    text: `Attached ${saved.length} file${saved.length === 1 ? "" : "s"}:\n${saved
      .map((file) => `- ${file.relativePath}`)
      .join("\n")}`,
  })
  return { ...task, fileIds: saved.map((file) => file.id) }
}

function orchestrationPlan(prompt: string, scale: "focused" | "balanced" | "wide") {
  const normalized = prompt.toLowerCase()
  const agents = [
    {
      agent: "product-lead",
      title: "Shape product intent and acceptance criteria",
      brief: "Clarify user value, scope, edge cases, and acceptance criteria.",
    },
    {
      agent: "tech-lead",
      title: "Design implementation approach",
      brief: "Choose architecture, sequencing, risks, and integration points.",
    },
  ]

  if (scale !== "focused" && /(architecture|platform|scale|tenant|安全边界|架构|平台|多用户|权限)/i.test(normalized)) {
    agents.push({
      agent: "architect",
      title: "Map system architecture",
      brief: "Define boundaries, state flow, risks, and long-term architecture constraints.",
    })
  }

  if (/(ui|frontend|web|mobile|page|screen|ux|界面|前端|手机|体验)/i.test(normalized)) {
    agents.push({
      agent: "ux-designer",
      title: "Shape user workflow",
      brief: "Design the interaction model, information hierarchy, and task flow.",
    })
    agents.push({
      agent: "frontend-engineer",
      title: "Implement user-facing experience",
      brief: "Build the responsive UI, states, and interaction flow.",
    })
  }

  if (/(api|backend|server|database|auth|runner|后端|接口|数据库)/i.test(normalized)) {
    agents.push({
      agent: "backend-engineer",
      title: "Implement backend capability",
      brief: "Build APIs, storage behavior, permissions, and runner integration.",
    })
  }

  if (scale === "wide" || /(security|auth|permission|public|internet|公网|安全|登录|权限)/i.test(normalized)) {
    agents.push({
      agent: "security-reviewer",
      title: "Review security and isolation",
      brief: "Check exposure, permissions, credentials, and cross-user isolation.",
    })
  }

  if (scale === "wide" || /(deploy|ops|server|tunnel|cloud|部署|运维|公网)/i.test(normalized)) {
    agents.push({
      agent: "devops-engineer",
      title: "Check deployment and operations",
      brief: "Validate service startup, health, exposure model, and operational risks.",
    })
  }

  if (scale === "wide" || /(docs|readme|north star|文档|说明)/i.test(normalized)) {
    agents.push({
      agent: "technical-writer",
      title: "Prepare handoff notes",
      brief: "Document decisions, operating steps, and follow-up work.",
    })
  }

  agents.push(
    {
      agent: "build",
      title: "Execute implementation",
      brief: "Make the code changes needed to deliver the target behavior.",
    },
    {
      agent: "qa-engineer",
      title: "Verify behavior",
      brief: "Check build, type safety, core flows, and regression risk.",
    },
    {
      agent: "code-reviewer",
      title: "Review final changes",
      brief: "Look for bugs, missing tests, security issues, and unclear behavior.",
    },
  )

  const seen = new Set<string>()
  const unique = agents.filter((item) => {
    if (seen.has(item.agent)) return false
    seen.add(item.agent)
    return true
  })
  if (scale === "focused") return unique.slice(0, 4)
  if (scale === "balanced") return unique.slice(0, 8)
  return unique
}

function childPrompt(parent: Task, agent: string, brief: string) {
  return [
    `You are the ${agent} sub-agent in an autonomous FactorySight orchestration.`,
    `Parent objective: ${parent.prompt}`,
    `Your responsibility: ${brief}`,
    "Work in your own bounded context. Do not assume other sub-agents saw your local reasoning.",
    "Return only task-relevant findings, concrete changes, verification notes, and handoff context for the orchestrator.",
  ].join("\n\n")
}

async function artifactFiles(project: Project): Promise<Artifact[]> {
  const root = path.join(project.path, "artifacts")
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
      const relativePath = path.relative(rootResolved, full)
      out.push({
        projectId: project.id,
        name: relativePath.replace(/\/index\.html$/i, "").replace(/\.html$/i, "") || "artifact",
        relativePath,
      })
    }
  }

  await walk(rootResolved, 0)
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

async function visibleArtifacts(userId: string) {
  const projects = await visibleProjects(userId)
  const nested = await Promise.all(projects.map((project) => artifactFiles(project)))
  return nested.flat()
}

app.get("/api/app/bootstrap", async (c) => {
  const user = c.get("user")
  const state = await getState()
  return c.json({
    user,
    users: state.users,
    projects: await visibleProjects(user.id),
    tasks: await visibleTasks(user.id),
    artifacts: await visibleArtifacts(user.id),
    files: (await Promise.all((await visibleProjects(user.id)).map((project) => listProjectFiles(project.path)))).flat(),
    agents: defaultAgents,
    agentProfiles,
    models: await availableModels(),
    permissionProfiles,
  })
})

app.get("/api/projects/:projectId/artifacts/*", async (c) => {
  const project = (await visibleProjects(c.get("user").id)).find((item) => item.id === c.req.param("projectId"))
  if (!project) return c.json({ error: "project not found" }, 404)

  const artifactRoot = path.resolve(project.path, "artifacts")
  const rawPath = c.req.path.split(`/api/projects/${project.id}/artifacts/`)[1] ?? ""
  const requested = path.resolve(artifactRoot, decodeURIComponent(rawPath))
  if (!requested.startsWith(artifactRoot)) return c.json({ error: "artifact path not allowed" }, 403)

  const headers = new Headers({ "Content-Type": contentType(requested) })
  const token = c.req.query("token")
  if (token) {
    headers.set(
      "Set-Cookie",
      `factorysight_artifact_token=${encodeURIComponent(token)}; Path=/api/projects/${project.id}/artifacts; SameSite=Lax`,
    )
  }
  try {
    return new Response(await readFile(requested), { headers })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return c.json({ error: "artifact not found" }, 404)
    }
    throw error
  }
})

app.get("/api/projects", async (c) => {
  return c.json(await visibleProjects(c.get("user").id))
})

app.get("/api/projects/:projectId/files", async (c) => {
  const project = await visibleProject(c.req.param("projectId"), c.get("user").id)
  if (!project) return c.json({ error: "project not found" }, 404)
  return c.json(await listProjectFiles(project.path))
})

app.post("/api/projects/:projectId/files", async (c) => {
  const user = c.get("user")
  const project = await visibleProject(c.req.param("projectId"), user.id)
  if (!project) return c.json({ error: "project not found" }, 404)
  const form = await c.req.raw.formData()
  const files = formFiles(form)
  assertUploadLimits(files)
  const saved = await Promise.all(
    files.map((file) =>
      saveUploadedFile({
        projectId: project.id,
        projectPath: project.path,
        scope: "project",
        uploadedBy: user.id,
        file,
      }),
    ),
  )
  return c.json({ files: saved })
})

app.get("/api/projects/:projectId/files/:fileId", async (c) => {
  const project = await visibleProject(c.req.param("projectId"), c.get("user").id)
  if (!project) return c.json({ error: "project not found" }, 404)
  const file = (await listProjectFiles(project.path)).find((item) => item.id === c.req.param("fileId"))
  if (!file) return c.json({ error: "file not found" }, 404)
  const uploadRoot = path.resolve(project.path, ".factorysight", "uploads")
  const requested = path.resolve(project.path, file.relativePath)
  if (!requested.startsWith(uploadRoot)) return c.json({ error: "file path not allowed" }, 403)
  return new Response(await readFile(requested), { headers: { "Content-Type": contentType(requested) } })
})

app.get("/api/permissions", async (c) => {
  return c.json({
    profiles: permissionProfiles,
    projects: (await visibleProjects(c.get("user").id)).map((project) => ({
      projectId: project.id,
      name: project.name,
      permissionLevel: project.permissionLevel,
    })),
  })
})

app.post("/api/projects", async (c) => {
  const user = c.get("user")
  const body = createProjectSchema.parse(await c.req.json())
  return c.json(await createProject({ ...body, ownerId: user.id }))
})

app.patch("/api/projects/:projectId", async (c) => {
  const user = c.get("user")
  const body = updateProjectSchema.parse(await c.req.json())
  try {
    return c.json(await updateProject(c.req.param("projectId"), user.id, body))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 403)
  }
})

app.delete("/api/projects/:projectId", async (c) => {
  const user = c.get("user")
  try {
    return c.json(await deleteProject(c.req.param("projectId"), user.id))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 403)
  }
})

app.get("/api/projects/:projectId/permission", async (c) => {
  const project = (await visibleProjects(c.get("user").id)).find((item) => item.id === c.req.param("projectId"))
  if (!project) return c.json({ error: "project not found" }, 404)
  return c.json({
    projectId: project.id,
    permissionLevel: project.permissionLevel,
    profiles: permissionProfiles,
  })
})

app.put("/api/projects/:projectId/permission", async (c) => {
  const user = c.get("user")
  const body = updateProjectSchema.required().parse(await c.req.json())
  try {
    const project = await updateProject(c.req.param("projectId"), user.id, body)
    return c.json({
      projectId: project.id,
      permissionLevel: project.permissionLevel,
      profiles: permissionProfiles,
    })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 403)
  }
})

app.get("/api/tasks", async (c) => {
  return c.json(await visibleTasks(c.get("user").id))
})

app.post("/api/tasks", async (c) => {
  const user = c.get("user")
  const { body, files } = await parseCreateTask(c)
  const project = await visibleProject(body.projectId, user.id)
  if (!project) return c.json({ error: "project not found" }, 404)
  let task = await createTask({ ...body, creatorId: user.id })
  task = await attachFiles(project, task, files, user.id)
  enqueueTask(task)
  return c.json(task)
})

app.post("/api/orchestrations", async (c) => {
  const user = c.get("user")
  const { body, files } = await parseCreateOrchestration(c)
  const project = await visibleProject(body.projectId, user.id)
  if (!project) return c.json({ error: "project not found" }, 404)

  let parent = await createTask({
    creatorId: user.id,
    projectId: body.projectId,
    title: body.title || body.prompt.slice(0, 80),
    prompt: body.prompt,
    agent: "orchestrator",
    model: body.model,
    collaboration: body.collaboration,
    kind: "orchestration",
  })
  parent = await attachFiles(project, parent, files, user.id)
  await appendEvent(parent.id, {
    type: "system",
    text: `Autonomous Agent Swarm started in ${body.scale} mode.`,
  })

  const children: Task[] = []
  for (const step of orchestrationPlan(body.prompt, body.scale)) {
    const child = await createTask({
      creatorId: user.id,
      projectId: body.projectId,
      parentTaskId: parent.id,
      title: step.title,
      prompt: childPrompt(parent, step.agent, step.brief),
      agent: step.agent,
      model: body.model,
      collaboration: body.collaboration,
      kind: "single",
    })
    children.push(child)
    await appendEvent(parent.id, {
      type: "system",
      text: `Dispatched ${step.agent}: ${step.title}`,
    })
    enqueueTask(child)
  }

  await patchTask(parent.id, { childTaskIds: children.map((child) => child.id) })
  await appendEvent(parent.id, {
    type: "system",
    text: `Orchestrator created ${children.length} context shards and dispatched them in parallel.`,
  })
  await setTaskStatus(parent.id, "completed", "Sub-agent tasks dispatched")
  return c.json({ ...parent, childTaskIds: children.map((child) => child.id) })
})

app.get("/api/tasks/:taskId/files", async (c) => {
  const user = c.get("user")
  const task = await getVisibleTask(c.req.param("taskId"), user.id)
  if (!task) return c.json({ error: "task not found" }, 404)
  const project = await visibleProject(task.projectId, user.id)
  if (!project) return c.json({ error: "project not found" }, 404)
  return c.json((await listProjectFiles(project.path)).filter((file) => file.taskId === task.id))
})

app.get("/api/tasks/:taskId", async (c) => {
  const task = await getVisibleTask(c.req.param("taskId"), c.get("user").id)
  if (!task) return c.json({ error: "task not found" }, 404)
  return c.json(task)
})

app.patch("/api/tasks/:taskId", async (c) => {
  const user = c.get("user")
  const task = await getVisibleTask(c.req.param("taskId"), user.id)
  if (!task) return c.json({ error: "task not found" }, 404)
  const body = updateTaskSchema.parse(await c.req.json())
  if (body.status === "archived") {
    await setTaskStatus(task.id, "archived", "Task archived")
  }
  const updated = await getVisibleTask(task.id, user.id)
  return c.json(updated ?? task)
})

app.delete("/api/tasks/:taskId", async (c) => {
  const user = c.get("user")
  try {
    return c.json(await deleteTask(c.req.param("taskId"), user.id))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 403)
  }
})

app.post("/api/tasks/:taskId/messages", async (c) => {
  const user = c.get("user")
  const task = await getVisibleTask(c.req.param("taskId"), user.id)
  if (!task) return c.json({ error: "task not found" }, 404)
  const body = addMessageSchema.parse(await c.req.json())
  const event = await appendEvent(task.id, { type: "message", authorId: user.id, text: body.text })
  return c.json(event)
})

app.post("/api/tasks/:taskId/share", async (c) => {
  const user = c.get("user")
  const task = await getVisibleTask(c.req.param("taskId"), user.id)
  if (!task) return c.json({ error: "task not found" }, 404)
  if (task.creatorId !== user.id) return c.json({ error: "only the task creator can share this MVP task" }, 403)
  const body = shareTaskSchema.parse(await c.req.json())
  return c.json(await shareTask(task.id, body.userId, body.role))
})

app.get("/api/tasks/:taskId/events", async (c) => {
  const user = c.get("user")
  const task = await getVisibleTask(c.req.param("taskId"), user.id)
  if (!task) return c.json({ error: "task not found" }, 404)

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      for (const event of task.events) send(event)
      const unsubscribe = subscribe(task.id, send)
      const interval = setInterval(() => {
        controller.enqueue(encoder.encode(`: keepalive\n\n`))
      }, 15000)
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(interval)
        unsubscribe()
        controller.close()
      })
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
})

async function staticResponse(filePath: string) {
  const resolved = path.resolve(filePath)
  if (!resolved.startsWith(clientDir)) return
  try {
    return new Response(await readFile(filePath), { headers: { "Content-Type": contentType(resolved) } })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return
    throw error
  }
}

function contentType(filePath: string) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8"
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8"
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8"
  if (filePath.endsWith(".svg")) return "image/svg+xml"
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8"
  return "application/octet-stream"
}

app.get("*", async (c) => {
  const requestPath = new URL(c.req.url).pathname
  const filePath = requestPath === "/" ? path.join(clientDir, "index.html") : path.join(clientDir, requestPath)
  const response = await staticResponse(filePath)
  if (response) return response
  return (await staticResponse(path.join(clientDir, "index.html"))) ?? c.text("FactorySight Remote is not built yet.", 503)
})

const port = Number(process.env.PORT ?? process.env.FACTORYSIGHT_REMOTE_PORT ?? 3090)
const hostname = process.env.HOST ?? process.env.FACTORYSIGHT_REMOTE_HOST ?? "0.0.0.0"

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { serve } = await import("@hono/node-server")
  serve({
    hostname,
    port,
    fetch: app.fetch,
  })

  console.log(`FactorySight Remote listening on http://${hostname}:${port}`)
}
