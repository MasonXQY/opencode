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

type LibraryTab = "projects" | "files" | "artifacts" | "agents"
type ComposeMode = "swarm" | "direct"
type Scale = "focused" | "balanced" | "wide"
type WorkspaceView = "workflow" | "cli"
type FlowNodeKind = "input" | "planner" | "agent" | "artifact" | "placeholder"
type FlowNode = {
  id: string
  kind: FlowNodeKind
  x: number
  y: number
  title: string
  subtitle: string
  status?: Task["status"]
  agent?: string
  taskId?: string
  meta?: string
  previews?: FlowPreview[]
}
type NodePosition = {
  x: number
  y: number
}
type FlowEdge = {
  id: string
  from: FlowNode
  to: FlowNode
  label: string
  loop?: boolean
}
type FlowPreview = {
  id: string
  title: string
  subtitle: string
  kind: "file" | "artifact"
  href: string
  media?: "image" | "html"
}
type ProjectFlow = {
  nodes: FlowNode[]
  edges: FlowEdge[]
  width: number
  height: number
}
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

function buildProjectFlow(input: {
  project: Project | undefined
  tasks: Task[]
  chainTasks: Task[]
  artifacts: Artifact[]
  files: FileAttachment[]
  artifactToken: string | undefined
  fileUrl: (file: FileAttachment) => string
}): ProjectFlow {
  const nodeWidth = 228
  const nodeHeight = 154
  const columnGap = 290
  const rowGap = 188
  const canvasPad = 120
  const maxRowsPerColumn = 3
  const inputX = 90
  const plannerX = inputX + columnGap
  const runs = (input.chainTasks.length ? input.chainTasks : input.tasks.slice(0, 8)).filter(
    (task, index, all) => all.findIndex((item) => item.id === task.id) === index,
  )
  const nodes: FlowNode[] = []
  const filePreviews = input.files.slice(0, 3).map((file): FlowPreview => {
    const extension = file.name.split(".").at(-1)?.toUpperCase() ?? "FILE"
    return {
      id: file.id,
      title: file.originalName,
      subtitle: `${extension} · ${formatBytes(file.size)}`,
      kind: "file",
      href: input.fileUrl(file),
      media: filePreviewMedia(file),
    }
  })
  const artifactPreviews = input.artifacts.slice(0, 3).map(
    (artifact): FlowPreview => ({
      id: `${artifact.projectId}:${artifact.relativePath}`,
      title: artifact.name,
      subtitle: artifact.relativePath,
      kind: "artifact",
      href: artifactUrl(artifact.projectId, artifact.relativePath, input.artifactToken),
      media: artifactPreviewMedia(artifact),
    }),
  )
  const children = runs.slice(1)
  const childColumnCount = Math.max(1, Math.ceil(children.length / maxRowsPerColumn))
  const rowsInLargestColumn = Math.max(1, Math.min(maxRowsPerColumn, children.length || 1))
  const graphHeight = Math.max(
    620,
    canvasPad * 2 + rowsInLargestColumn * nodeHeight + (rowsInLargestColumn - 1) * rowGap,
  )
  const centerY = Math.round(graphHeight / 2 - nodeHeight / 2)
  const inputNode: FlowNode = {
    id: "flow-input",
    kind: "input",
    x: inputX,
    y: centerY,
    title: "Project requirement",
    subtitle: input.project ? "Text, voice, and attached files" : "Create a project first",
    meta: input.files.length
      ? `${input.files.length} file${input.files.length === 1 ? "" : "s"} attached`
      : "No files attached",
    previews: filePreviews,
  }
  nodes.push(inputNode)

  if (!runs.length) {
    nodes.push({
      id: "flow-placeholder",
      kind: "placeholder",
      x: plannerX,
      y: centerY,
      title: "Flow will be generated",
      subtitle: "FactorySight analyzes the requirement and creates a topology.",
      meta: "Tree, branch, or loop",
    })
  } else {
    const root = runs.at(0)!
    nodes.push({
      id: root.id,
      taskId: root.id,
      kind: root.kind === "orchestration" ? "planner" : "agent",
      x: plannerX,
      y: centerY,
      title: root.kind === "orchestration" ? "Primary planner" : root.title,
      subtitle: `${taskStage(root)} · ${root.agent}`,
      status: root.status,
      agent: root.agent,
    })
    children.forEach((task, index) => {
      const column = Math.floor(index / maxRowsPerColumn)
      const row = index % maxRowsPerColumn
      const rowsInColumn = Math.min(maxRowsPerColumn, children.length - column * maxRowsPerColumn)
      const columnHeight = rowsInColumn * nodeHeight + (rowsInColumn - 1) * (rowGap - nodeHeight)
      const startY = Math.round(graphHeight / 2 - columnHeight / 2)
      nodes.push({
        id: task.id,
        taskId: task.id,
        kind: "agent",
        x: plannerX + columnGap + column * columnGap,
        y: startY + row * rowGap,
        title: task.title,
        subtitle: `${taskStage(task)} · ${task.agent}`,
        status: task.status,
        agent: task.agent,
      })
    })
  }

  const outputX = plannerX + columnGap + childColumnCount * columnGap
  const outputNode: FlowNode = {
    id: "flow-output",
    kind: "artifact",
    x: outputX,
    y: centerY,
    title: "Artifact output",
    subtitle: input.artifacts.length ? "Project deliverables are ready" : "Outputs appear here after the run",
    meta: input.artifacts.length
      ? `${input.artifacts.length} artifact${input.artifacts.length === 1 ? "" : "s"}`
      : "No artifacts yet",
    previews: artifactPreviews,
  }
  nodes.push(outputNode)

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges: FlowEdge[] = []
  const firstRunTask = runs.at(0)
  const firstRun = firstRunTask ? byId.get(firstRunTask.id) : byId.get("flow-placeholder")
  if (firstRun) edges.push({ id: "edge-input", from: inputNode, to: firstRun, label: "analyze" })
  if (runs.length > 1) {
    const rootTask = runs.at(0)
    const root = rootTask ? byId.get(rootTask.id) : undefined
    for (const task of runs.slice(1)) {
      const child = byId.get(task.id)
      if (root && child)
        edges.push({ id: `edge-${root.id}-${child.id}`, from: root, to: child, label: taskStage(task) })
    }
  }
  const terminalNodes = runs.length > 1 ? runs.slice(1) : runs
  for (const task of terminalNodes.filter((item) => ["completed", "failed"].includes(item.status)).slice(-3)) {
    const node = byId.get(task.id)
    if (node) edges.push({ id: `edge-${node.id}-output`, from: node, to: outputNode, label: "deliver" })
  }
  const failed = runs.find((task) => task.status === "failed")
  const rootForLoop = runs.at(0)
  const root = rootForLoop ? byId.get(rootForLoop.id) : undefined
  const failedNode = failed ? byId.get(failed.id) : undefined
  if (root && failedNode && root.id !== failedNode.id) {
    edges.push({ id: `edge-loop-${failedNode.id}`, from: failedNode, to: root, label: "retry loop", loop: true })
  }
  return {
    nodes,
    edges,
    width: outputX + nodeWidth + canvasPad,
    height: graphHeight,
  }
}

function applyNodePositions(flow: ProjectFlow, positions: Record<string, NodePosition>): ProjectFlow {
  const nodes = flow.nodes.map((node) => {
    const position = positions[node.id]
    return position ? { ...node, x: position.x, y: position.y } : node
  })
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return {
    ...flow,
    nodes,
    edges: flow.edges
      .map((edge) => {
        const from = byId.get(edge.from.id)
        const to = byId.get(edge.to.id)
        return from && to ? { ...edge, from, to } : undefined
      })
      .filter((edge): edge is FlowEdge => Boolean(edge)),
  }
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

function openInNewWindow(url: string) {
  window.open(url, "_blank", "noopener,noreferrer")
}

function filePreviewMedia(file: FileAttachment): FlowPreview["media"] | undefined {
  if (file.type.startsWith("image/")) return "image"
  if (file.type === "text/html") return "html"
}

function artifactPreviewMedia(artifact: Artifact): FlowPreview["media"] | undefined {
  if (/\.(html?|svg)$/i.test(artifact.relativePath)) return "html"
  if (/\.(png|jpe?g|gif|webp|avif)$/i.test(artifact.relativePath)) return "image"
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
  const [libraryTab, setLibraryTab] = createSignal<LibraryTab>("projects")
  const [workspaceView, setWorkspaceView] = createSignal<WorkspaceView>("workflow")
  const [composerFocusRequest, setComposerFocusRequest] = createSignal(0)
  const [composerCollapsed, setComposerCollapsed] = createSignal(false)
  const [workspaceDrawerOpen, setWorkspaceDrawerOpen] = createSignal(false)
  const [detailsDrawerOpen, setDetailsDrawerOpen] = createSignal(false)
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
        view={workspaceView()}
        onView={setWorkspaceView}
        workspaceOpen={workspaceDrawerOpen()}
        detailsOpen={detailsDrawerOpen()}
        onWorkspaceOpen={() => setWorkspaceDrawerOpen((value) => !value)}
        onDetailsOpen={() => setDetailsDrawerOpen((value) => !value)}
      />
      <section class="fs-stage">
        <Show when={workspaceDrawerOpen()}>
          <ToolLibrary
            data={props.data}
            api={props.api}
            tab={libraryTab()}
            onTab={setLibraryTab}
            activeProjectId={activeProjectId()}
            onProject={(id) => {
              setActiveProjectId(id)
              props.onSelectTask(undefined)
              setWorkspaceDrawerOpen(false)
            }}
            files={activeFiles()}
            artifacts={activeArtifacts()}
            onRefresh={props.onRefresh}
          />
        </Show>
        <Show
          when={workspaceView() === "cli"}
          fallback={
            <WorkflowCanvas
              data={props.data}
              api={props.api}
              project={activeProject()}
              tasks={projectTasks()}
              chainTasks={chainTasks()}
              selectedTask={selectedTask()}
              selectedTaskId={props.selectedTaskId}
              counts={counts()}
              artifacts={activeArtifacts()}
              files={activeFiles()}
              onSelectTask={props.onSelectTask}
              onRefresh={props.onRefresh}
              onStartWorkflow={() => {
                setComposerCollapsed(false)
                setComposerFocusRequest((value) => value + 1)
              }}
            />
          }
        >
          <CliWorkspace
            project={activeProject()}
            tasks={projectTasks()}
            chainTasks={chainTasks()}
            selectedTask={selectedTask()}
            selectedTaskId={props.selectedTaskId}
            counts={counts()}
            onSelectTask={props.onSelectTask}
            onRefresh={props.onRefresh}
            onStartWorkflow={() => {
              setComposerCollapsed(false)
              setComposerFocusRequest((value) => value + 1)
            }}
          />
        </Show>
        <Show when={detailsDrawerOpen()}>
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
        </Show>
      </section>
      <MissionCommandBar
        data={props.data}
        api={props.api}
        project={activeProject()}
        focusRequest={composerFocusRequest()}
        collapsed={composerCollapsed()}
        onCollapsedChange={setComposerCollapsed}
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
  view: WorkspaceView
  onView: (view: WorkspaceView) => void
  workspaceOpen: boolean
  detailsOpen: boolean
  onWorkspaceOpen: () => void
  onDetailsOpen: () => void
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
        <button
          class="secondary"
          classList={{ active: props.workspaceOpen }}
          onClick={props.onWorkspaceOpen}
          aria-pressed={props.workspaceOpen}
        >
          Workspace
        </button>
        <button
          class="secondary"
          classList={{ active: props.detailsOpen }}
          onClick={props.onDetailsOpen}
          aria-pressed={props.detailsOpen}
        >
          Details
        </button>
        <div class="view-toggle" aria-label="Workspace view">
          <button
            classList={{ active: props.view === "workflow" }}
            aria-pressed={props.view === "workflow"}
            onClick={() => props.onView("workflow")}
          >
            Workflow
          </button>
          <button
            classList={{ active: props.view === "cli" }}
            aria-pressed={props.view === "cli"}
            onClick={() => props.onView("cli")}
          >
            CLI
          </button>
        </div>
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
  files: FileAttachment[]
  artifacts: Artifact[]
  onRefresh: () => void
}) {
  const [newProjectOpen, setNewProjectOpen] = createSignal(false)
  const [busyProjectId, setBusyProjectId] = createSignal<string | undefined>()
  const tabs: LibraryTab[] = ["projects", "files", "artifacts", "agents"]
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
                  openInNewWindow(artifactUrl(artifact.projectId, artifact.relativePath, props.api.getToken()))
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
  api: ApiClient
  project: Project | undefined
  tasks: Task[]
  chainTasks: Task[]
  selectedTask: Task | undefined
  selectedTaskId: string | undefined
  counts: ReturnType<typeof taskCounts>
  artifacts: Artifact[]
  files: FileAttachment[]
  onSelectTask: (id: string | undefined) => void
  onRefresh: () => void
  onStartWorkflow: () => void
}) {
  let nodeViewport: HTMLDivElement | undefined
  let positionedProjectId: string | undefined
  const percent = createMemo(() => progressValue(props.chainTasks.length ? props.chainTasks : props.tasks))
  const baseFlow = createMemo(() =>
    buildProjectFlow({
      project: props.project,
      tasks: props.tasks,
      chainTasks: props.chainTasks,
      artifacts: props.artifacts,
      files: props.files,
      artifactToken: props.api.getToken(),
      fileUrl: (file) => props.api.projectFileUrl(file.projectId, file.id),
    }),
  )
  const [manualPositions, setManualPositions] = createSignal<Record<string, NodePosition>>({})
  const [nodeActionBusy, setNodeActionBusy] = createSignal<string | undefined>()
  const flow = createMemo(() => applyNodePositions(baseFlow(), manualPositions()))
  const [zoom, setZoom] = createSignal(1)
  const zoomLabel = createMemo(() => `${Math.round(zoom() * 100)}%`)
  const clampZoom = (value: number) => Math.min(1.28, Math.max(0.72, value))
  const updateZoom = (delta: number) => setZoom((value) => clampZoom(value + delta))
  const setZoomAroundPoint = (nextZoom: number, clientX: number, clientY: number) => {
    const viewport = nodeViewport
    if (!viewport) {
      setZoom(nextZoom)
      return
    }
    const previousZoom = zoom()
    const rect = viewport.getBoundingClientRect()
    const localX = clientX - rect.left
    const localY = clientY - rect.top
    const contentX = (viewport.scrollLeft + localX) / previousZoom
    const contentY = (viewport.scrollTop + localY) / previousZoom
    setZoom(nextZoom)
    requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, contentX * nextZoom - localX)
      viewport.scrollTop = Math.max(0, contentY * nextZoom - localY)
    })
  }
  const handleViewportWheel = (event: WheelEvent) => {
    const shouldZoom = event.ctrlKey || event.metaKey || Math.abs(event.deltaZ) > 0
    if (!shouldZoom) return
    event.preventDefault()
    const delta = Math.max(-0.18, Math.min(0.18, -event.deltaY * 0.0025))
    if (!delta) return
    setZoomAroundPoint(clampZoom(zoom() + delta), event.clientX, event.clientY)
  }
  const taskById = createMemo(() => new Map(props.tasks.map((task) => [task.id, task])))
  const moveNode = (nodeId: string, position: NodePosition) => {
    setManualPositions((current) => ({
      ...current,
      [nodeId]: {
        x: Math.max(12, Math.round(position.x)),
        y: Math.max(12, Math.round(position.y)),
      },
    }))
  }
  const duplicateNode = async (node: FlowNode) => {
    if (!node.taskId) return
    const task = taskById().get(node.taskId)
    if (!task) return
    setNodeActionBusy(`duplicate:${node.id}`)
    try {
      const created = await props.api.createTask({
        projectId: task.projectId,
        title: `${task.title} copy`,
        prompt: task.prompt,
        agent: task.agent,
        model: task.model,
        collaboration: task.collaboration,
      })
      await props.onRefresh()
      props.onSelectTask(created.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      setNodeActionBusy(undefined)
    }
  }
  const deleteNode = async (node: FlowNode) => {
    if (!node.taskId) return
    const confirmed = window.confirm(`Delete "${node.title}"? This also removes its child tasks and task files.`)
    if (!confirmed) return
    setNodeActionBusy(`delete:${node.id}`)
    try {
      await props.api.deleteTask(node.taskId)
      if (props.selectedTaskId === node.taskId) props.onSelectTask(undefined)
      await props.onRefresh()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    } finally {
      setNodeActionBusy(undefined)
    }
  }
  const focusSelectedNode = () =>
    requestAnimationFrame(() => {
      nodeViewport
        ?.querySelector(".flow-node.selected")
        ?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
    })
  const fitCanvas = () => {
    const nextZoom = flow().width > 1500 || flow().height > 740 ? 0.72 : 0.86
    setZoom(nextZoom)
    requestAnimationFrame(() => nodeViewport?.scrollTo({ left: 0, top: 0, behavior: "smooth" }))
  }
  const autoLayout = () => {
    const nextZoom = flow().width > 1500 || flow().height > 740 ? 0.72 : 0.86
    setManualPositions({})
    setZoom(nextZoom)
    requestAnimationFrame(() => nodeViewport?.scrollTo({ left: 0, top: 0, behavior: "smooth" }))
  }

  createEffect(() => {
    const projectId = props.project?.id
    if (projectId === positionedProjectId) return
    positionedProjectId = projectId
    setManualPositions({})
  })

  createEffect(() => {
    const current = baseFlow()
    setZoom(current.width > 1500 || current.height > 740 ? 0.72 : 0.86)
    requestAnimationFrame(() => nodeViewport?.scrollTo({ left: 0, top: 0 }))
  })

  createEffect(() => {
    props.selectedTaskId
    focusSelectedNode()
  })

  return (
    <section class="workflow-canvas">
      <div class="canvas-grid" aria-hidden="true" />
      <div class="canvas-toolstrip">
        <button type="button" class="secondary" onClick={props.onRefresh}>
          Agent prompts
        </button>
        <button type="button" class="secondary" onClick={props.onStartWorkflow}>
          New node
        </button>
      </div>
      <div class="workflow-header">
        <div>
          <span class="eyebrow">Project workflow</span>
          <h1>{props.project?.name ?? "Create a project to start"}</h1>
          <p>
            {props.selectedTask
              ? `Current run: ${props.selectedTask.title}`
              : (props.project?.path ?? "FactorySight Remote is ready for a workspace.")}
          </p>
        </div>
        <div class="run-controls">
          <button class="secondary" onClick={props.onRefresh}>
            Sync status
          </button>
          <button onClick={props.onStartWorkflow}>Add requirement</button>
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
          <button type="button" class="secondary" onClick={autoLayout}>
            Auto layout
          </button>
          <button type="button" class="secondary" onClick={focusSelectedNode}>
            Focus
          </button>
        </div>
      </div>
      <div class="node-viewport" ref={nodeViewport} onWheel={handleViewportWheel}>
        <div
          class="node-flow graph-flow"
          style={{ "--canvas-zoom": zoom(), width: `${flow().width}px`, height: `${flow().height}px` }}
        >
          <FlowEdges edges={flow().edges} width={flow().width} height={flow().height} />
          <For each={flow().nodes}>
            {(node, index) => (
              <FlowNodeCard
                data={props.data}
                node={node}
                index={index() + 1}
                selected={node.taskId === props.selectedTaskId}
                zoom={zoom()}
                actionBusy={nodeActionBusy()}
                onSelect={() => node.taskId && props.onSelectTask(node.taskId)}
                onMove={moveNode}
                onDuplicate={duplicateNode}
                onDelete={deleteNode}
              />
            )}
          </For>
        </div>
      </div>
    </section>
  )
}

function CanvasEmpty() {
  return (
    <div class="canvas-empty">
      <strong>No workflow yet</strong>
      <span>Enter a requirement below and FactorySight will create the agent chain for this project.</span>
    </div>
  )
}

function FlowEdges(props: { edges: FlowEdge[]; width: number; height: number }) {
  const pathFor = (edge: FlowEdge) => {
    const fromX = edge.from.x + 228
    const fromY = edge.from.y + 70
    const toX = edge.to.x
    const toY = edge.to.y + 70
    if (edge.loop) {
      const controlY = Math.min(fromY, toY) - 120
      return `M ${fromX} ${fromY} C ${fromX + 90} ${controlY}, ${toX - 90} ${controlY}, ${toX} ${toY}`
    }
    const middle = Math.max(70, (toX - fromX) / 2)
    return `M ${fromX} ${fromY} C ${fromX + middle} ${fromY}, ${toX - middle} ${toY}, ${toX} ${toY}`
  }
  const labelPoint = (edge: FlowEdge) => ({
    x: (edge.from.x + edge.to.x) / 2 + 110,
    y: (edge.from.y + edge.to.y) / 2 + 36,
  })
  return (
    <svg class="flow-edges" viewBox={`0 0 ${props.width} ${props.height}`} aria-hidden="true">
      <defs>
        <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <For each={props.edges}>
        {(edge) => {
          const label = labelPoint(edge)
          return (
            <g classList={{ "loop-edge": edge.loop }}>
              <path class="flow-edge-path" d={pathFor(edge)} marker-end="url(#flow-arrow)" />
              <text class="flow-edge-label" x={label.x} y={label.y}>
                {edge.label}
              </text>
            </g>
          )
        }}
      </For>
    </svg>
  )
}

function FlowNodeCard(props: {
  data: BootstrapData
  node: FlowNode
  index: number
  selected: boolean
  zoom: number
  actionBusy: string | undefined
  onSelect: () => void
  onMove: (nodeId: string, position: NodePosition) => void
  onDuplicate: (node: FlowNode) => void | Promise<void>
  onDelete: (node: FlowNode) => void | Promise<void>
}) {
  const profile = createMemo(() => (props.node.agent ? props.data.agentProfiles[props.node.agent] : undefined))
  const bodyTitle = createMemo(() => {
    const agent = profile()
    if (agent) return agent.name
    if (props.node.kind === "input") return "Input package"
    if (props.node.kind === "artifact") return "Deliverables"
    if (props.node.kind === "placeholder") return "Generated flow"
    return props.node.subtitle
  })
  const bodySubtitle = createMemo(() => {
    const agent = profile()
    if (agent) return `${agent.title} · ${props.node.subtitle}`
    return props.node.subtitle
  })
  let startX = 0
  let startY = 0
  let nodeStartX = 0
  let nodeStartY = 0
  let didDrag = false
  let suppressClick = false
  const actionDisabled = () => Boolean(props.actionBusy)
  const beginDrag = (event: PointerEvent) => {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest("button, a, input, textarea, select")) return
    startX = event.clientX
    startY = event.clientY
    nodeStartX = props.node.x
    nodeStartY = props.node.y
    didDrag = false
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  const dragNode = (event: PointerEvent) => {
    const target = event.currentTarget as HTMLElement
    if (!target.hasPointerCapture(event.pointerId)) return
    const deltaX = (event.clientX - startX) / props.zoom
    const deltaY = (event.clientY - startY) / props.zoom
    if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) didDrag = true
    if (!didDrag) return
    props.onMove(props.node.id, { x: nodeStartX + deltaX, y: nodeStartY + deltaY })
  }
  const endDrag = (event: PointerEvent) => {
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
    suppressClick = didDrag
  }
  return (
    <div
      role={props.node.taskId ? "button" : "group"}
      tabIndex={props.node.taskId ? 0 : undefined}
      class={`flow-node ${props.node.kind}`}
      classList={{
        selected: props.selected,
        completed: props.node.status === "completed",
        running: props.node.status === "running",
        failed: props.node.status === "failed",
      }}
      style={{ left: `${props.node.x}px`, top: `${props.node.y}px` }}
      aria-disabled={!props.node.taskId}
      onPointerDown={beginDrag}
      onPointerMove={dragNode}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(event) => {
        if (suppressClick) {
          suppressClick = false
          event.preventDefault()
          return
        }
        props.onSelect()
      }}
      onKeyDown={(event) => {
        if (!props.node.taskId) return
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        props.onSelect()
      }}
    >
      <Show when={props.selected && props.node.taskId}>
        <div class="flow-node-actions" aria-label="Node actions">
          <button
            type="button"
            class="flow-node-action"
            aria-label="Duplicate node"
            disabled={actionDisabled()}
            onClick={(event) => {
              event.stopPropagation()
              void props.onDuplicate(props.node)
            }}
          >
            ⧉
          </button>
          <button
            type="button"
            class="flow-node-action danger"
            aria-label="Delete node"
            disabled={actionDisabled()}
            onClick={(event) => {
              event.stopPropagation()
              void props.onDelete(props.node)
            }}
          >
            ×
          </button>
        </div>
      </Show>
      <div class="flow-node-top">
        <span class="flow-node-index">
          {props.node.kind === "artifact" ? "OUT" : props.node.kind === "input" ? "IN" : props.index}
        </span>
        <span class="flow-node-kind">{props.node.title}</span>
      </div>
      <Show
        when={profile()}
        fallback={
          <div class="flow-node-icon">
            {props.node.kind === "artifact" ? "A" : props.node.kind === "input" ? "I" : "F"}
          </div>
        }
      >
        {(agent) => (
          <div class="flow-node-agent">
            <div class="agent-avatar" style={{ "--agent-color": agent().color }}>
              {agent().initials}
            </div>
            <span>{agent().name}</span>
          </div>
        )}
      </Show>
      <strong>{bodyTitle()}</strong>
      <small>{bodySubtitle()}</small>
      <Show when={props.node.previews?.length}>
        <div class="flow-previews">
          <For each={props.node.previews}>
            {(preview) => (
              <button
                type="button"
                class={`flow-preview ${preview.kind}`}
                onClick={(event) => {
                  event.stopPropagation()
                  openInNewWindow(preview.href)
                }}
              >
                <div class="flow-preview-thumb">
                  <Show
                    when={preview.media === "image"}
                    fallback={
                      <Show
                        when={preview.media === "html"}
                        fallback={<span>{preview.kind === "artifact" ? "OUT" : "IN"}</span>}
                      >
                        <iframe src={preview.href} title={preview.title} loading="lazy" />
                      </Show>
                    }
                  >
                    <img src={preview.href} alt="" loading="lazy" />
                  </Show>
                </div>
                <div>
                  <strong>{preview.title}</strong>
                  <small>{preview.subtitle}</small>
                </div>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={props.node.meta || props.node.status}>
        <span class={`flow-node-meta ${props.node.status ?? ""}`}>
          {props.node.meta ?? statusLabel(props.node.status!)}
        </span>
      </Show>
    </div>
  )
}

function CliWorkspace(props: {
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
  const visibleTasks = createMemo(() => (props.chainTasks.length ? props.chainTasks : props.tasks.slice(0, 10)))
  const selectedDigest = createMemo(() => eventDigest(props.selectedTask?.events ?? []))
  const activeText = createMemo(
    () =>
      selectedDigest().deliverables.at(-1)?.text ??
      selectedDigest().lastOutput ??
      selectedDigest().lastStatus ??
      "Enter a requirement below to stream CLI-style project progress here.",
  )
  return (
    <section class="cli-shell">
      <div class="cli-window">
        <div class="cli-chrome" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div class="cli-topline">
          <div class="cli-logo">F</div>
          <span>CHAT</span>
          <div class="cli-actions">
            <button class="secondary" onClick={props.onRefresh}>
              Sync
            </button>
            <button onClick={props.onStartWorkflow}>Add requirement</button>
          </div>
        </div>
        <div class="cli-thread">
          <div class="cli-separator">
            <span>{props.selectedTask ? "RUN ACTIVE" : "PROJECT READY"}</span>
          </div>
          <div class="cli-context">
            <button class="cli-context-row" onClick={props.onStartWorkflow}>
              <span class="cli-bullet" />
              <span>{props.project?.name ?? "No project selected"}</span>
            </button>
            <button class="cli-context-row" onClick={props.onRefresh}>
              <span class="cli-bullet hollow" />
              <span>
                {props.counts.running} running / {props.counts.completed} completed / {props.counts.failed} failed
              </span>
            </button>
          </div>
          <Show when={visibleTasks().length} fallback={<CliEmpty onStartWorkflow={props.onStartWorkflow} />}>
            <div class="cli-task-list">
              <For each={visibleTasks()}>
                {(task, index) => (
                  <button
                    class="cli-task-line"
                    classList={{ active: task.id === props.selectedTaskId, failed: task.status === "failed" }}
                    onClick={() => props.onSelectTask(task.id)}
                  >
                    <span class="cli-task-index">{String(index() + 1).padStart(2, "0")}</span>
                    <span class={`cli-task-state ${task.status}`} />
                    <span>
                      <strong>{task.kind === "orchestration" ? "Primary planner" : task.title}</strong>
                      <small>
                        {taskStage(task)} / {task.agent} / {statusLabel(task.status)}
                      </small>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <Show when={props.selectedTask}>
            {(task) => (
              <div class="cli-selected">
                <div class="cli-prompt">{task().prompt.replace(/\n+/g, " ").slice(0, 140)}</div>
                <div class="cli-output">
                  <span class={`cli-dot ${task().status}`} />
                  <p>{activeText()}</p>
                </div>
              </div>
            )}
          </Show>
        </div>
      </div>
    </section>
  )
}

function CliEmpty(props: { onStartWorkflow: () => void }) {
  return (
    <div class="cli-empty">
      <span>No project run yet.</span>
      <button onClick={props.onStartWorkflow}>Start from requirement input</button>
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
                      openInNewWindow(artifactUrl(artifact.projectId, artifact.relativePath, props.api.getToken()))
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
      <h2>{props.project ? "Select a workflow node" : "No project selected"}</h2>
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
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
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
  const [configOpen, setConfigOpen] = createSignal(false)
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
    props.onCollapsedChange(false)
    promptInput?.focus()
    promptInput?.scrollIntoView({ behavior: "smooth", block: "center" })
  })

  return (
    <section class="mission-bar" classList={{ collapsed: props.collapsed }}>
      <Show when={props.collapsed}>
        <button
          type="button"
          class="composer-fab"
          aria-label="Open requirement input"
          onClick={() => {
            props.onCollapsedChange(false)
            requestAnimationFrame(() => promptInput?.focus())
          }}
        >
          +
        </button>
      </Show>
      <Show when={!props.collapsed}>
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
            <span>Requirement</span>
            <button
              type="button"
              class="composer-minimize"
              aria-label="Collapse requirement input"
              onClick={() => props.onCollapsedChange(true)}
            >
              -
            </button>
            <textarea
              ref={promptInput}
              value={prompt()}
              onInput={(event) => setPrompt(event.currentTarget.value)}
              placeholder="Describe what this project needs next. FactorySight will plan and run the workflow automatically..."
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
            <div class="mission-inline-actions">
              <button
                type="button"
                class="secondary"
                classList={{ active: configOpen() }}
                onClick={() => setConfigOpen((value) => !value)}
              >
                Config
              </button>
              <button disabled={!props.project || !prompt().trim() || busy()}>
                {busy() ? "Launching..." : "Launch"}
              </button>
            </div>
          </div>
          <Show when={submitError()}>
            <div class="composer-error">{submitError()}</div>
          </Show>
          <Show when={configOpen()}>
            <div class="mission-config">
              <label>
                Mode
                <select value={mode()} onChange={(event) => setMode(event.currentTarget.value as ComposeMode)}>
                  <option value="swarm">Agent swarm</option>
                  <option value="direct">Direct agent</option>
                </select>
              </label>
              <Show
                when={mode() === "swarm"}
                fallback={
                  <label>
                    Agent
                    <select value={agent()} onChange={(event) => setAgent(event.currentTarget.value)}>
                      <For each={props.data.agents}>
                        {(item) => <option value={item}>{props.data.agentProfiles[item]?.name ?? item}</option>}
                      </For>
                    </select>
                  </label>
                }
              >
                <label>
                  Scale
                  <select value={scale()} onChange={(event) => setScale(event.currentTarget.value as Scale)}>
                    <option value="focused">Focused</option>
                    <option value="balanced">Balanced</option>
                    <option value="wide">Wide</option>
                  </select>
                </label>
              </Show>
              <label>
                Model
                <select value={model()} onChange={(event) => setModel(event.currentTarget.value)}>
                  <For each={props.data.models}>{(item) => <option value={item}>{item}</option>}</For>
                </select>
              </label>
              <label>
                Style
                <select value={style()} onChange={(event) => setStyle(event.currentTarget.value as ProductStyleId)}>
                  <For each={productStyles}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                </select>
              </label>
              <label>
                Style notes
                <input
                  value={notes()}
                  onInput={(event) => setNotes(event.currentTarget.value)}
                  placeholder="Optional style notes"
                />
              </label>
              <label class="attach-control">
                {files().length ? `${files().length} files` : "Attach"}
                <input
                  type="file"
                  multiple
                  onChange={(event) => setFiles(Array.from(event.currentTarget.files ?? []))}
                />
              </label>
            </div>
          </Show>
        </form>
      </Show>
    </section>
  )
}

render(() => <App />, document.getElementById("root")!)
