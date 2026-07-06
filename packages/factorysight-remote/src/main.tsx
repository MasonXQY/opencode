import { render } from "solid-js/web"
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import { ApiClient } from "./api"
import {
  artifactsForProject,
  defaultProjectPath,
  nextSelectedTaskId,
  preferredSpeechLanguage,
  taskTitleFromPrompt,
} from "./view-model"
import {
  defaultPermissionLevel,
  preferredDefaultModel,
  type Artifact,
  type BootstrapData,
  type FileAttachment,
  type PermissionLevel,
  type PermissionProfile,
  type Project,
  type Task,
  type TaskEvent,
} from "./shared"
import "./styles.css"

const tokenKey = "factorysight.remote.token"

type LibraryTab = "agents" | "projects" | "files" | "artifacts"
type ComposeMode = "swarm" | "direct"
type Scale = "focused" | "balanced" | "wide"
type SpeechRecognitionResultLike = {
  isFinal: boolean
  0: { transcript: string }
}
type SpeechRecognitionLike = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((event: { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> }) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

const productStyles = [
  {
    id: "linear",
    name: "Linear",
    summary: "Precise engineer workflow.",
    guidance:
      "Use a Linear-inspired product style: minimal surfaces, crisp hierarchy, hairline borders, restrained blue-violet accent, dense issue-like information layout.",
  },
  {
    id: "command-center",
    name: "Command Center",
    summary: "Live operations console.",
    guidance:
      "Use a command-center style: clear status, compact panels, live progress, technical logs, strong state colors, no decorative clutter.",
  },
  {
    id: "consumer",
    name: "Consumer App",
    summary: "Friendly polished product.",
    guidance:
      "Use a friendly consumer-app style: clear primary actions, soft hierarchy, warm microcopy, accessible forms, polished empty and loading states.",
  },
  {
    id: "editorial",
    name: "Editorial",
    summary: "Content-led presentation.",
    guidance:
      "Use an editorial style: strong typography, spacious rhythm, content-first sections, careful contrast, and narrative product flow.",
  },
] as const

type ProductStyleId = (typeof productStyles)[number]["id"]

function statusLabel(status: Task["status"]) {
  return status.replaceAll("_", " ")
}

function taskStage(task: Task) {
  if (task.parentTaskId) return "sub-agent"
  if (task.kind === "orchestration") return "primary"
  return "direct"
}

function time(value: string) {
  return new Date(value).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
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

function progressValue(tasks: Task[]) {
  if (!tasks.length) return 0
  return Math.round((tasks.filter((task) => task.status === "completed").length / tasks.length) * 100)
}

function eventDigest(events: TaskEvent[]) {
  const errors = events.filter((event) => event.type === "error")
  const statuses = events.filter((event) => event.type === "status")
  const runner = events.filter((event) => event.type === "runner")
  const deliverables = events.filter((event) => event.type === "deliverable")
  return {
    errors,
    deliverables,
    lastStatus: statuses.at(-1)?.text,
    lastOutput: runner.at(-1)?.text,
    recent: events.slice(-8).reverse(),
  }
}

function artifactUrl(projectId: string, relativePath: string, token: string | undefined) {
  const encoded = relativePath.split("/").map(encodeURIComponent).join("/")
  const suffix = token ? `?token=${encodeURIComponent(token)}` : ""
  return `/api/projects/${encodeURIComponent(projectId)}/artifacts/${encoded}${suffix}`
}

function productPrompt(input: { prompt: string; style: ProductStyleId; notes: string }) {
  const style = productStyles.find((item) => item.id === input.style) ?? productStyles[0]
  return [
    input.prompt.trim(),
    "",
    "Design library selection:",
    `- Product style: ${style.name}`,
    `- Style guidance: ${style.guidance}`,
    input.notes.trim() ? `- User style preferences: ${input.notes.trim()}` : undefined,
    "",
    "Apply this style to the product being built, not to FactorySight Remote itself.",
  ]
    .filter(Boolean)
    .join("\n")
}

function App() {
  const [token, setToken] = createSignal(localStorage.getItem(tokenKey) ?? undefined)
  const api = new ApiClient(token())
  const [selectedTaskId, setSelectedTaskId] = createSignal<string | undefined>()
  const [error, setError] = createSignal<string | undefined>()

  createEffect(() => api.setToken(token()))

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

  async function login(email: string) {
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

  function logout() {
    localStorage.removeItem(tokenKey)
    setSelectedTaskId(undefined)
    setToken(undefined)
  }

  return (
    <Show when={token()} fallback={<LoginScreen error={error()} onLogin={login} />}>
      <Show when={bootstrap()} fallback={<LoadingScreen />}>
        {(data) => (
          <CanvasWorkspace
            data={data()}
            api={api}
            selectedTaskId={selectedTaskId()}
            onSelectTask={setSelectedTaskId}
            onRefresh={refetch}
            onLogout={logout}
          />
        )}
      </Show>
    </Show>
  )
}

function LoginScreen(props: { error: string | undefined; onLogin: (email: string) => Promise<void> }) {
  const [email, setEmail] = createSignal("mason@example.local")
  const [busy, setBusy] = createSignal(false)
  return (
    <main class="login-screen">
      <section class="login-card">
        <div class="mark">F</div>
        <h1>FactorySight Remote</h1>
        <p>Open the agent canvas, assign work, and keep FactorySight running from anywhere.</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            await props.onLogin(email()).finally(() => setBusy(false))
          }}
        >
          <label>
            Email
            <input value={email()} onInput={(event) => setEmail(event.currentTarget.value)} autocomplete="email" />
          </label>
          <button disabled={busy()}>{busy() ? "Opening..." : "Open workspace"}</button>
        </form>
        <Show when={props.error}>
          <div class="form-error">{props.error}</div>
        </Show>
      </section>
    </main>
  )
}

function LoadingScreen() {
  return (
    <main class="login-screen">
      <section class="login-card compact">
        <div class="mark">F</div>
        <h1>Opening workspace</h1>
        <p>Syncing projects, agents, models, and FactorySight sessions.</p>
      </section>
    </main>
  )
}

function CanvasWorkspace(props: {
  data: BootstrapData
  api: ApiClient
  selectedTaskId: string | undefined
  onSelectTask: (id: string | undefined) => void
  onRefresh: () => void
  onLogout: () => void
}) {
  const newestProjectId = createMemo(() => props.data.projects.at(-1)?.id)
  const [activeProjectId, setActiveProjectId] = createSignal(newestProjectId())
  const [libraryTab, setLibraryTab] = createSignal<LibraryTab>("agents")
  const [composerFocusRequest, setComposerFocusRequest] = createSignal(0)
  const activeProject = createMemo(() => props.data.projects.find((project) => project.id === activeProjectId()))
  const projectTasks = createMemo(() =>
    props.data.tasks.filter((task) => task.projectId === activeProjectId() && task.status !== "archived"),
  )
  const selectedTask = createMemo(() => projectTasks().find((task) => task.id === props.selectedTaskId))
  const counts = createMemo(() => taskCounts(projectTasks()))
  const chainRoot = createMemo(() => {
    const task = selectedTask()
    if (!task) return undefined
    return props.data.tasks.find((item) => item.id === task.parentTaskId) ?? task
  })
  const chainTasks = createMemo(() => {
    const root = chainRoot()
    if (!root) return []
    return [
      root,
      ...props.data.tasks
        .filter((task) => task.parentTaskId === root.id)
        .slice()
        .reverse(),
    ]
  })
  const activeArtifacts = createMemo(() => artifactsForProject(props.data.artifacts, activeProjectId()))
  const activeFiles = createMemo(() =>
    props.data.files.filter((file) => file.projectId === activeProjectId() && file.scope === "project"),
  )

  createEffect(() => {
    const current = activeProjectId()
    if (current && props.data.projects.some((project) => project.id === current)) return
    setActiveProjectId(newestProjectId())
  })

  createEffect(() => {
    props.onSelectTask(nextSelectedTaskId(props.data.tasks, activeProjectId(), props.selectedTaskId))
  })

  return (
    <main class="fs-app">
      <TopBar
        data={props.data}
        project={activeProject()}
        counts={counts()}
        api={props.api}
        onRefresh={props.onRefresh}
        onLogout={props.onLogout}
      />
      <section class="fs-stage">
        <ToolLibrary
          data={props.data}
          api={props.api}
          tab={libraryTab()}
          onTab={setLibraryTab}
          activeProjectId={activeProjectId()}
          onProject={(id) => {
            setActiveProjectId(id)
            props.onSelectTask(undefined)
          }}
          selectedTaskId={props.selectedTaskId}
          tasks={projectTasks()}
          files={activeFiles()}
          artifacts={activeArtifacts()}
          onSelectTask={props.onSelectTask}
          onRefresh={props.onRefresh}
        />
        <WorkflowCanvas
          data={props.data}
          project={activeProject()}
          tasks={projectTasks()}
          chainTasks={chainTasks()}
          selectedTask={selectedTask()}
          selectedTaskId={props.selectedTaskId}
          counts={counts()}
          onSelectTask={props.onSelectTask}
          onRefresh={props.onRefresh}
          onStartWorkflow={() => setComposerFocusRequest((value) => value + 1)}
        />
        <NodeInspector
          data={props.data}
          api={props.api}
          project={activeProject()}
          task={selectedTask()}
          chainTasks={chainTasks()}
          artifacts={activeArtifacts()}
          files={activeFiles()}
          onSelectTask={props.onSelectTask}
          onRefresh={props.onRefresh}
        />
      </section>
      <MissionCommandBar
        data={props.data}
        api={props.api}
        project={activeProject()}
        focusRequest={composerFocusRequest()}
        onCreated={async (taskId) => {
          await props.onRefresh()
          props.onSelectTask(taskId)
        }}
      />
    </main>
  )
}

function TopBar(props: {
  data: BootstrapData
  project: Project | undefined
  counts: ReturnType<typeof taskCounts>
  api: ApiClient
  onRefresh: () => void
  onLogout: () => void
}) {
  return (
    <header class="topbar">
      <div class="top-brand">
        <div class="mark">F</div>
        <div>
          <strong>FactorySight Remote</strong>
          <span>{props.project?.name ?? "No project selected"}</span>
        </div>
      </div>
      <div class="run-status">
        <span>
          <b>{props.counts.active}</b> active
        </span>
        <span>
          <b>{props.counts.running}</b> running
        </span>
        <span classList={{ alert: props.counts.failed > 0 }}>
          <b>{props.counts.failed}</b> failed
        </span>
        <span>{props.data.backendMode === "factorysight" ? "FactorySight backend" : "Local backend"}</span>
      </div>
      <div class="top-actions">
        <PermissionControl
          project={props.project}
          profiles={props.data.permissionProfiles}
          api={props.api}
          onChanged={props.onRefresh}
        />
        <button class="secondary" onClick={props.onRefresh}>
          Sync
        </button>
        <button class="secondary" onClick={props.onLogout}>
          Sign out
        </button>
      </div>
    </header>
  )
}

function PermissionControl(props: {
  project: Project | undefined
  profiles: PermissionProfile[]
  api: ApiClient
  onChanged: () => void
}) {
  const [busy, setBusy] = createSignal(false)
  const active = createMemo(
    () =>
      props.profiles.find((profile) => profile.id === props.project?.permissionLevel) ??
      props.profiles.find((profile) => profile.id === defaultPermissionLevel) ??
      props.profiles[0],
  )
  return (
    <label class="permission-control">
      <span>Permission</span>
      <select
        value={active()?.id}
        disabled={!props.project || busy()}
        onChange={async (event) => {
          if (!props.project) return
          setBusy(true)
          await props.api.updateProject(props.project.id, {
            permissionLevel: event.currentTarget.value as PermissionLevel,
          })
          setBusy(false)
          props.onChanged()
        }}
      >
        <For each={props.profiles}>{(profile) => <option value={profile.id}>{profile.name}</option>}</For>
      </select>
    </label>
  )
}

function ToolLibrary(props: {
  data: BootstrapData
  api: ApiClient
  tab: LibraryTab
  onTab: (tab: LibraryTab) => void
  activeProjectId: string | undefined
  onProject: (id: string) => void
  selectedTaskId: string | undefined
  tasks: Task[]
  files: FileAttachment[]
  artifacts: Artifact[]
  onSelectTask: (id: string) => void
  onRefresh: () => void
}) {
  const [newProjectOpen, setNewProjectOpen] = createSignal(false)
  const [busyProjectId, setBusyProjectId] = createSignal<string | undefined>()
  const tabs: LibraryTab[] = ["agents", "projects", "files", "artifacts"]
  return (
    <aside class="tool-library">
      <div class="library-title">
        <strong>Workspace</strong>
        <button class="icon-button" onClick={() => setNewProjectOpen(!newProjectOpen())}>
          New
        </button>
      </div>
      <nav class="library-tabs" aria-label="Workspace tools">
        <For each={tabs}>
          {(tab) => (
            <button classList={{ active: props.tab === tab }} onClick={() => props.onTab(tab)}>
              {tab}
            </button>
          )}
        </For>
      </nav>
      <Show when={newProjectOpen()}>
        <ProjectCreator
          data={props.data}
          api={props.api}
          onCreated={(id) => {
            props.onProject(id)
            setNewProjectOpen(false)
            props.onRefresh()
          }}
        />
      </Show>
      <Show when={props.tab === "projects"}>
        <Panel heading="Projects" meta={`${props.data.projects.length} total`}>
          <div class="project-list">
            <For each={props.data.projects}>
              {(project) => (
                <div class="project-item" classList={{ active: project.id === props.activeProjectId }}>
                  <button class="project-row" onClick={() => props.onProject(project.id)}>
                    <strong>{project.name}</strong>
                    <small>{project.path}</small>
                  </button>
                  <button
                    class="project-delete"
                    disabled={busyProjectId() === project.id}
                    onClick={async () => {
                      setBusyProjectId(project.id)
                      await props.api.deleteProject(project.id)
                      setBusyProjectId(undefined)
                      props.onRefresh()
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
            </For>
          </div>
        </Panel>
      </Show>
      <Show when={props.tab === "agents"}>
        <Panel heading="Agents" meta={`${props.data.agents.length} roles`}>
          <div class="agent-grid">
            <For each={props.data.agents}>{(agent) => <AgentCard data={props.data} agent={agent} />}</For>
          </div>
        </Panel>
        <Panel heading="Tasks" meta={`${props.tasks.length} visible`}>
          <div class="task-rail">
            <For each={props.tasks}>
              {(task) => (
                <button
                  class="task-row"
                  classList={{ active: task.id === props.selectedTaskId }}
                  onClick={() => props.onSelectTask(task.id)}
                >
                  <span class={`status-dot ${task.status}`} />
                  <strong>{task.title}</strong>
                  <small>
                    {taskStage(task)} · {time(task.updatedAt)}
                  </small>
                </button>
              )}
            </For>
          </div>
        </Panel>
      </Show>
      <Show when={props.tab === "files"}>
        <ProjectFiles
          data={props.data}
          api={props.api}
          files={props.files}
          activeProjectId={props.activeProjectId}
          onRefresh={props.onRefresh}
        />
      </Show>
      <Show when={props.tab === "artifacts"}>
        <Panel heading="Artifacts" meta={`${props.artifacts.length} available`}>
          <For each={props.artifacts} fallback={<EmptyLine text="No artifacts for this project yet." />}>
            {(artifact) => (
              <button
                class="artifact-row"
                onClick={() => {
                  window.location.href = artifactUrl(artifact.projectId, artifact.relativePath, props.api.getToken())
                }}
              >
                <strong>{artifact.name}</strong>
                <small>{artifact.relativePath}</small>
              </button>
            )}
          </For>
        </Panel>
      </Show>
    </aside>
  )
}

function Panel(props: { heading: string; meta?: string; children: any }) {
  return (
    <section class="panel">
      <div class="panel-heading">
        <h2>{props.heading}</h2>
        <span>{props.meta}</span>
      </div>
      {props.children}
    </section>
  )
}

function EmptyLine(props: { text: string }) {
  return <p class="empty-line">{props.text}</p>
}

function AgentCard(props: { data: BootstrapData; agent: string }) {
  const profile = () => props.data.agentProfiles[props.agent]
  return (
    <div class="agent-card">
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

function ProjectCreator(props: { data: BootstrapData; api: ApiClient; onCreated: (projectId: string) => void }) {
  const suffix = Math.random().toString(36).slice(2, 8)
  const [name, setName] = createSignal("FactorySight Project")
  const [path, setPath] = createSignal(defaultProjectPath("FactorySight Project", suffix))
  const [busy, setBusy] = createSignal(false)
  return (
    <form
      class="project-creator"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        const project = await props.api.createProject({
          name: name(),
          path: path(),
          permissionLevel: defaultPermissionLevel,
        })
        setBusy(false)
        props.onCreated(project.id)
      }}
    >
      <label>
        Name
        <input value={name()} onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <label>
        Folder
        <input value={path()} onInput={(event) => setPath(event.currentTarget.value)} />
      </label>
      <button disabled={busy()}>{busy() ? "Creating..." : "Create project"}</button>
    </form>
  )
}

function ProjectFiles(props: {
  data: BootstrapData
  api: ApiClient
  files: FileAttachment[]
  activeProjectId: string | undefined
  onRefresh: () => void
}) {
  const [files, setFiles] = createSignal<File[]>([])
  const [busy, setBusy] = createSignal(false)
  return (
    <Panel heading="Files" meta={`${props.files.length} project`}>
      <form
        class="file-uploader"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!props.activeProjectId || !files().length) return
          setBusy(true)
          await props.api.uploadProjectFiles(props.activeProjectId, files())
          setFiles([])
          setBusy(false)
          props.onRefresh()
        }}
      >
        <label>
          <span>{files().length ? `${files().length} selected` : "Upload project files"}</span>
          <input type="file" multiple onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))} />
        </label>
        <button disabled={!props.activeProjectId || !files().length || busy()}>
          {busy() ? "Uploading..." : "Upload"}
        </button>
      </form>
      <For each={props.files} fallback={<EmptyLine text="No project files uploaded yet." />}>
        {(file) => (
          <button
            class="file-row"
            onClick={() => (window.location.href = props.api.projectFileUrl(file.projectId, file.id))}
          >
            <strong>{file.originalName}</strong>
            <small>
              {file.relativePath} · {formatBytes(file.size)}
            </small>
          </button>
        )}
      </For>
    </Panel>
  )
}

function WorkflowCanvas(props: {
  data: BootstrapData
  project: Project | undefined
  tasks: Task[]
  chainTasks: Task[]
  selectedTask: Task | undefined
  selectedTaskId: string | undefined
  counts: ReturnType<typeof taskCounts>
  onSelectTask: (id: string) => void
  onRefresh: () => void
  onStartWorkflow: () => void
}) {
  let nodeViewport: HTMLDivElement | undefined
  const percent = createMemo(() => progressValue(props.chainTasks.length ? props.chainTasks : props.tasks))
  const visibleTasks = createMemo(() => (props.chainTasks.length ? props.chainTasks : props.tasks.slice(0, 8)))
  const [zoom, setZoom] = createSignal(1)
  const zoomLabel = createMemo(() => `${Math.round(zoom() * 100)}%`)
  const updateZoom = (delta: number) => setZoom((value) => Math.min(1.28, Math.max(0.72, value + delta)))
  const focusSelectedNode = () =>
    requestAnimationFrame(() => {
      nodeViewport
        ?.querySelector(".workflow-node.selected")
        ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
    })
  const fitCanvas = () => {
    setZoom(visibleTasks().length > 5 ? 0.82 : 0.92)
    requestAnimationFrame(() => nodeViewport?.scrollTo({ left: 0, behavior: "smooth" }))
  }

  createEffect(() => {
    props.selectedTaskId
    focusSelectedNode()
  })

  return (
    <section class="workflow-canvas">
      <div class="canvas-grid" aria-hidden="true" />
      <div class="workflow-header">
        <div>
          <span class="eyebrow">Agent workflow</span>
          <h1>{props.selectedTask?.title ?? props.project?.name ?? "Create a project to start"}</h1>
          <p>{props.project?.path ?? "FactorySight Remote is ready for a workspace."}</p>
        </div>
        <div class="run-controls">
          <button class="secondary" onClick={props.onRefresh}>
            Sync status
          </button>
          <button onClick={props.onStartWorkflow}>New workflow</button>
        </div>
      </div>
      <div class="canvas-toolbar">
        <div class="canvas-progress">
          <span>{percent()}% complete</span>
          <div>
            <i style={{ width: `${percent()}%` }} />
          </div>
        </div>
        <div class="canvas-zoom" aria-label="Canvas navigation">
          <button type="button" class="icon-button" onClick={() => updateZoom(-0.08)} aria-label="Zoom out">
            -
          </button>
          <span>{zoomLabel()}</span>
          <button type="button" class="icon-button" onClick={() => updateZoom(0.08)} aria-label="Zoom in">
            +
          </button>
          <button type="button" class="secondary" onClick={fitCanvas}>
            Fit
          </button>
          <button type="button" class="secondary" onClick={focusSelectedNode}>
            Focus
          </button>
        </div>
      </div>
      <Show when={props.chainTasks.length || props.tasks.length} fallback={<CanvasEmpty />}>
        <div class="node-viewport" ref={nodeViewport}>
          <div class="node-flow" style={{ "--canvas-zoom": zoom() }}>
            <For each={visibleTasks()}>
              {(task, index) => (
                <button
                  class="workflow-node"
                  classList={{
                    selected: task.id === props.selectedTaskId,
                    completed: task.status === "completed",
                    failed: task.status === "failed",
                  }}
                  onClick={() => props.onSelectTask(task.id)}
                >
                  <span class={`node-index ${task.status}`}>{index() + 1}</span>
                  <AgentCard data={props.data} agent={task.agent} />
                  <strong>{task.kind === "orchestration" ? "Primary planner" : task.title}</strong>
                  <small>
                    {taskStage(task)} · {statusLabel(task.status)}
                  </small>
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>
      <div class="canvas-footer">
        <span>{props.counts.running} running</span>
        <span>{props.counts.queued} queued</span>
        <span>{props.counts.completed} completed</span>
        <span>{props.counts.failed} failed</span>
      </div>
    </section>
  )
}

function CanvasEmpty() {
  return (
    <div class="canvas-empty">
      <strong>No workflow yet</strong>
      <span>Describe a mission in the command bar and FactorySight will create the agent chain.</span>
    </div>
  )
}

function NodeInspector(props: {
  data: BootstrapData
  api: ApiClient
  project: Project | undefined
  task: Task | undefined
  chainTasks: Task[]
  artifacts: Artifact[]
  files: FileAttachment[]
  onSelectTask: (id: string | undefined) => void
  onRefresh: () => void
}) {
  const [events, setEvents] = createSignal<TaskEvent[]>(props.task?.events ?? [])
  const [message, setMessage] = createSignal("")
  const digest = createMemo(() => eventDigest(events()))
  const taskFiles = createMemo(() => props.data.files.filter((file) => file.taskId === props.task?.id))
  const chainPosition = createMemo(
    () =>
      Math.max(
        0,
        props.chainTasks.findIndex((task) => task.id === props.task?.id),
      ) + 1,
  )

  createEffect(() => {
    if (!props.task) return
    setEvents(props.task.events)
    const source = new EventSource(
      `/api/tasks/${props.task.id}/events?token=${encodeURIComponent(props.api.getToken() ?? "")}`,
    )
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
    <aside class="inspector">
      <Show when={props.task} fallback={<InspectorEmpty project={props.project} />}>
        {(task) => (
          <>
            <section class="inspector-card hero">
              <div class="inspector-top">
                <AgentCard data={props.data} agent={task().agent} />
                <span class={`status-pill ${task().status}`}>{statusLabel(task().status)}</span>
              </div>
              <h2>{task().title}</h2>
              <p>{props.data.agentProfiles[task().agent]?.summary ?? "Working on this node."}</p>
              <div class="step-tabs">
                <span class="done">Setup</span>
                <span class="active">Configure</span>
                <span>Test</span>
              </div>
            </section>
            <section class="inspector-card">
              <h3>Configuration</h3>
              <dl class="node-fields">
                <div>
                  <dt>Role</dt>
                  <dd>{task().agent}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{task().model}</dd>
                </div>
                <div>
                  <dt>Position</dt>
                  <dd>
                    {chainPosition()} / {props.chainTasks.length || 1}
                  </dd>
                </div>
                <div>
                  <dt>Events</dt>
                  <dd>{events().length}</dd>
                </div>
                <div>
                  <dt>Errors</dt>
                  <dd>{digest().errors.length}</dd>
                </div>
              </dl>
            </section>
            <section class="inspector-card">
              <h3>Result</h3>
              <Show
                when={digest().deliverables.at(-1)?.text || digest().lastStatus || digest().lastOutput}
                fallback={<EmptyLine text="No output yet." />}
              >
                <pre class="output-preview">
                  {digest().deliverables.at(-1)?.text ?? digest().lastOutput ?? digest().lastStatus}
                </pre>
              </Show>
            </section>
            <section class="inspector-card">
              <h3>Artifacts</h3>
              <For each={props.artifacts} fallback={<EmptyLine text="No project artifacts yet." />}>
                {(artifact) => (
                  <button
                    class="artifact-row"
                    onClick={() =>
                      (window.location.href = artifactUrl(
                        artifact.projectId,
                        artifact.relativePath,
                        props.api.getToken(),
                      ))
                    }
                  >
                    <strong>{artifact.name}</strong>
                    <small>{artifact.relativePath}</small>
                  </button>
                )}
              </For>
              <For each={taskFiles()}>
                {(file) => (
                  <button
                    class="file-row"
                    onClick={() => (window.location.href = props.api.projectFileUrl(file.projectId, file.id))}
                  >
                    <strong>{file.originalName}</strong>
                    <small>{formatBytes(file.size)}</small>
                  </button>
                )}
              </For>
            </section>
            <section class="inspector-card timeline">
              <h3>Timeline</h3>
              <For each={digest().recent} fallback={<EmptyLine text="No timeline events yet." />}>
                {(event) => (
                  <div class={`event-line ${event.type}`}>
                    <span>{event.type}</span>
                    <time>{time(event.at)}</time>
                    <p>{event.text}</p>
                  </div>
                )}
              </For>
            </section>
            <section class="inspector-card">
              <h3>Node actions</h3>
              <form
                class="message-form"
                onSubmit={async (event) => {
                  event.preventDefault()
                  if (!message().trim()) return
                  await props.api.addMessage(task().id, { text: message() })
                  setMessage("")
                  props.onRefresh()
                }}
              >
                <textarea
                  value={message()}
                  onInput={(event) => setMessage(event.currentTarget.value)}
                  placeholder="Add instruction or approval context..."
                />
                <button>Send note</button>
              </form>
              <div class="action-grid">
                <button
                  class="secondary"
                  disabled={task().status === "archived"}
                  onClick={async () => {
                    await props.api.updateTask(task().id, { status: "archived" })
                    props.onRefresh()
                  }}
                >
                  Archive
                </button>
                <button
                  class="danger"
                  onClick={async () => {
                    await props.api.deleteTask(task().id)
                    props.onSelectTask(undefined)
                    props.onRefresh()
                  }}
                >
                  Delete
                </button>
              </div>
            </section>
          </>
        )}
      </Show>
    </aside>
  )
}

function InspectorEmpty(props: { project: Project | undefined }) {
  return (
    <section class="inspector-card hero">
      <h2>{props.project ? "Select a node" : "No project selected"}</h2>
      <p>
        {props.project
          ? "Choose a workflow node to inspect configuration, output, artifacts, and events."
          : "Create or select a project to begin."}
      </p>
    </section>
  )
}

function MissionCommandBar(props: {
  data: BootstrapData
  api: ApiClient
  project: Project | undefined
  focusRequest: number
  onCreated: (taskId: string) => void | Promise<void>
}) {
  let promptInput: HTMLTextAreaElement | undefined
  const [mode, setMode] = createSignal<ComposeMode>("swarm")
  const [scale, setScale] = createSignal<Scale>("balanced")
  const [prompt, setPrompt] = createSignal("")
  const [agent, setAgent] = createSignal("build")
  const [model, setModel] = createSignal(
    props.data.models.includes(preferredDefaultModel)
      ? preferredDefaultModel
      : (props.data.models[0] ?? preferredDefaultModel),
  )
  const [style, setStyle] = createSignal<ProductStyleId>("linear")
  const [notes, setNotes] = createSignal("")
  const [files, setFiles] = createSignal<File[]>([])
  const [busy, setBusy] = createSignal(false)
  const [listening, setListening] = createSignal(false)
  const [voiceError, setVoiceError] = createSignal("")
  const [submitError, setSubmitError] = createSignal("")
  let recognition: SpeechRecognitionLike | undefined
  const speechCtor = () => {
    const speechWindow = window as Window &
      typeof globalThis & {
        SpeechRecognition?: SpeechRecognitionConstructor
        webkitSpeechRecognition?: SpeechRecognitionConstructor
      }
    return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition
  }
  const speechSupported = () => typeof window !== "undefined" && Boolean(speechCtor())
  const appendTranscript = (text: string) => {
    const next = text.trim()
    if (!next) return
    setPrompt((current) => (current.trim() ? `${current.trim()} ${next}` : next))
  }
  const toggleVoiceInput = async () => {
    setVoiceError("")
    if (listening()) {
      recognition?.stop()
      setListening(false)
      return
    }
    const Recognition = speechCtor()
    if (!Recognition) {
      setVoiceError("Voice input is not supported in this browser.")
      return
    }
    try {
      const stream = await navigator.mediaDevices?.getUserMedia?.({ audio: true })
      stream?.getTracks().forEach((track) => track.stop())
    } catch {
      setVoiceError("Microphone permission is blocked. Please allow microphone access and try again.")
      return
    }
    recognition?.abort()
    recognition = new Recognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = preferredSpeechLanguage(navigator.languages)
    recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]
        if (result?.isFinal) appendTranscript(result[0]?.transcript ?? "")
      }
    }
    recognition.onerror = (event) => {
      setVoiceError(
        event.error === "no-speech"
          ? "No speech was detected. Click Voice again and speak after the browser indicator appears."
          : event.error
            ? `Voice input stopped: ${event.error}`
            : "Voice input stopped.",
      )
      setListening(false)
    }
    recognition.onend = () => setListening(false)
    try {
      recognition.start()
      setListening(true)
    } catch {
      setVoiceError("Voice input could not start.")
      setListening(false)
    }
  }

  onCleanup(() => recognition?.abort())

  createEffect(() => {
    if (!props.focusRequest) return
    promptInput?.focus()
    promptInput?.scrollIntoView({ behavior: "smooth", block: "center" })
  })

  return (
    <section class="mission-bar">
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          if (!props.project || !prompt().trim()) return
          setBusy(true)
          setSubmitError("")
          try {
            const payloadPrompt = productPrompt({ prompt: prompt(), style: style(), notes: notes() })
            const generatedTitle = taskTitleFromPrompt(prompt())
            const task =
              mode() === "swarm"
                ? await props.api.createOrchestration({
                    projectId: props.project.id,
                    title: generatedTitle,
                    prompt: payloadPrompt,
                    model: model(),
                    collaboration: "project",
                    scale: scale(),
                    files: files(),
                  })
                : await props.api.createTask({
                    projectId: props.project.id,
                    title: generatedTitle,
                    prompt: payloadPrompt,
                    agent: agent(),
                    model: model(),
                    collaboration: "project",
                    files: files(),
                  })
            setPrompt("")
            setFiles([])
            await props.onCreated(task.id)
          } catch (error) {
            setSubmitError(error instanceof Error ? error.message : String(error))
          } finally {
            setBusy(false)
          }
        }}
      >
        <div class="mission-input">
          <span>Mission</span>
          <textarea
            ref={promptInput}
            value={prompt()}
            onInput={(event) => setPrompt(event.currentTarget.value)}
            placeholder="Describe the product or engineering outcome. FactorySight will name the task automatically..."
          />
          <div class="voice-tools">
            <button
              type="button"
              class="secondary voice-button"
              classList={{ active: listening() }}
              disabled={!speechSupported()}
              aria-pressed={listening()}
              title={speechSupported() ? "Use voice input" : "Voice input is not supported in this browser"}
              onClick={toggleVoiceInput}
            >
              {listening() ? "Listening" : "Voice"}
            </button>
            <Show when={voiceError()}>
              <small>{voiceError()}</small>
            </Show>
          </div>
        </div>
        <Show when={submitError()}>
          <div class="composer-error">{submitError()}</div>
        </Show>
        <div class="mission-options">
          <div class="mission-selects">
            <select value={mode()} onChange={(event) => setMode(event.currentTarget.value as ComposeMode)}>
              <option value="swarm">Agent swarm</option>
              <option value="direct">Direct agent</option>
            </select>
            <Show
              when={mode() === "swarm"}
              fallback={
                <select value={agent()} onChange={(event) => setAgent(event.currentTarget.value)}>
                  <For each={props.data.agents}>
                    {(item) => <option value={item}>{props.data.agentProfiles[item]?.name ?? item}</option>}
                  </For>
                </select>
              }
            >
              <select value={scale()} onChange={(event) => setScale(event.currentTarget.value as Scale)}>
                <option value="focused">Focused</option>
                <option value="balanced">Balanced</option>
                <option value="wide">Wide</option>
              </select>
            </Show>
            <select value={model()} onChange={(event) => setModel(event.currentTarget.value)}>
              <For each={props.data.models}>{(item) => <option value={item}>{item}</option>}</For>
            </select>
            <select value={style()} onChange={(event) => setStyle(event.currentTarget.value as ProductStyleId)}>
              <For each={productStyles}>{(item) => <option value={item.id}>{item.name}</option>}</For>
            </select>
            <input value={notes()} onInput={(event) => setNotes(event.currentTarget.value)} placeholder="Style notes" />
          </div>
          <div class="mission-actions">
            <label class="attach-control">
              {files().length ? `${files().length} files` : "Attach"}
              <input type="file" multiple onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))} />
            </label>
            <button disabled={!props.project || !prompt().trim() || busy()}>
              {busy() ? "Launching..." : "Launch"}
            </button>
          </div>
        </div>
      </form>
    </section>
  )
}

render(() => <App />, document.getElementById("root")!)
