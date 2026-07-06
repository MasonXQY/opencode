import path from "node:path"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { defaultPermissionLevel, type AppState, type PermissionLevel, type Project, type Role, type Task, type TaskEvent, type TaskStatus, type User } from "./shared"

const defaultDataDir = path.join(process.env.HOME ?? process.cwd(), ".factorysight-remote")
const dataDir = process.env.FACTORYSIGHT_REMOTE_DATA ?? defaultDataDir
const statePath = path.join(dataDir, "state.json")

const demoUsers: User[] = [
  { id: "usr_mason", name: "Mason", email: "mason@example.local" },
  { id: "usr_product", name: "Product Lead", email: "product@example.local" },
  { id: "usr_engineering", name: "Engineering Lead", email: "engineering@example.local" },
]

let state: AppState | undefined
const subscribers = new Map<string, Set<(event: TaskEvent) => void>>()

function now() {
  return new Date().toISOString()
}

function id(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`
}

async function ensureLoaded() {
  if (state) return state
  await mkdir(dataDir, { recursive: true })
  await writeFile(path.join(dataDir, ".keep"), "")
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as AppState
    for (const project of state.projects) project.permissionLevel ??= defaultPermissionLevel
    return state
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
  }
  state = {
    users: demoUsers,
    sessions: [],
    projects: [],
    tasks: [],
  }
  await save()
  return state
}

async function save() {
  if (!state) return
  await writeFile(statePath, JSON.stringify(state, null, 2))
}

export async function getState() {
  return ensureLoaded()
}

export async function login(email: string) {
  const state = await ensureLoaded()
  const normalized = email.trim().toLowerCase()
  let user = state.users.find((item) => item.email.toLowerCase() === normalized)
  if (!user) {
    user = { id: id("usr"), name: email.split("@")[0] || "User", email: normalized }
    state.users.push(user)
  }
  const session = { token: id("tok"), userId: user.id, createdAt: now() }
  state.sessions.push(session)
  await save()
  return { user, token: session.token }
}

export async function userForToken(token: string | undefined) {
  if (!token) return
  const state = await ensureLoaded()
  const session = state.sessions.find((item) => item.token === token)
  if (!session) return
  return state.users.find((item) => item.id === session.userId)
}

export function canAccessProject(project: Project, userId: string) {
  return Boolean(project.memberships[userId])
}

export function projectRole(project: Project, userId: string): Role | undefined {
  return project.memberships[userId]
}

export function canAccessTask(state: AppState, task: Task, userId: string) {
  if (task.creatorId === userId) return true
  const project = state.projects.find((item) => item.id === task.projectId)
  if (!project) return false
  if (task.collaboration === "private") return false
  return canAccessProject(project, userId)
}

export async function createProject(input: {
  name: string
  path: string
  ownerId: string
  permissionLevel?: PermissionLevel
  collaboratorIds?: string[]
}) {
  const state = await ensureLoaded()
  const project: Project = {
    id: id("prj"),
    name: input.name.trim() || "Untitled project",
    path: input.path.trim() || process.cwd(),
    permissionLevel: input.permissionLevel ?? defaultPermissionLevel,
    createdAt: now(),
    memberships: {
      [input.ownerId]: "owner",
    },
  }
  for (const userId of input.collaboratorIds ?? []) {
    if (state.users.some((user) => user.id === userId)) project.memberships[userId] = "collaborator"
  }
  state.projects.push(project)
  await save()
  return project
}

export async function updateProject(
  projectId: string,
  userId: string,
  patch: { permissionLevel?: PermissionLevel },
) {
  const state = await ensureLoaded()
  const project = state.projects.find((item) => item.id === projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)
  if (project.memberships[userId] !== "owner") throw new Error("Only project owners can update project settings")
  if (patch.permissionLevel) project.permissionLevel = patch.permissionLevel
  await save()
  return project
}

export async function deleteProject(projectId: string, userId: string) {
  const state = await ensureLoaded()
  const project = state.projects.find((item) => item.id === projectId)
  if (!project) throw new Error(`Project not found: ${projectId}`)
  if (project.memberships[userId] !== "owner") throw new Error("Only project owners can delete projects")
  state.projects = state.projects.filter((item) => item.id !== projectId)
  const deletedTasks = state.tasks.filter((task) => task.projectId === projectId).map((task) => task.id)
  state.tasks = state.tasks.filter((task) => task.projectId !== projectId)
  for (const taskId of deletedTasks) subscribers.delete(taskId)
  await save()
  return { deletedProjectId: projectId, deletedTaskCount: deletedTasks.length }
}

export async function createTask(input: {
  creatorId: string
  projectId: string
  parentTaskId?: string
  kind?: Task["kind"]
  title: string
  prompt: string
  agent: string
  model: string
  collaboration: Task["collaboration"]
}) {
  const state = await ensureLoaded()
  const createdAt = now()
  const task: Task = {
    id: id("tsk"),
    projectId: input.projectId,
    creatorId: input.creatorId,
    parentTaskId: input.parentTaskId,
    kind: input.kind ?? "single",
    title: input.title.trim() || input.prompt.trim().slice(0, 80) || "Untitled task",
    prompt: input.prompt,
    agent: input.agent,
    model: input.model,
    status: "queued",
    collaboration: input.collaboration,
    createdAt,
    updatedAt: createdAt,
    events: [],
  }
  state.tasks.unshift(task)
  await appendEvent(task.id, {
    type: "created",
    authorId: input.creatorId,
    text: input.prompt,
  })
  return task
}

export async function setTaskStatus(taskId: string, status: TaskStatus, text?: string) {
  const state = await ensureLoaded()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) return
  task.status = status
  task.updatedAt = now()
  await save()
  if (text) await appendEvent(taskId, { type: "status", text })
}

export async function patchTask(
  taskId: string,
  patch: Partial<Pick<Task, "runnerPid" | "sessionId" | "childTaskIds">>,
) {
  const state = await ensureLoaded()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) return
  Object.assign(task, patch)
  task.updatedAt = now()
  await save()
}

export async function appendEvent(
  taskId: string,
  input: Omit<TaskEvent, "id" | "taskId" | "at"> & { at?: string },
) {
  const state = await ensureLoaded()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  const event: TaskEvent = {
    id: id("evt"),
    taskId,
    at: input.at ?? now(),
    type: input.type,
    authorId: input.authorId,
    text: input.text,
  }
  task.events.push(event)
  task.updatedAt = event.at
  await save()
  for (const subscriber of subscribers.get(taskId) ?? []) subscriber(event)
  return event
}

export function subscribe(taskId: string, callback: (event: TaskEvent) => void) {
  let set = subscribers.get(taskId)
  if (!set) {
    set = new Set()
    subscribers.set(taskId, set)
  }
  set.add(callback)
  return () => {
    set?.delete(callback)
    if (set?.size === 0) subscribers.delete(taskId)
  }
}

export async function visibleProjects(userId: string) {
  const state = await ensureLoaded()
  return state.projects.filter((item) => canAccessProject(item, userId))
}

export async function visibleTasks(userId: string) {
  const state = await ensureLoaded()
  return state.tasks.filter((item) => canAccessTask(state, item, userId))
}

export async function getVisibleTask(taskId: string, userId: string) {
  const state = await ensureLoaded()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) return
  if (!canAccessTask(state, task, userId)) return
  return task
}

export async function deleteTask(taskId: string, userId: string) {
  const state = await ensureLoaded()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  if (!canAccessTask(state, task, userId)) throw new Error("Task not found")
  const project = state.projects.find((item) => item.id === task.projectId)
  const isOwner = project?.memberships[userId] === "owner"
  if (task.creatorId !== userId && !isOwner) throw new Error("Only task creators or project owners can delete tasks")
  const deletedIds = new Set<string>([task.id])
  let changed = true
  while (changed) {
    changed = false
    for (const candidate of state.tasks) {
      if (candidate.parentTaskId && deletedIds.has(candidate.parentTaskId) && !deletedIds.has(candidate.id)) {
        deletedIds.add(candidate.id)
        changed = true
      }
    }
  }
  state.tasks = state.tasks
    .filter((item) => !deletedIds.has(item.id))
    .map((item) =>
      item.childTaskIds
        ? { ...item, childTaskIds: item.childTaskIds.filter((childId) => !deletedIds.has(childId)) }
        : item,
    )
  for (const deletedId of deletedIds) subscribers.delete(deletedId)
  await save()
  return { deletedTaskIds: [...deletedIds] }
}

export async function shareTask(taskId: string, userId: string, role: Role = "collaborator") {
  const state = await ensureLoaded()
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) throw new Error(`Task not found: ${taskId}`)
  const project = state.projects.find((item) => item.id === task.projectId)
  if (!project) throw new Error(`Project not found: ${task.projectId}`)
  project.memberships[userId] = role
  task.collaboration = "shared"
  task.updatedAt = now()
  await save()
  await appendEvent(taskId, { type: "system", text: `Shared with ${userId} as ${role}` })
  return task
}
