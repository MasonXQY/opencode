import { render } from "solid-js/web"
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { ApiClient } from "./api"
import type { Accessor } from "solid-js"
import {
  preferredDefaultModel,
  type BootstrapData,
  type PermissionLevel,
  type Project,
  type Task,
  type TaskEvent,
} from "./shared"
import "./styles.css"

const tokenKey = "factorysight.remote.token"
const designThemeKey = "factorysight.remote.designTheme"

const designThemes = [
  { id: "presight", name: "Presight", summary: "Bright operational workspace." },
  { id: "graphite", name: "Graphite", summary: "Quiet neutral dashboard." },
  { id: "terminal", name: "Terminal", summary: "Dark command-center style." },
  { id: "contrast", name: "Contrast", summary: "Sharper borders and focus." },
] as const

type DesignThemeId = (typeof designThemes)[number]["id"]

const productStyles = [
  {
    id: "operational",
    name: "Operational SaaS",
    summary: "Dense, practical, data-first product UI.",
    guidance:
      "Use a restrained operational SaaS style: dense but organized screens, compact controls, clear tables/lists, restrained color, low decoration, fast scanning.",
  },
  {
    id: "consumer",
    name: "Consumer App",
    summary: "Friendly, polished, accessible everyday product.",
    guidance:
      "Use a friendly consumer-app style: clear hierarchy, warm microcopy, comfortable spacing, visible primary actions, polished empty/loading/error states.",
  },
  {
    id: "editorial",
    name: "Editorial",
    summary: "Content-led, elegant, image-aware layout.",
    guidance:
      "Use an editorial product style: strong typographic hierarchy, immersive media when useful, generous reading rhythm, sections built around narrative flow.",
  },
  {
    id: "command-center",
    name: "Command Center",
    summary: "Dark, technical, monitoring-oriented interface.",
    guidance:
      "Use a command-center style: dark technical UI, clear system status, strong contrast, live logs/progress, compact panels, no decorative clutter.",
  },
] as const

type ProductStyleId = (typeof productStyles)[number]["id"]
type ManagerStatusFilter = "active" | "running" | "completed" | "failed" | "archived" | "all"
type PendingDelete = { kind: "project"; project: Project } | { kind: "task"; task: Task }

function readDesignTheme(): DesignThemeId {
  const value = localStorage.getItem(designThemeKey)
  return designThemes.some((theme) => theme.id === value) ? (value as DesignThemeId) : "presight"
}

function statusLabel(status: Task["status"]) {
  return status.replaceAll("_", " ")
}

function taskStage(task: Task) {
  if (task.parentTaskId) return "sub-agent"
  if (task.kind === "orchestration") return "swarm"
  return "single"
}

function time(value: string) {
  return new Date(value).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

function eventDigest(events: TaskEvent[]) {
  const errors = events.filter((event) => event.type === "error")
  const statuses = events.filter((event) => event.type === "status")
  const runner = events.filter((event) => event.type === "runner")
  const messages = events.filter((event) => event.type === "message")
  const deliverables = events.filter((event) => event.type === "deliverable")
  return {
    lastStatus: statuses.at(-1)?.text,
    lastOutput: runner.at(-1)?.text,
    errors,
    runner,
    messages,
    deliverables,
  }
}

function artifactUrl(projectId: string, relativePath: string, token: string | undefined) {
  const encoded = relativePath.split("/").map(encodeURIComponent).join("/")
  const suffix = token ? `?token=${encodeURIComponent(token)}` : ""
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encoded}${suffix}`
}

function progressValue(tasks: Task[]) {
  if (tasks.length === 0) return 0
  const done = tasks.filter((task) => task.status === "completed").length
  return Math.round((done / tasks.length) * 100)
}

function taskCounts(tasks: Task[]) {
  return {
    total: tasks.length,
    running: tasks.filter((task) => task.status === "running").length,
    queued: tasks.filter((task) => task.status === "queued").length,
    completed: tasks.filter((task) => task.status === "completed").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    active: tasks.filter((task) => !["archived", "completed", "failed"].includes(task.status)).length,
  }
}

function latestTask(tasks: Task[]) {
  return tasks
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .at(0)
}

function productPrompt(input: { prompt: string; style: ProductStyleId; styleNotes: string }) {
  const style = productStyles.find((item) => item.id === input.style) ?? productStyles[0]
  const notes = input.styleNotes.trim()
  return [
    input.prompt.trim(),
    "",
    "Design library selection:",
    `- Product style: ${style.name}`,
    `- Style guidance: ${style.guidance}`,
    notes ? `- User style preferences: ${notes}` : undefined,
    "",
    "Apply this style to the product being built, not to FactorySight Remote itself.",
  ]
    .filter(Boolean)
    .join("\n")
}

function AgentAvatar(props: { data: BootstrapData; agent: string; compact?: boolean }) {
  const profile = () => props.data.agentProfiles[props.agent]
  return (
    <div class="agent-identity" classList={{ compact: props.compact }}>
      <div class="agent-avatar" style={{ "--agent-color": profile()?.color ?? "#8d969f" }}>
        {profile()?.initials ?? props.agent.slice(0, 2).toUpperCase()}
      </div>
      <div>
        <strong>{profile()?.name ?? props.agent}</strong>
        <small>{profile()?.title ?? props.agent}</small>
      </div>
    </div>
  )
}

function App() {
  const [token, setToken] = createSignal(localStorage.getItem(tokenKey) ?? undefined)
  const [designTheme, setDesignTheme] = createSignal<DesignThemeId>(readDesignTheme())
  const api = new ApiClient(token())
  const [selectedTaskId, setSelectedTaskId] = createSignal<string | undefined>()
  const [error, setError] = createSignal<string | undefined>()

  createEffect(() => api.setToken(token()))
  createEffect(() => {
    document.documentElement.dataset.theme = designTheme()
    localStorage.setItem(designThemeKey, designTheme())
  })

  const [bootstrap, { refetch }] = createResource(token, async (currentToken) => {
    if (!currentToken) return undefined
    api.setToken(currentToken)
    try {
      return await api.bootstrap()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes("unauthorized")) {
        localStorage.removeItem(tokenKey)
        setToken(undefined)
        return undefined
      }
      throw err
    }
  })

  function logout() {
    localStorage.removeItem(tokenKey)
    setToken(undefined)
    setSelectedTaskId(undefined)
  }

  async function onLogin(email: string) {
    setError(undefined)
    try {
      const result = await api.login({ email })
      localStorage.setItem(tokenKey, result.token)
      api.setToken(result.token)
      setToken(result.token)
      await refetch()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Show when={token()} fallback={<Login error={error()} onLogin={onLogin} />}>
      <Show when={bootstrap()} fallback={<div class="loading">Loading FactorySight Remote...</div>}>
        {(data: Accessor<BootstrapData>) => (
          <Workspace
            data={data()}
            api={api}
            selectedTaskId={selectedTaskId()}
            onSelectTask={setSelectedTaskId}
            onRefresh={refetch}
            onLogout={logout}
            designTheme={designTheme()}
            onDesignThemeChange={setDesignTheme}
          />
        )}
      </Show>
    </Show>
  )
}

function Login(props: { error?: string; onLogin: (email: string) => Promise<void> }) {
  const [email, setEmail] = createSignal("mason@example.local")
  const [busy, setBusy] = createSignal(false)
  return (
    <main class="login-shell">
      <section class="login-panel">
        <div class="brand">FactorySight</div>
        <h1>Remote engineering workspace</h1>
        <p>Assign tasks, watch agent progress, approve work, and continue from any device.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            await props.onLogin(email())
            setBusy(false)
          }}
        >
          <label>
            Email
            <input value={email()} onInput={(event) => setEmail(event.currentTarget.value)} autocomplete="email" />
          </label>
          <button disabled={busy()}>{busy() ? "Opening..." : "Open workspace"}</button>
          <Show when={props.error}>
            <div class="error">{props.error}</div>
          </Show>
        </form>
      </section>
    </main>
  )
}

function Workspace(props: {
  data: BootstrapData
  api: ApiClient
  selectedTaskId: string | undefined
  onSelectTask: (id: string | undefined) => void
  onRefresh: () => void
  onLogout: () => void
  designTheme: DesignThemeId
  onDesignThemeChange: (theme: DesignThemeId) => void
}) {
  const newestProjectId = createMemo(() => props.data.projects.at(-1)?.id)
  const [activeProjectId, setActiveProjectId] = createSignal(newestProjectId())
  const [managerOpen, setManagerOpen] = createSignal(false)
  const activeProject = createMemo(() => props.data.projects.find((project) => project.id === activeProjectId()))
  const projectTasks = createMemo(() =>
    props.data.tasks.filter((task) => task.projectId === activeProjectId() && task.status !== "archived"),
  )
  const selectedTask = createMemo(() => projectTasks().find((task) => task.id === props.selectedTaskId))
  const counts = createMemo(() => taskCounts(projectTasks()))
  const freshestTask = createMemo(() => latestTask(projectTasks()))

  createEffect(() => {
    const current = activeProjectId()
    if (current && props.data.projects.some((project) => project.id === current)) return
    setActiveProjectId(newestProjectId())
  })

  createEffect(() => {
    if (props.selectedTaskId && selectedTask()) return
    props.onSelectTask(projectTasks()[0]?.id)
  })

  return (
    <main class="app-shell">
      <header class="topbar">
        <div class="topbar-primary">
          <div>
            <div class="brand">FactorySight Remote</div>
            <div class="muted">
              {props.data.user.name}
              <Show when={activeProject()}> · {activeProject()?.name}</Show>
            </div>
          </div>
          <div class="workspace-summary" aria-label="Workspace task summary">
            <span>
              <strong>{counts().active}</strong>
              Active
            </span>
            <span>
              <strong>{counts().running}</strong>
              Running
            </span>
            <span classList={{ attention: counts().failed > 0 }}>
              <strong>{counts().failed}</strong>
              Failed
            </span>
            <Show when={freshestTask()}>
              {(task) => <small>Last update: {task().title}</small>}
            </Show>
          </div>
        </div>
        <div class="topbar-actions">
          <DesignLibrarySwitcher value={props.designTheme} onChange={props.onDesignThemeChange} />
          <button class="ghost" type="button" onClick={() => setManagerOpen(true)}>
            Manage
          </button>
          <PermissionSwitcher
            project={activeProject()}
            profiles={props.data.permissionProfiles}
            api={props.api}
            onChanged={props.onRefresh}
          />
          <button class="ghost" onClick={props.onRefresh}>
            Refresh
          </button>
          <button class="ghost" onClick={props.onLogout}>
            Sign out
          </button>
        </div>
      </header>

      <section class="workspace-grid">
        <aside class="sidebar">
          <ProjectSwitcher
            projects={props.data.projects}
            activeProjectId={activeProjectId()}
            onChange={(id) => {
              setActiveProjectId(id)
              props.onSelectTask(undefined)
            }}
          />
          <ProjectForm
            data={props.data}
            api={props.api}
            onCreated={async (projectId) => {
              setActiveProjectId(projectId)
              props.onSelectTask(undefined)
              await props.onRefresh()
            }}
          />
          <TaskForm
            data={props.data}
            api={props.api}
            activeProjectId={activeProject()?.id}
            onCreated={props.onRefresh}
          />
          <TaskList data={props.data} tasks={projectTasks()} selected={props.selectedTaskId} onSelect={props.onSelectTask} />
        </aside>
        <section class="detail">
          <Show when={selectedTask()} fallback={<EmptyState />}>
            {(task: Accessor<Task>) => (
              <TaskDetail
                task={task()}
                data={props.data}
                api={props.api}
                onRefresh={props.onRefresh}
                onTaskChanged={props.onSelectTask}
              />
            )}
          </Show>
        </section>
      </section>
      <Show when={managerOpen()}>
        <ProjectTaskManager
          data={props.data}
          api={props.api}
          activeProjectId={activeProjectId()}
          selectedTaskId={props.selectedTaskId}
          onClose={() => setManagerOpen(false)}
          onRefresh={props.onRefresh}
          onSelectProject={(id) => {
            setActiveProjectId(id)
            props.onSelectTask(undefined)
          }}
          onSelectTask={(task) => {
            setActiveProjectId(task.projectId)
            props.onSelectTask(task.id)
            setManagerOpen(false)
          }}
        />
      </Show>
    </main>
  )
}

function ProjectTaskManager(props: {
  data: BootstrapData
  api: ApiClient
  activeProjectId: string | undefined
  selectedTaskId: string | undefined
  onClose: () => void
  onRefresh: () => void
  onSelectProject: (id: string) => void
  onSelectTask: (task: Task) => void
}) {
  const [projectId, setProjectId] = createSignal(props.activeProjectId ?? props.data.projects[0]?.id ?? "")
  const [query, setQuery] = createSignal("")
  const [status, setStatus] = createSignal<ManagerStatusFilter>("active")
  const [busyTaskId, setBusyTaskId] = createSignal<string | undefined>()
  const [busyProjectId, setBusyProjectId] = createSignal<string | undefined>()
  const [pendingDelete, setPendingDelete] = createSignal<PendingDelete | undefined>()
  const [managerError, setManagerError] = createSignal<string | undefined>()
  const selectedProject = createMemo(() => props.data.projects.find((project) => project.id === projectId()))
  const filteredTasks = createMemo(() => {
    const q = query().trim().toLowerCase()
    return props.data.tasks
      .filter((task) => task.projectId === projectId())
      .filter((task) => {
        if (status() === "active") return task.status !== "archived"
        if (status() === "all") return true
        return task.status === status()
      })
      .filter((task) => {
        if (!q) return true
        return [task.title, task.prompt, task.agent, task.model, task.status].join(" ").toLowerCase().includes(q)
      })
  })
  const pendingProjectId = createMemo(() => {
    const target = pendingDelete()
    return target?.kind === "project" ? target.project.id : undefined
  })
  const pendingTaskId = createMemo(() => {
    const target = pendingDelete()
    return target?.kind === "task" ? target.task.id : undefined
  })

  async function archive(task: Task) {
    try {
      setManagerError(undefined)
      setBusyTaskId(task.id)
      await props.api.updateTask(task.id, { status: "archived" })
      props.onRefresh()
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyTaskId(undefined)
    }
  }

  async function confirmDelete() {
    const target = pendingDelete()
    if (!target) return
    try {
      setManagerError(undefined)
      if (target.kind === "task") {
        setBusyTaskId(target.task.id)
        await props.api.deleteTask(target.task.id)
      } else {
        setBusyProjectId(target.project.id)
        await props.api.deleteProject(target.project.id)
        const nextProject = props.data.projects.find((item) => item.id !== target.project.id)
        setProjectId(nextProject?.id ?? "")
        props.onSelectProject(nextProject?.id ?? "")
      }
      setPendingDelete(undefined)
      props.onRefresh()
    } catch (error) {
      setManagerError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusyTaskId(undefined)
      setBusyProjectId(undefined)
    }
  }

  return (
    <div class="manager-backdrop">
      <section class="manager-panel">
        <div class="manager-header">
          <div>
            <h2>Projects & Tasks</h2>
            <p>Organize workspaces, inspect task state, and archive completed work.</p>
          </div>
          <button class="ghost" type="button" onClick={props.onClose}>
            Close
          </button>
        </div>

        <div class="manager-layout">
          <aside class="manager-projects">
            <div class="section-heading">
              <h2>Projects</h2>
              <span>{props.data.projects.length} total</span>
            </div>
            <For each={props.data.projects}>
              {(project) => {
                const count = props.data.tasks.filter((task) => task.projectId === project.id && task.status !== "archived").length
                return (
                  <div class="manager-project-row" classList={{ active: project.id === projectId() }}>
                    <button
                      type="button"
                      onClick={() => {
                        setProjectId(project.id)
                        props.onSelectProject(project.id)
                      }}
                    >
                      <strong>{project.name}</strong>
                      <small>{count} active tasks</small>
                    </button>
                    <button
                      class="danger"
                      type="button"
                      disabled={busyProjectId() === project.id}
                      onClick={() => {
                        if (pendingProjectId() === project.id) void confirmDelete()
                        else {
                          setManagerError(undefined)
                          setPendingDelete({ kind: "project", project })
                        }
                      }}
                    >
                      {busyProjectId() === project.id ? "Deleting..." : pendingProjectId() === project.id ? "Confirm delete" : "Delete"}
                    </button>
                    <Show when={pendingProjectId() === project.id}>
                      <button class="ghost" type="button" onClick={() => setPendingDelete(undefined)}>
                        Cancel
                      </button>
                    </Show>
                  </div>
                )
              }}
            </For>
          </aside>

          <section class="manager-tasks">
            <Show when={managerError()}>
              {(message) => <div class="manager-error">{message()}</div>}
            </Show>
            <div class="manager-toolbar">
              <div>
                <h2>{selectedProject()?.name ?? "No project"}</h2>
                <p>{selectedProject()?.path}</p>
              </div>
              <select value={status()} onChange={(event) => setStatus(event.currentTarget.value as ManagerStatusFilter)}>
                <option value="active">Active</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="archived">Archived</option>
                <option value="all">All</option>
              </select>
            </div>
            <input
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search by title, prompt, agent, model, or status"
            />
            <div class="manager-task-list">
              <Show when={filteredTasks().length > 0} fallback={<div class="muted">No matching tasks.</div>}>
                <For each={filteredTasks()}>
                  {(task) => (
                    <div class="manager-task-row" classList={{ selected: task.id === props.selectedTaskId }}>
                      <button type="button" onClick={() => props.onSelectTask(task)}>
                        <span class={`status ${task.status}`}>{statusLabel(task.status)}</span>
                        <strong>{task.title}</strong>
                        <small>
                          {taskStage(task)} · {task.agent} · {time(task.updatedAt)}
                        </small>
                      </button>
                      <button
                        class="ghost"
                        type="button"
                        disabled={task.status === "archived" || busyTaskId() === task.id}
                        onClick={() => archive(task)}
                      >
                        {task.status === "archived" ? "Archived" : busyTaskId() === task.id ? "Archiving..." : "Archive"}
                      </button>
                      <button
                        class="danger"
                        type="button"
                        disabled={busyTaskId() === task.id}
                        onClick={() => {
                          if (pendingTaskId() === task.id) void confirmDelete()
                          else {
                            setManagerError(undefined)
                            setPendingDelete({ kind: "task", task })
                          }
                        }}
                      >
                        {busyTaskId() === task.id ? "Deleting..." : pendingTaskId() === task.id ? "Confirm delete" : "Delete"}
                      </button>
                      <Show when={pendingTaskId() === task.id}>
                        <button class="ghost" type="button" onClick={() => setPendingDelete(undefined)}>
                          Cancel
                        </button>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </section>
        </div>
      </section>
    </div>
  )
}

function DesignLibrarySwitcher(props: { value: DesignThemeId; onChange: (theme: DesignThemeId) => void }) {
  const [open, setOpen] = createSignal(false)
  const active = createMemo(() => designThemes.find((theme) => theme.id === props.value) ?? designThemes[0])
  return (
    <div class="design-control">
      <button class="design-button" type="button" onClick={() => setOpen(!open())}>
        <span>Workspace</span>
        <strong>{active().name}</strong>
      </button>
      <Show when={open()}>
        <div class="design-menu">
          <For each={designThemes}>
            {(theme) => (
              <button
                type="button"
                classList={{ active: theme.id === props.value }}
                onClick={() => {
                  props.onChange(theme.id)
                  setOpen(false)
                }}
              >
                <i data-swatch={theme.id} />
                <span>
                  <strong>{theme.name}</strong>
                  <small>{theme.summary}</small>
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function ProjectSwitcher(props: {
  projects: Project[]
  activeProjectId: string | undefined
  onChange: (id: string) => void
}) {
  return (
    <section class="panel">
      <div class="panel-heading">
        <h2>Project</h2>
        <span>{props.projects.length} total</span>
      </div>
      <Show when={props.projects.length > 0} fallback={<div class="muted">Create a project to start.</div>}>
        <select value={props.activeProjectId ?? ""} onChange={(event) => props.onChange(event.currentTarget.value)}>
          <For each={props.projects}>{(project) => <option value={project.id}>{project.name}</option>}</For>
        </select>
      </Show>
    </section>
  )
}

function PermissionSwitcher(props: {
  project: Project | undefined
  profiles: BootstrapData["permissionProfiles"]
  api: ApiClient
  onChanged: () => void
}) {
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const active = createMemo(() =>
    props.profiles.find((profile) => profile.id === props.project?.permissionLevel) ?? props.profiles[0],
  )

  async function setLevel(level: PermissionLevel) {
    if (!props.project) return
    setBusy(true)
    await props.api.updateProject(props.project.id, { permissionLevel: level })
    setBusy(false)
    setOpen(false)
    props.onChanged()
  }

  return (
    <div class="permission-control">
      <button class="permission-button" disabled={!props.project || busy()} onClick={() => setOpen(!open())}>
        <span>Permission</span>
        <strong>{active()?.name ?? "No project"}</strong>
      </button>
      <Show when={open() && props.project}>
        <div class="permission-menu">
          <For each={props.profiles}>
            {(profile) => (
              <button
                classList={{ active: profile.id === props.project?.permissionLevel }}
                onClick={() => setLevel(profile.id)}
              >
                <strong>{profile.name}</strong>
                <span>{profile.summary}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function ProjectForm(props: { data: BootstrapData; api: ApiClient; onCreated: (projectId: string) => void | Promise<void> }) {
  const [open, setOpen] = createSignal(props.data.projects.length === 0)
  const [name, setName] = createSignal("FactorySight")
  const [projectPath, setProjectPath] = createSignal("/Users/mason/Documents/Codex/2026-07-05/opencode/upstream-opencode")
  const [busy, setBusy] = createSignal(false)

  return (
    <section class="panel">
      <button class="panel-toggle" onClick={() => setOpen(!open())}>
        New project
      </button>
      <Show when={open()}>
        <form
          class="stack"
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            const project = await props.api.createProject({ name: name(), path: projectPath() })
            setBusy(false)
            setOpen(false)
            await props.onCreated(project.id)
          }}
        >
          <label>
            Name
            <input value={name()} onInput={(event) => setName(event.currentTarget.value)} />
          </label>
          <label>
            Server path
            <input value={projectPath()} onInput={(event) => setProjectPath(event.currentTarget.value)} />
          </label>
          <button disabled={busy()}>{busy() ? "Creating..." : "Create project"}</button>
        </form>
      </Show>
    </section>
  )
}

function TaskForm(props: { data: BootstrapData; api: ApiClient; activeProjectId: string | undefined; onCreated: () => void }) {
  const [mode, setMode] = createSignal<"single" | "team">("team")
  const [scale, setScale] = createSignal<"focused" | "balanced" | "wide">("balanced")
  const [projectId, setProjectId] = createSignal(props.activeProjectId ?? "")
  const [title, setTitle] = createSignal("")
  const [prompt, setPrompt] = createSignal("")
  const [agent, setAgent] = createSignal("build")
  const [model, setModel] = createSignal(
    props.data.models.includes(preferredDefaultModel) ? preferredDefaultModel : (props.data.models[0] ?? preferredDefaultModel),
  )
  const [modelQuery, setModelQuery] = createSignal("")
  const [collaboration, setCollaboration] = createSignal<"private" | "project" | "shared">("project")
  const [productStyle, setProductStyle] = createSignal<ProductStyleId>("operational")
  const [styleNotes, setStyleNotes] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const filteredModels = createMemo(() => {
    const query = modelQuery().trim().toLowerCase()
    if (!query) return props.data.models
    return props.data.models.filter((item) => item.toLowerCase().includes(query))
  })
  const selectedStyle = createMemo(() => productStyles.find((style) => style.id === productStyle()) ?? productStyles[0])

  createEffect(() => {
    if (props.activeProjectId && props.activeProjectId !== projectId()) setProjectId(props.activeProjectId)
  })

  return (
    <section class="panel mission-panel">
      <div class="panel-heading">
        <h2>Mission composer</h2>
        <span>{mode() === "team" ? "Agent Swarm" : "Direct Agent"}</span>
      </div>
      <p class="panel-intro">
        Launch agent work with the outcome, model, visibility, and product style in one place.
      </p>
      <form
        class="stack"
        onSubmit={async (event) => {
          event.preventDefault()
          setBusy(true)
          const composedPrompt = productPrompt({
            prompt: prompt(),
            style: productStyle(),
            styleNotes: styleNotes(),
          })
          if (mode() === "team") {
            await props.api.createOrchestration({
              projectId: projectId(),
              title: title() || prompt().slice(0, 80),
              prompt: composedPrompt,
              model: model(),
              collaboration: collaboration(),
              scale: scale(),
            })
          } else {
            await props.api.createTask({
              projectId: projectId(),
              title: title() || prompt().slice(0, 80),
              prompt: composedPrompt,
              agent: agent(),
              model: model(),
              collaboration: collaboration(),
            })
          }
          setBusy(false)
          setTitle("")
          setPrompt("")
          setStyleNotes("")
          props.onCreated()
        }}
        >
        <div class="mode-cards">
          <button type="button" classList={{ active: mode() === "team" }} onClick={() => setMode("team")}>
            <strong>Agent Swarm</strong>
            <span>Decompose, run in parallel, synthesize.</span>
          </button>
          <button type="button" classList={{ active: mode() === "single" }} onClick={() => setMode("single")}>
            <strong>Direct Agent</strong>
            <span>One role owns the task end to end.</span>
          </button>
        </div>
        <input type="hidden" value={projectId()} />
        <label>
          Title
          <input value={title()} onInput={(event) => setTitle(event.currentTarget.value)} placeholder="Fix auth redirect" />
        </label>
        <label>
          Mission
          <textarea
            value={prompt()}
            onInput={(event) => setPrompt(event.currentTarget.value)}
            placeholder="Describe the outcome. For swarm mode, include product goal, constraints, and what counts as done."
          />
        </label>
        <p class="field-hint">Write the success condition first; constraints and references can follow.</p>
        <Show when={mode() === "team"}>
          <div class="scale-row">
            <button type="button" classList={{ active: scale() === "focused" }} onClick={() => setScale("focused")}>
              Focused
              <span>3-4 agents</span>
            </button>
            <button type="button" classList={{ active: scale() === "balanced" }} onClick={() => setScale("balanced")}>
              Balanced
              <span>Up to 8 agents</span>
            </button>
            <button type="button" classList={{ active: scale() === "wide" }} onClick={() => setScale("wide")}>
              Wide
              <span>Full review</span>
            </button>
          </div>
        </Show>
        <div class="product-style-panel">
          <div class="section-heading">
            <h2>Design library</h2>
            <span>{selectedStyle().name}</span>
          </div>
          <div class="product-style-grid">
            <For each={productStyles}>
              {(style) => (
                <button
                  type="button"
                  classList={{ active: productStyle() === style.id }}
                  onClick={() => setProductStyle(style.id)}
                >
                  <i data-swatch={style.id} />
                  <span>
                    <strong>{style.name}</strong>
                    <small>{style.summary}</small>
                  </span>
                </button>
              )}
            </For>
          </div>
          <label>
            Style preferences
            <input
              value={styleNotes()}
              onInput={(event) => setStyleNotes(event.currentTarget.value)}
              placeholder="Optional: calmer colors, mobile-first, stricter density"
            />
          </label>
        </div>
        <div class="form-grid">
          <Show
            when={mode() === "single"}
            fallback={
              <label>
                Team
                <input value={`${scale()} swarm`} readOnly />
              </label>
            }
          >
            <label>
              Agent
              <select value={agent()} onChange={(event) => setAgent(event.currentTarget.value)}>
                <For each={props.data.agents.filter((item) => item !== "orchestrator")}>
                  {(item) => <option value={item}>{item}</option>}
                </For>
              </select>
            </label>
          </Show>
          <label>
            Model search
            <input
              value={modelQuery()}
              onInput={(event) => setModelQuery(event.currentTarget.value)}
              placeholder={`${props.data.models.length} backend models available`}
            />
            <span class="field-count">{filteredModels().length} matches</span>
          </label>
        </div>
        <label>
          Model
          <select value={model()} onChange={(event) => setModel(event.currentTarget.value)}>
            <For each={filteredModels()}>{(item) => <option value={item}>{item}</option>}</For>
          </select>
        </label>
        <label>
          Visibility
          <select
            value={collaboration()}
            onChange={(event) => setCollaboration(event.currentTarget.value as "private" | "project" | "shared")}
          >
            <option value="private">Private</option>
            <option value="project">Project</option>
            <option value="shared">Shared session</option>
          </select>
        </label>
        <button disabled={busy() || !projectId() || !prompt()}>
          {busy() ? "Launching..." : mode() === "team" ? "Launch swarm" : "Queue task"}
        </button>
      </form>
    </section>
  )
}

function TaskList(props: { data: BootstrapData; tasks: Task[]; selected: string | undefined; onSelect: (id: string) => void }) {
  return (
    <section class="panel task-list">
      <h2>Tasks</h2>
      <Show when={props.tasks.length > 0} fallback={<div class="muted">No tasks yet.</div>}>
        <For each={props.tasks}>
          {(task) => (
            <button class="task-card" classList={{ active: props.selected === task.id }} onClick={() => props.onSelect(task.id)}>
              <div class="task-card-top">
                <AgentAvatar data={props.data} agent={task.agent} compact />
                <span class={`status ${task.status}`}>{statusLabel(task.status)}</span>
              </div>
              <strong>{task.title}</strong>
              <small>
                {taskStage(task)} · {task.agent} · {time(task.updatedAt)}
              </small>
            </button>
          )}
        </For>
      </Show>
    </section>
  )
}

function TaskDetail(props: {
  task: Task
  data: BootstrapData
  api: ApiClient
  onRefresh: () => void
  onTaskChanged: (id: string) => void
}) {
  const [events, setEvents] = createSignal<TaskEvent[]>(props.task.events)
  const [message, setMessage] = createSignal("")
  const [shareUser, setShareUser] = createSignal(props.data.users.find((user) => user.id !== props.data.user.id)?.id ?? "")
  const childTasks = createMemo(() => props.data.tasks.filter((task) => task.parentTaskId === props.task.id))
  const parentTask = createMemo(() => props.data.tasks.find((task) => task.id === props.task.parentTaskId))
  const chainRoot = createMemo(() => parentTask() ?? props.task)
  const chainTasks = createMemo(() => [
    chainRoot(),
    ...props.data.tasks
      .filter((task) => task.parentTaskId === chainRoot().id)
      .slice()
      .reverse(),
  ])
  const currentProfile = createMemo(() => props.data.agentProfiles[props.task.agent])
  const stage = createMemo(() => taskStage(props.task))
  const digest = createMemo(() => eventDigest(events()))
  const errorCount = createMemo(() => digest().errors.length)

  createEffect(() => {
    setEvents(props.task.events)
    const eventUrl = `/api/tasks/${props.task.id}/events?token=${encodeURIComponent(props.api.getToken() ?? "")}`
    const source = new EventSource(eventUrl)
    source.onmessage = (event) => {
      const next = JSON.parse(event.data) as TaskEvent
      setEvents((items) => (items.some((item) => item.id === next.id) ? items : [...items, next]))
      props.onRefresh()
    }
    source.onerror = () => source.close()
    const interval = setInterval(props.onRefresh, 5000)
    onCleanup(() => {
      source.close()
      clearInterval(interval)
    })
  })

  return (
    <article class="task-detail">
      <div class="detail-header">
        <div>
          <div class="detail-kicker">
            <span class={`status ${props.task.status}`}>{statusLabel(props.task.status)}</span>
            <Show when={errorCount() > 0}>
              <span class="status failed">{errorCount()} errors</span>
            </Show>
          </div>
          <h1>{props.task.title}</h1>
          <p>
            {stage()} · {props.task.agent} · {props.task.model} · {props.task.collaboration}
          </p>
        </div>
        <button class="ghost" onClick={props.onRefresh}>
          Sync
        </button>
      </div>

      <div class="task-layout">
        <div class="task-main">
          <TaskChainNav
            data={props.data}
            currentTaskId={props.task.id}
            tasks={chainTasks()}
            onSelectTask={props.onTaskChanged}
          />

          <ResultPanel
            data={props.data}
            api={props.api}
            task={props.task}
            events={events()}
            childTasks={childTasks()}
            onSelectTask={props.onTaskChanged}
          />

          <section class="timeline">
            <div class="section-heading">
              <h2>Detailed timeline</h2>
              <span>{events().length} events</span>
            </div>
            <For each={events()}>
              {(event) => (
                <div class={`event event-${event.type}`}>
                  <div class="event-meta">
                    <span>{event.type}</span>
                    <time>{time(event.at)}</time>
                  </div>
                  <pre>{event.text}</pre>
                </div>
              )}
            </For>
          </section>

          <section class="composer-row">
            <form
              onSubmit={async (event) => {
                event.preventDefault()
                if (!message()) return
                await props.api.addMessage(props.task.id, { text: message() })
                setMessage("")
                props.onRefresh()
              }}
            >
              <input
                value={message()}
                onInput={(event) => setMessage(event.currentTarget.value)}
                placeholder="Add instruction, handoff note, or approval context..."
              />
              <button>Send</button>
            </form>
          </section>

          <section class="share-row">
            <select value={shareUser()} onChange={(event) => setShareUser(event.currentTarget.value)}>
              <For each={props.data.users.filter((user) => user.id !== props.data.user.id)}>
                {(user) => <option value={user.id}>{user.name}</option>}
              </For>
            </select>
            <button
              class="ghost"
              disabled={!shareUser()}
              onClick={async () => {
                await props.api.shareTask(props.task.id, { userId: shareUser(), role: "collaborator" })
                props.onRefresh()
              }}
            >
              Share task
            </button>
          </section>
        </div>

        <aside class="task-aside">
          <div class="agent-stage">
            <AgentAvatar data={props.data} agent={props.task.agent} />
            <p>{currentProfile()?.summary ?? "Working on this task."}</p>
            <Show when={props.task.kind === "orchestration"}>
              <div class="context-note">Coordinator keeps global context clean; sub-agents work in isolated context shards.</div>
            </Show>
          </div>

          <Show when={parentTask()}>
            {(parent) => (
              <section class="linked-tasks">
                <button class="ghost" onClick={() => props.onTaskChanged(parent().id)}>
                  Open parent orchestration
                </button>
              </section>
            )}
          </Show>

          <Show when={childTasks().length > 0}>
            <SwarmProgress data={props.data} tasks={childTasks()} onSelect={props.onTaskChanged} />
          </Show>
        </aside>
      </div>
    </article>
  )
}

function TaskChainNav(props: {
  data: BootstrapData
  currentTaskId: string
  tasks: Task[]
  onSelectTask: (id: string) => void
}) {
  const percent = createMemo(() => progressValue(props.tasks))
  const currentIndex = createMemo(() => Math.max(0, props.tasks.findIndex((task) => task.id === props.currentTaskId)))
  const activeTask = createMemo(() => props.tasks[currentIndex()])
  return (
    <section class="chain-nav">
      <div class="chain-summary">
        <div>
          <h2>Task chain</h2>
          <p>
            Step {currentIndex() + 1} of {props.tasks.length} · {activeTask()?.title ?? "No task selected"}
          </p>
        </div>
        <strong>{percent()}%</strong>
      </div>
      <div class="chain-meter">
        <div style={{ width: `${percent()}%` }} />
      </div>
      <div class="chain-steps">
        <For each={props.tasks}>
          {(task, index) => (
            <button
              class="chain-step"
              classList={{ active: task.id === props.currentTaskId }}
              onClick={() => props.onSelectTask(task.id)}
            >
              <span class={`chain-index ${task.status}`}>{index() + 1}</span>
              <AgentAvatar data={props.data} agent={task.agent} compact />
              <div>
                <strong>{task.kind === "orchestration" ? "Coordinator" : props.data.agentProfiles[task.agent]?.name ?? task.agent}</strong>
                <small>{task.title}</small>
              </div>
              <span class={`status ${task.status}`}>{statusLabel(task.status)}</span>
            </button>
          )}
        </For>
      </div>
    </section>
  )
}

function ResultPanel(props: {
  data: BootstrapData
  api: ApiClient
  task: Task
  events: TaskEvent[]
  childTasks: Task[]
  onSelectTask: (id: string) => void
}) {
  const digest = createMemo(() => eventDigest(props.events))
  const completedChildren = createMemo(() => props.childTasks.filter((task) => task.status === "completed"))
  const failedChildren = createMemo(() => props.childTasks.filter((task) => task.status === "failed"))
  const runnerPreview = createMemo(() => digest().runner.slice(-4))
  const isDone = createMemo(() => ["completed", "failed", "archived"].includes(props.task.status))
  const projectArtifacts = createMemo(() =>
    props.data.artifacts.filter((artifact) => artifact.projectId === props.task.projectId),
  )

  return (
    <section class="result-panel">
      <div class="section-heading">
        <h2>Result</h2>
        <span>{isDone() ? "final" : "live"}</span>
      </div>

      <div class="result-grid">
        <div class={`result-metric status-${props.task.status}`}>
          <strong>{statusLabel(props.task.status)}</strong>
          <span>Task status</span>
        </div>
        <div class="result-metric">
          <strong>{props.childTasks.length || 1}</strong>
          <span>{props.childTasks.length ? "Agents" : "Agent"}</span>
        </div>
        <div class="result-metric" classList={{ danger: digest().errors.length > 0 }}>
          <strong>{digest().errors.length}</strong>
          <span>Errors</span>
        </div>
      </div>

      <Show when={projectArtifacts().length > 0}>
        <div class="artifact-list">
          <div class="section-heading">
            <h2>Artifacts</h2>
            <span>{projectArtifacts().length} available</span>
          </div>
          <For each={projectArtifacts()}>
            {(artifact) => (
              <button
                type="button"
                class="artifact-link"
                onClick={() => {
                  window.location.href = artifactUrl(artifact.projectId, artifact.relativePath, props.api.getToken())
                }}
              >
                <span>
                  <strong>{artifact.name}</strong>
                  <small>{artifact.relativePath}</small>
                </span>
                <b>Open</b>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show
        when={digest().deliverables.at(-1) || digest().lastStatus || digest().lastOutput}
        fallback={<p class="result-empty">No runner output yet. The result will appear here as soon as the task reports progress.</p>}
      >
        <div class="result-summary">
          <div class="section-heading">
            <h2>Run log</h2>
            <span>scroll</span>
          </div>
          <Show when={digest().deliverables.at(-1)}>
            {(event) => <pre>{event().text}</pre>}
          </Show>
          <Show when={digest().lastStatus}>
            <p>{digest().lastStatus}</p>
          </Show>
          <Show when={!digest().deliverables.length && digest().lastOutput}>
            <pre>{digest().lastOutput}</pre>
          </Show>
        </div>
      </Show>

      <Show when={props.childTasks.some((task) => eventDigest(task.events).deliverables.length > 0)}>
        <div class="deliverables-list">
          <div class="section-heading">
            <h2>Deliverables</h2>
            <span>from sub-agents</span>
          </div>
          <For each={props.childTasks.filter((task) => eventDigest(task.events).deliverables.length > 0)}>
            {(child) => {
              const deliverable = eventDigest(child.events).deliverables.at(-1)
              return (
                <button class="deliverable-card" onClick={() => props.onSelectTask(child.id)}>
                  <AgentAvatar data={props.data} agent={child.agent} compact />
                  <pre>{deliverable?.text}</pre>
                </button>
              )
            }}
          </For>
        </div>
      </Show>

      <Show when={digest().errors.length > 0}>
        <div class="result-errors">
          <h3>Errors</h3>
          <For each={digest().errors.slice(-3)}>{(event) => <pre>{event.text}</pre>}</For>
        </div>
      </Show>

      <Show when={props.childTasks.length > 0}>
        <div class="agent-results">
          <div class="section-heading">
            <h2>Agent outputs</h2>
            <span>
              {completedChildren().length} done · {failedChildren().length} failed
            </span>
          </div>
          <For each={props.childTasks}>
            {(child) => {
              const childDigest = eventDigest(child.events)
              return (
                <button class="agent-result" onClick={() => props.onSelectTask(child.id)}>
                  <AgentAvatar data={props.data} agent={child.agent} compact />
                  <div>
                    <span class={`status ${child.status}`}>{statusLabel(child.status)}</span>
                    <strong>{child.title}</strong>
                    <small>{childDigest.lastOutput ?? childDigest.lastStatus ?? "Waiting for output"}</small>
                  </div>
                </button>
              )
            }}
          </For>
        </div>
      </Show>

      <Show when={runnerPreview().length > 1 && props.childTasks.length === 0}>
        <div class="runner-preview">
          <div class="section-heading">
            <h2>Recent output</h2>
            <span>scroll</span>
          </div>
          <For each={runnerPreview()}>{(event) => <pre>{event.text}</pre>}</For>
        </div>
      </Show>
    </section>
  )
}

function SwarmProgress(props: { data: BootstrapData; tasks: Task[]; onSelect: (id: string) => void }) {
  const complete = createMemo(() => props.tasks.filter((task) => task.status === "completed").length)
  const running = createMemo(() => props.tasks.filter((task) => task.status === "running").length)
  const failed = createMemo(() => props.tasks.filter((task) => task.status === "failed").length)
  return (
    <section class="swarm-panel">
      <div class="swarm-header">
        <div>
          <h2>Agent swarm</h2>
          <p>
            {complete()} complete · {running()} running · {failed()} failed
          </p>
        </div>
        <div class="swarm-meter">
          <div style={{ width: `${props.tasks.length ? Math.round((complete() / props.tasks.length) * 100) : 0}%` }} />
        </div>
      </div>
      <For each={props.tasks}>
        {(task) => (
          <button class="swarm-agent" onClick={() => props.onSelect(task.id)}>
            <AgentAvatar data={props.data} agent={task.agent} compact />
            <div class="swarm-agent-body">
              <span class={`status ${task.status}`}>{statusLabel(task.status)}</span>
              <small>{task.title}</small>
            </div>
          </button>
        )}
      </For>
    </section>
  )
}

function EmptyState() {
  return (
    <div class="empty">
      <h1>No task selected</h1>
      <p>Create a project and assign a task to start a FactorySight remote session.</p>
    </div>
  )
}

render(() => <App />, document.getElementById("root")!)
