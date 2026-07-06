import type {
  AddMessagePayload,
  AuthPayload,
  BootstrapData,
  CreateOrchestrationPayload,
  CreateProjectPayload,
  CreateTaskPayload,
  FileAttachment,
  Project,
  ShareTaskPayload,
  Task,
  TaskEvent,
  UpdateProjectPayload,
  UpdateTaskPayload,
} from "./shared"

export class ApiClient {
  constructor(private token: string | undefined) {}

  setToken(token: string | undefined) {
    this.token = token
  }

  getToken() {
    return this.token
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`)
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }
    const response = await fetch(path, { ...init, headers })
    if (!response.ok) {
      const text = await response.text()
      let message = text
      try {
        const body = JSON.parse(text) as { error?: string }
        message = body.error || text
      } catch {}
      throw new Error(message || `Request failed: ${response.status}`)
    }
    return (await response.json()) as T
  }

  login(payload: AuthPayload) {
    return this.request<{ token: string; user: BootstrapData["user"] }>("/api/login", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  }

  bootstrap() {
    return this.request<BootstrapData>("/api/app/bootstrap")
  }

  createProject(payload: CreateProjectPayload) {
    return this.request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  }

  updateProject(projectId: string, payload: UpdateProjectPayload) {
    return this.request<Project>(`/api/projects/${projectId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    })
  }

  deleteProject(projectId: string) {
    return this.request<{ deletedProjectId: string; deletedTaskCount: number }>(`/api/projects/${projectId}`, {
      method: "DELETE",
    })
  }

  uploadProjectFiles(projectId: string, files: File[]) {
    const body = new FormData()
    for (const file of files) body.append("files", file)
    return this.request<{ files: FileAttachment[] }>(`/api/projects/${projectId}/files`, {
      method: "POST",
      body,
    })
  }

  projectFileUrl(projectId: string, fileId: string) {
    const suffix = this.token ? `?token=${encodeURIComponent(this.token)}` : ""
    return `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}${suffix}`
  }

  taskFiles(taskId: string) {
    return this.request<FileAttachment[]>(`/api/tasks/${taskId}/files`)
  }

  createTask(payload: CreateTaskPayload & { files?: File[] }) {
    if (payload.files?.length) {
      const body = new FormData()
      body.set("projectId", payload.projectId)
      body.set("title", payload.title)
      body.set("prompt", payload.prompt)
      body.set("agent", payload.agent)
      body.set("model", payload.model)
      body.set("collaboration", payload.collaboration)
      for (const file of payload.files) body.append("files", file)
      return this.request<Task>("/api/tasks", { method: "POST", body })
    }
    return this.request<Task>("/api/tasks", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  }

  createOrchestration(payload: CreateOrchestrationPayload & { files?: File[] }) {
    if (payload.files?.length) {
      const body = new FormData()
      body.set("projectId", payload.projectId)
      body.set("title", payload.title)
      body.set("prompt", payload.prompt)
      body.set("model", payload.model)
      body.set("collaboration", payload.collaboration)
      body.set("scale", payload.scale ?? "balanced")
      for (const file of payload.files) body.append("files", file)
      return this.request<Task>("/api/orchestrations", { method: "POST", body })
    }
    return this.request<Task>("/api/orchestrations", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  }

  getTask(taskId: string) {
    return this.request<Task>(`/api/tasks/${taskId}`)
  }

  updateTask(taskId: string, payload: UpdateTaskPayload) {
    return this.request<Task>(`/api/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    })
  }

  deleteTask(taskId: string) {
    return this.request<{ deletedTaskIds: string[] }>(`/api/tasks/${taskId}`, {
      method: "DELETE",
    })
  }

  addMessage(taskId: string, payload: AddMessagePayload) {
    return this.request<TaskEvent>(`/api/tasks/${taskId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
  }

  shareTask(taskId: string, payload: ShareTaskPayload) {
    return this.request<Task>(`/api/tasks/${taskId}/share`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
  }
}
