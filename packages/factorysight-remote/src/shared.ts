export type Role = "owner" | "collaborator" | "reviewer" | "viewer"
export type PermissionLevel = "ask" | "read_only" | "auto_safe" | "full_auto"

export type User = {
  id: string
  name: string
  email: string
}

export type Project = {
  id: string
  name: string
  path: string
  permissionLevel: PermissionLevel
  createdAt: string
  memberships: Record<string, Role>
}

export type TaskStatus =
  | "draft"
  | "queued"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_user"
  | "failed"
  | "completed"
  | "archived"

export type TaskEvent = {
  id: string
  taskId: string
  at: string
  type: "created" | "status" | "message" | "runner" | "error" | "approval" | "system" | "deliverable"
  authorId?: string
  text: string
}

export type Artifact = {
  projectId: string
  name: string
  relativePath: string
}

export type FileAttachment = {
  id: string
  projectId: string
  taskId?: string
  scope: "project" | "task"
  name: string
  originalName: string
  relativePath: string
  size: number
  type: string
  uploadedBy: string
  createdAt: string
}

export type Task = {
  id: string
  projectId: string
  creatorId: string
  parentTaskId?: string
  childTaskIds?: string[]
  kind?: "single" | "orchestration"
  assigneeId?: string
  title: string
  prompt: string
  agent: string
  model: string
  status: TaskStatus
  collaboration: "private" | "project" | "shared"
  createdAt: string
  updatedAt: string
  sessionId?: string
  runnerPid?: number
  fileIds?: string[]
  events: TaskEvent[]
}

export type Session = {
  token: string
  userId: string
  createdAt: string
}

export type AppState = {
  users: User[]
  sessions: Session[]
  projects: Project[]
  tasks: Task[]
  files?: FileAttachment[]
}

export type AuthPayload = {
  email: string
}

export type CreateProjectPayload = {
  name: string
  path: string
  permissionLevel?: PermissionLevel
  collaboratorIds?: string[]
}

export type UpdateProjectPayload = {
  permissionLevel?: PermissionLevel
}

export type UpdateTaskPayload = {
  status?: Extract<TaskStatus, "archived">
}

export type PermissionProfile = {
  id: PermissionLevel
  name: string
  summary: string
}

export type CreateTaskPayload = {
  projectId: string
  title: string
  prompt: string
  agent: string
  model: string
  collaboration: Task["collaboration"]
}

export type CreateOrchestrationPayload = {
  projectId: string
  title: string
  prompt: string
  model: string
  collaboration: Task["collaboration"]
  scale?: "focused" | "balanced" | "wide"
  intent?: "create" | "modify"
  parentTaskId?: string
}

export type AddMessagePayload = {
  text: string
}

export type ShareTaskPayload = {
  userId: string
  role?: Role
}

export type BootstrapData = {
  user: User
  users: User[]
  projects: Project[]
  tasks: Task[]
  artifacts: Artifact[]
  files: FileAttachment[]
  agents: string[]
  agentProfiles: Record<string, AgentProfile>
  models: string[]
  backendMode?: "local" | "factorysight"
  permissionProfiles: PermissionProfile[]
}

export type AgentProfile = {
  id: string
  name: string
  title: string
  initials: string
  color: string
  summary: string
}

export const defaultAgents = [
  "orchestrator",
  "build",
  "plan",
  "product-lead",
  "tech-lead",
  "architect",
  "backend-engineer",
  "frontend-engineer",
  "qa-engineer",
  "security-reviewer",
  "code-reviewer",
  "devops-engineer",
  "data-engineer",
  "ux-designer",
  "technical-writer",
  "delivery-manager",
]

export const agentProfiles: Record<string, AgentProfile> = {
  orchestrator: {
    id: "orchestrator",
    name: "Iris",
    title: "Orchestration Lead",
    initials: "IR",
    color: "#f2a97d",
    summary: "Breaks goals into coordinated agent work.",
  },
  build: {
    id: "build",
    name: "Kai",
    title: "Builder",
    initials: "KA",
    color: "#8bd3ff",
    summary: "Turns the plan into working code.",
  },
  plan: {
    id: "plan",
    name: "Mira",
    title: "Planner",
    initials: "MI",
    color: "#b7f7c2",
    summary: "Maps scope, sequence, and tradeoffs.",
  },
  "product-lead": {
    id: "product-lead",
    name: "Nora",
    title: "Product Lead",
    initials: "NO",
    color: "#ffd58b",
    summary: "Defines user value and acceptance criteria.",
  },
  "tech-lead": {
    id: "tech-lead",
    name: "Chen",
    title: "Technical Lead",
    initials: "CH",
    color: "#c7b7ff",
    summary: "Chooses architecture and delivery sequence.",
  },
  architect: {
    id: "architect",
    name: "Vale",
    title: "Architect",
    initials: "VA",
    color: "#94e2d5",
    summary: "Keeps system boundaries and future scaling clear.",
  },
  "backend-engineer": {
    id: "backend-engineer",
    name: "Ravi",
    title: "Backend Engineer",
    initials: "RA",
    color: "#a6e3a1",
    summary: "Builds APIs, data flow, and runtime integration.",
  },
  "frontend-engineer": {
    id: "frontend-engineer",
    name: "Lina",
    title: "Frontend Engineer",
    initials: "LI",
    color: "#89b4fa",
    summary: "Builds responsive screens and interactions.",
  },
  "qa-engineer": {
    id: "qa-engineer",
    name: "Sana",
    title: "QA Engineer",
    initials: "SA",
    color: "#f9e2af",
    summary: "Verifies flows, regressions, and release risk.",
  },
  "security-reviewer": {
    id: "security-reviewer",
    name: "Owen",
    title: "Security Reviewer",
    initials: "OW",
    color: "#f38ba8",
    summary: "Checks permission, exposure, and data boundaries.",
  },
  "code-reviewer": {
    id: "code-reviewer",
    name: "Elena",
    title: "Code Reviewer",
    initials: "EL",
    color: "#fab387",
    summary: "Reviews correctness, maintainability, and gaps.",
  },
  "devops-engineer": {
    id: "devops-engineer",
    name: "Marco",
    title: "DevOps Engineer",
    initials: "MA",
    color: "#74c7ec",
    summary: "Handles deployability, health, and operations.",
  },
  "data-engineer": {
    id: "data-engineer",
    name: "Priya",
    title: "Data Engineer",
    initials: "PR",
    color: "#cba6f7",
    summary: "Designs data pipelines, storage, and reporting.",
  },
  "ux-designer": {
    id: "ux-designer",
    name: "Ari",
    title: "UX Designer",
    initials: "AR",
    color: "#eba0ac",
    summary: "Shapes workflows, hierarchy, and usability.",
  },
  "technical-writer": {
    id: "technical-writer",
    name: "Theo",
    title: "Technical Writer",
    initials: "TH",
    color: "#b4befe",
    summary: "Turns decisions into clear docs and handoffs.",
  },
  "delivery-manager": {
    id: "delivery-manager",
    name: "June",
    title: "Delivery Manager",
    initials: "JU",
    color: "#f5c2e7",
    summary: "Tracks readiness, dependencies, and release state.",
  },
}

export const preferredDefaultModel = "anthropic/claude-opus-4-8"

export const defaultPermissionLevel: PermissionLevel = "ask"

export const permissionProfiles: PermissionProfile[] = [
  {
    id: "ask",
    name: "Ask before actions",
    summary: "Read is allowed; file edits and commands require approval in FactorySight.",
  },
  {
    id: "read_only",
    name: "Read only",
    summary: "Planning and review mode. The runner should not auto-approve edits or commands.",
  },
  {
    id: "auto_safe",
    name: "Auto safe",
    summary: "Allow low-risk automation, but keep destructive or sensitive actions gated.",
  },
  {
    id: "full_auto",
    name: "Full auto",
    summary: "Automatically approve permitted actions for fast trusted local execution.",
  },
]

export const defaultModels = [
  preferredDefaultModel,
  "opencode/gpt-oss-120b",
  "opencode/gpt-oss-20b",
  "opencode/qwen/qwen3-coder",
]
