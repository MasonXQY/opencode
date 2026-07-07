import { Hono } from "hono"
import { cors } from "hono/cors"
import { z } from "zod"
import path from "node:path"
import { readFile } from "node:fs/promises"
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
import {
  backendAgents,
  backendModels,
  backendTasks,
  enqueueBackendTask,
  enqueueBackendTaskChain,
  remoteBackendMode,
} from "./backend"
import { childPrompt, initialOrchestrationPlan } from "./orchestration"
import { permissionProfiles, type Artifact, type Project, type Task, type User } from "./shared"
import { listProjectFiles, saveUploadedFile } from "./file-storage"
import { listProjectArtifacts, writeTaskDeliverableArtifact } from "./artifact-storage"
import {
  completeGmailAuthorization,
  gmailAuthorizationUrl,
  gmailSetupStatus,
  importGmailMessages,
} from "./gmail-client"
import { clearGmailToken, gmailStatus } from "./gmail-storage"

export const app = new Hono<{ Variables: { user: User } }>()
const sourceDir =
  typeof import.meta.dirname === "string" ? import.meta.dirname : path.dirname(new URL(import.meta.url).pathname)
const clientDir = path.resolve(
  process.env.FACTORYSIGHT_REMOTE_CLIENT_DIR ?? path.resolve(sourceDir, "..", "dist", "client"),
)

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
  intent: z.enum(["create", "modify"]).default("create"),
  parentTaskId: z.string().optional(),
})
const addMessageSchema = z.object({ text: z.string().min(1) })
const updateTaskSchema = z.object({
  status: z.enum(["archived"]).optional(),
})
const shareTaskSchema = z.object({
  userId: z.string().min(1),
  role: z.enum(["owner", "collaborator", "reviewer", "viewer"]).default("collaborator"),
})
const gmailImportSchema = z.object({
  query: z.string().optional(),
  maxResults: z.number().int().min(1).max(25).default(10),
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
  if (c.req.path === "/api/integrations/gmail/callback") return next()
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
app.use("/api/integrations/*", requireUser)
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

async function visibleBackendTasks(userId: string) {
  const projects = await visibleProjects(userId)
  return backendTasks(await visibleTasks(userId), projects, userId)
}

async function getVisibleBackendTask(taskId: string, userId: string) {
  const localTask = await getVisibleTask(taskId, userId)
  if (localTask) return localTask
  if (!taskId.startsWith("fs_")) return
  return (await visibleBackendTasks(userId)).find((task) => task.id === taskId)
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
      intent: formString(form, "intent", "create"),
      parentTaskId: formString(form, "parentTaskId") || undefined,
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

async function visibleArtifacts(userId: string) {
  const projects = await visibleProjects(userId)
  const tasks = await visibleTasks(userId)
  await Promise.all(
    tasks.map(async (task) => {
      const deliverable = task.events.filter((event) => event.type === "deliverable").at(-1)
      const project = projects.find((item) => item.id === task.projectId)
      if (!project || !deliverable) return
      await writeTaskDeliverableArtifact(task, project.path, deliverable.text).catch(() => {})
    }),
  )
  const nested = await Promise.all(projects.map((project) => listProjectArtifacts(project)))
  return nested.flat()
}

app.get("/api/app/bootstrap", async (c) => {
  const user = c.get("user")
  const state = await getState()
  const projects = await visibleProjects(user.id)
  const agents = await backendAgents()
  return c.json({
    user,
    users: state.users,
    projects,
    tasks: await backendTasks(await visibleTasks(user.id), projects, user.id),
    artifacts: await visibleArtifacts(user.id),
    files: (await Promise.all(projects.map((project) => listProjectFiles(project.path)))).flat(),
    agents: agents.agents,
    agentProfiles: agents.agentProfiles,
    models: await backendModels(),
    backendMode: remoteBackendMode(),
    gmail: { ...(await gmailStatus(user.id)), ...gmailSetupStatus() },
    permissionProfiles,
  })
})

app.get("/api/integrations/gmail/status", async (c) => {
  return c.json({ ...(await gmailStatus(c.get("user").id)), ...gmailSetupStatus() })
})

app.post("/api/integrations/gmail/connect", async (c) => {
  try {
    return c.json({ url: await gmailAuthorizationUrl(c.get("user").id) })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.get("/api/integrations/gmail/callback", async (c) => {
  const code = c.req.query("code")
  const state = c.req.query("state")
  if (!code || !state) return c.text("Missing Gmail authorization code or state", 400)
  await completeGmailAuthorization({ code, state })
  return c.html(`<!doctype html>
<html>
  <head>
    <title>Gmail connected</title>
    <style>
      body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: #f7f7f5; color: #18191b; }
      main { display: grid; gap: 8px; padding: 24px; border: 1px solid #deded9; background: white; }
      strong { font-size: 16px; }
      p { margin: 0; color: #6f7178; }
    </style>
  </head>
  <body>
    <main>
      <strong>Gmail connected</strong>
      <p>You can close this window.</p>
    </main>
    <script>
      try {
        window.opener?.postMessage({ type: "factorysight:gmail-connected" }, window.location.origin);
      } catch {}
      setTimeout(() => window.close(), 700);
    </script>
  </body>
</html>`)
})

app.delete("/api/integrations/gmail", async (c) => {
  await clearGmailToken(c.get("user").id)
  return c.json({ connected: false })
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

app.post("/api/projects/:projectId/gmail/import", async (c) => {
  const user = c.get("user")
  const project = await visibleProject(c.req.param("projectId"), user.id)
  if (!project) return c.json({ error: "project not found" }, 404)
  const body = gmailImportSchema.parse(await c.req.json())
  const imported = await importGmailMessages({ userId: user.id, query: body.query, maxResults: body.maxResults })
  const fileName = `gmail-${Date.now()}.json`
  const file = await saveUploadedFile({
    projectId: project.id,
    projectPath: project.path,
    scope: "project",
    uploadedBy: user.id,
    file: new File([JSON.stringify(imported, null, 2)], fileName, { type: "application/json" }),
  })
  return c.json({ file, imported: imported.messages.length })
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
  return c.json(await visibleBackendTasks(c.get("user").id))
})

app.post("/api/tasks", async (c) => {
  const user = c.get("user")
  const { body, files } = await parseCreateTask(c)
  const project = await visibleProject(body.projectId, user.id)
  if (!project) return c.json({ error: "project not found" }, 404)
  let task = await createTask({ ...body, creatorId: user.id })
  task = await attachFiles(project, task, files, user.id)
  enqueueBackendTask(task)
  return c.json(task)
})

app.post("/api/orchestrations", async (c) => {
  const user = c.get("user")
  const { body, files } = await parseCreateOrchestration(c)
  const project = await visibleProject(body.projectId, user.id)
  if (!project) return c.json({ error: "project not found" }, 404)

  if (body.intent === "modify") {
    const tasks = await visibleTasks(user.id)
    const parent =
      (body.parentTaskId ? tasks.find((task) => task.id === body.parentTaskId) : undefined) ??
      tasks.find((task) => task.projectId === body.projectId && task.kind === "orchestration")
    if (!parent || parent.projectId !== body.projectId) return c.json({ error: "workflow not found" }, 404)

    await attachFiles(project, parent, files, user.id)
    await appendEvent(parent.id, {
      type: "message",
      authorId: user.id,
      text: `Workflow change requested: ${body.prompt}`,
    })

    const steps = initialOrchestrationPlan(body.prompt, body.scale)
    const children: Task[] = []
    const parentContext = { ...parent, title: body.title, prompt: body.prompt }
    for (const step of steps) {
      const child = await createTask({
        creatorId: user.id,
        projectId: body.projectId,
        parentTaskId: parent.id,
        title: step.title,
        prompt: childPrompt(parentContext, step),
        agent: step.agent,
        model: body.model,
        collaboration: body.collaboration,
        kind: "single",
      })
      children.push(child)
      await appendEvent(parent.id, {
        type: "system",
        text: `Queued workflow update ${step.phase} phase role ${step.agent}: ${step.title}`,
      })
    }

    const existingChildIds =
      parent.childTaskIds ?? tasks.filter((task) => task.parentTaskId === parent.id).map((task) => task.id)
    await patchTask(parent.id, { childTaskIds: [...existingChildIds, ...children.map((child) => child.id)] })
    await appendEvent(parent.id, {
      type: "system",
      text: `FactorySight queued ${children.length} workflow update steps. The topology will continue adapting as these nodes run.`,
    })
    enqueueBackendTaskChain(parent.id, children, body.scale)
    return c.json(
      children[0] ?? { ...parent, childTaskIds: [...existingChildIds, ...children.map((child) => child.id)] },
    )
  }

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
    text: `Autonomous Agent Swarm queued in ${body.scale} mode. Main planning runs first, then specialist roles run in sequence.`,
  })

  const steps = initialOrchestrationPlan(body.prompt, body.scale)
  const children: Task[] = []
  for (const step of steps) {
    const child = await createTask({
      creatorId: user.id,
      projectId: body.projectId,
      parentTaskId: parent.id,
      title: step.title,
      prompt: childPrompt(parent, step),
      agent: step.agent,
      model: body.model,
      collaboration: body.collaboration,
      kind: "single",
    })
    children.push(child)
    await appendEvent(parent.id, {
      type: "system",
      text: `Queued initial ${step.phase} phase role ${step.agent}: ${step.title}`,
    })
  }

  await patchTask(parent.id, { childTaskIds: children.map((child) => child.id) })
  await appendEvent(parent.id, {
    type: "system",
    text: `Orchestrator created ${children.length} initial steps. The topology can adapt while the workflow is running.`,
  })
  enqueueBackendTaskChain(parent.id, children, body.scale)
  return c.json({ ...parent, childTaskIds: children.map((child) => child.id) })
})

app.get("/api/tasks/:taskId/files", async (c) => {
  const user = c.get("user")
  const task = await getVisibleBackendTask(c.req.param("taskId"), user.id)
  if (!task) return c.json({ error: "task not found" }, 404)
  const project = await visibleProject(task.projectId, user.id)
  if (!project) return c.json({ error: "project not found" }, 404)
  return c.json((await listProjectFiles(project.path)).filter((file) => file.taskId === task.id))
})

app.get("/api/tasks/:taskId", async (c) => {
  const task = await getVisibleBackendTask(c.req.param("taskId"), c.get("user").id)
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
  const task = await getVisibleBackendTask(c.req.param("taskId"), user.id)
  if (!task) return c.json({ error: "task not found" }, 404)

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      for (const event of task.events) send(event)
      if (task.id.startsWith("fs_")) {
        controller.close()
        return
      }
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
  return (
    (await staticResponse(path.join(clientDir, "index.html"))) ?? c.text("FactorySight Remote is not built yet.", 503)
  )
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
