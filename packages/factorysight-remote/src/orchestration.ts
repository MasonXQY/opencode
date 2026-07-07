import type { Task } from "./shared"

export type OrchestrationScale = "focused" | "balanced" | "wide"
export type OrchestrationPhase = "plan" | "shape" | "design" | "build" | "verify"
export type ExecutionMode = "sequential" | "parallel"

export type OrchestrationStep = {
  agent: string
  title: string
  brief: string
  phase: OrchestrationPhase
  execution: ExecutionMode
  dependsOn: string[]
  requires: string[]
  provides: string[]
  acceptance: string
  failurePolicy: "stop" | "retry" | "continue"
}

function step(
  input: Omit<
    OrchestrationStep,
    "execution" | "dependsOn" | "requires" | "provides" | "acceptance" | "failurePolicy"
  > & {
    requires?: string[]
    provides?: string[]
    acceptance?: string
    failurePolicy?: OrchestrationStep["failurePolicy"]
  },
): OrchestrationStep {
  return {
    execution: input.phase === "design" || input.phase === "verify" ? "parallel" : "sequential",
    dependsOn:
      input.phase === "plan"
        ? []
        : input.phase === "shape" || input.phase === "design"
          ? ["Plan orchestration sequence"]
          : input.phase === "build"
            ? ["Shape product intent and acceptance criteria", "Design implementation approach"]
            : ["Execute implementation"],
    requires: ["Parent objective", "Project workspace", "Prior handoff context"],
    provides: ["Findings", "Concrete next-step context"],
    acceptance: "Return concise task-relevant output that the next agent can directly use.",
    failurePolicy: input.phase === "verify" ? "continue" : "stop",
    ...input,
  }
}

export function workflowMethodologyText() {
  return [
    "FactorySight workflow methodology:",
    "1. Decompose the objective into independent parallel points and ordered dependency chains.",
    "2. Assign each subtask to the most suitable FactorySight backend agent role from the available roster.",
    "3. Build the pipeline with explicit JSON handoff contracts for dependencies, inputs, outputs, acceptance, and failure policy.",
    "4. Aggregate results by cross-checking consistency, deduplicating overlap, normalizing format, and marking uncertainty or conflicts.",
    "The topology may adapt while running when intermediate output reveals missing expertise, failed prerequisites, new files, security risk, data needs, or additional verification work.",
  ].join("\n")
}

function uniqueAgents(agents: string[] | undefined) {
  return [...new Set((agents ?? []).filter(Boolean))]
}

function resolveAgent(preferred: string, availableAgents?: string[]) {
  const available = uniqueAgents(availableAgents)
  if (available.length === 0 || available.includes(preferred)) return preferred
  const fallbackByRole: Record<string, string[]> = {
    orchestrator: ["orchestrator", "plan", "build"],
    plan: ["plan", "tech-lead", "build"],
    "product-lead": ["product-lead", "plan", "build"],
    "tech-lead": ["tech-lead", "architect", "plan", "build"],
    architect: ["architect", "tech-lead", "plan", "build"],
    "backend-engineer": ["backend-engineer", "build", "tech-lead"],
    "frontend-engineer": ["frontend-engineer", "build", "ux-designer"],
    "qa-engineer": ["qa-engineer", "code-reviewer", "build"],
    "security-reviewer": ["security-reviewer", "code-reviewer", "tech-lead", "build"],
    "code-reviewer": ["code-reviewer", "qa-engineer", "build"],
    "devops-engineer": ["devops-engineer", "backend-engineer", "build"],
    "data-engineer": ["data-engineer", "backend-engineer", "build"],
    "ux-designer": ["ux-designer", "product-lead", "frontend-engineer", "build"],
    "technical-writer": ["technical-writer", "product-lead", "build"],
    "delivery-manager": ["delivery-manager", "plan", "product-lead"],
    build: ["build", "tech-lead", "backend-engineer", "frontend-engineer"],
  }
  return fallbackByRole[preferred]?.find((agent) => available.includes(agent)) ?? available[0] ?? preferred
}

function applyAvailableAgents(steps: OrchestrationStep[], availableAgents?: string[]) {
  return steps.map((item) => ({ ...item, agent: resolveAgent(item.agent, availableAgents) }))
}

export function orchestrationPlan(
  prompt: string,
  scale: OrchestrationScale,
  availableAgents?: string[],
): OrchestrationStep[] {
  const normalized = prompt.toLowerCase()
  const agents: OrchestrationStep[] = [
    step({
      agent: "plan",
      title: "Plan orchestration sequence",
      brief:
        "Decompose the objective into parallel work points and dependency chains, then choose the next FactorySight backend agents from the available roster.",
      phase: "plan",
      requires: ["User objective", "Project workspace", "Available agent roster"],
      provides: [
        "Dependency graph",
        "Parallelizable work points",
        "Risks",
        "Acceptance criteria",
        "Recommended specialist roles",
      ],
      acceptance: "Return a clear ordered/parallel workflow plan with JSON handoff contracts for downstream agents.",
      failurePolicy: "stop",
    }),
    step({
      agent: "product-lead",
      title: "Shape product intent and acceptance criteria",
      brief:
        "Clarify user value, scope, edge cases, acceptance criteria, and the output shape the final aggregator should enforce.",
      phase: "shape",
      requires: ["Planner sequence", "User objective"],
      provides: ["User value", "Non-goals", "Acceptance criteria", "Final output criteria"],
    }),
    step({
      agent: "tech-lead",
      title: "Design implementation approach",
      brief: "Choose architecture, dependency sequence, parallelization boundaries, risks, and integration points.",
      phase: "design",
      requires: ["Planner sequence", "Product acceptance criteria", "Existing codebase context"],
      provides: [
        "Implementation approach",
        "Dependency chain",
        "Parallelization boundaries",
        "Risk controls",
        "Verification strategy",
      ],
    }),
  ]

  if (scale !== "focused" && /(architecture|platform|scale|tenant|安全边界|架构|平台|多用户|权限)/i.test(normalized)) {
    agents.push(
      step({
        agent: "architect",
        title: "Map system architecture",
        brief: "Define boundaries, state flow, risks, and long-term architecture constraints.",
        phase: "design",
        provides: ["Architecture boundaries", "API/data contracts", "Migration constraints"],
      }),
    )
  }

  if (/(ui|frontend|web|mobile|page|screen|ux|界面|前端|手机|体验)/i.test(normalized)) {
    agents.push(
      step({
        agent: "ux-designer",
        title: "Shape user workflow",
        brief: "Design the interaction model, information hierarchy, and task flow.",
        phase: "design",
        provides: ["Interaction flow", "States", "UI acceptance criteria"],
      }),
    )
    agents.push(
      step({
        agent: "frontend-engineer",
        title: "Implement user-facing experience",
        brief: "Build the responsive UI, states, and interaction flow.",
        phase: "build",
        requires: ["UX flow", "Technical approach", "Project files"],
        provides: ["Frontend implementation", "State handling", "UI verification notes"],
        failurePolicy: "retry",
      }),
    )
  }

  if (/(api|backend|server|database|auth|runner|后端|接口|数据库)/i.test(normalized)) {
    agents.push(
      step({
        agent: "backend-engineer",
        title: "Implement backend capability",
        brief: "Build APIs, storage behavior, permissions, and runner integration.",
        phase: "build",
        requires: ["Technical approach", "Data/API contract", "Project files"],
        provides: ["Backend implementation", "API contract notes", "Operational caveats"],
        failurePolicy: "retry",
      }),
    )
  }

  if (scale === "wide" || /(security|auth|permission|public|internet|公网|安全|登录|权限)/i.test(normalized)) {
    agents.push(
      step({
        agent: "security-reviewer",
        title: "Review security and isolation",
        brief: "Check exposure, permissions, credentials, and cross-user isolation.",
        phase: "verify",
        requires: ["Implemented changes", "Permission model", "Threat-sensitive context"],
        provides: ["Security findings", "Required mitigations"],
        failurePolicy: "continue",
      }),
    )
  }

  if (scale === "wide" || /(deploy|ops|server|tunnel|cloud|部署|运维|公网)/i.test(normalized)) {
    agents.push(
      step({
        agent: "devops-engineer",
        title: "Check deployment and operations",
        brief: "Validate service startup, health, exposure model, and operational risks.",
        phase: "verify",
        provides: ["Deployment checks", "Runtime risks", "Rollback notes"],
        failurePolicy: "continue",
      }),
    )
  }

  if (scale === "wide" || /(docs|readme|north star|文档|说明)/i.test(normalized)) {
    agents.push(
      step({
        agent: "technical-writer",
        title: "Prepare handoff notes",
        brief: "Document decisions, operating steps, and follow-up work.",
        phase: "verify",
        provides: ["User-facing notes", "Operating instructions", "Known limitations"],
        failurePolicy: "continue",
      }),
    )
  }

  agents.push(
    step({
      agent: "build",
      title: "Execute implementation",
      brief: "Make the code changes needed to deliver the target behavior.",
      phase: "build",
      requires: ["Planner sequence", "Technical approach", "Project files"],
      provides: ["Working implementation", "Changed files", "Verification command results"],
      failurePolicy: "retry",
    }),
    step({
      agent: "qa-engineer",
      title: "Verify behavior",
      brief:
        "Cross-check build, type safety, core flows, regression risk, and consistency against other agent outputs.",
      phase: "verify",
      requires: ["Implementation output", "Acceptance criteria"],
      provides: ["Regression results", "Consistency checks", "Remaining risks"],
      failurePolicy: "continue",
    }),
    step({
      agent: "code-reviewer",
      title: "Review final changes",
      brief:
        "Review final changes, deduplicate overlapping findings, identify conflicts, and mark uncertainty before final aggregation.",
      phase: "verify",
      requires: ["Implementation output", "Verification results"],
      provides: ["Review findings", "Conflict notes", "Merge readiness recommendation"],
      failurePolicy: "continue",
    }),
  )

  const seen = new Set<string>()
  const unique = applyAvailableAgents(agents, availableAgents).filter((item) => {
    const key = `${item.agent}:${item.phase}:${item.title}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (scale === "focused") return unique.slice(0, 4)
  if (scale === "balanced") return unique.slice(0, 8)
  return unique
}

export function initialOrchestrationPlan(
  prompt: string,
  scale: OrchestrationScale,
  availableAgents?: string[],
): OrchestrationStep[] {
  const coreTitles = new Set([
    "Plan orchestration sequence",
    "Shape product intent and acceptance criteria",
    "Design implementation approach",
    "Execute implementation",
  ])
  return orchestrationPlan(prompt, scale, availableAgents).filter((step) => coreTitles.has(step.title))
}

export function adaptiveOrchestrationSteps(input: {
  prompt: string
  scale: OrchestrationScale
  completedAgent: string
  existingAgents: string[]
  completedOutput?: string
  availableAgents?: string[]
}): OrchestrationStep[] {
  const existing = new Set(input.existingAgents)
  const signal = `${input.prompt}\n${input.completedOutput ?? ""}`.toLowerCase()
  const signaledSteps: OrchestrationStep[] = []
  if (/(data|metric|analytics|csv|spreadsheet|dataset|数据|指标|表格|分析)/i.test(signal)) {
    signaledSteps.push(
      step({
        agent: "data-engineer",
        title: "Analyze data inputs",
        brief: "Inspect data inputs, extract useful structure, and return findings that downstream agents can use.",
        phase: "design",
        provides: ["Data findings", "Schema notes", "Quality risks"],
      }),
    )
  }
  if (/(security|permission|secret|oauth|token|auth|安全|权限|密钥|登录)/i.test(signal)) {
    signaledSteps.push(
      step({
        agent: "security-reviewer",
        title: "Review emergent security risk",
        brief:
          "Review the newly surfaced security, permission, credential, or isolation risk before the workflow continues.",
        phase: "verify",
        requires: ["Intermediate output", "Permission model", "Risk context"],
        provides: ["Security finding", "Mitigation requirement"],
        failurePolicy: "continue",
      }),
    )
  }
  if (/(deploy|release|ci|port|server|runtime|部署|发布|端口|运行时)/i.test(signal)) {
    signaledSteps.push(
      step({
        agent: "devops-engineer",
        title: "Check runtime operations",
        brief: "Check deployment, runtime startup, ports, environment, and rollback implications.",
        phase: "verify",
        provides: ["Runtime checks", "Operational risks"],
        failurePolicy: "continue",
      }),
    )
  }
  if (/(docs|readme|handoff|north star|文档|说明|交接)/i.test(signal)) {
    signaledSteps.push(
      step({
        agent: "technical-writer",
        title: "Prepare updated handoff notes",
        brief: "Summarize decisions, workflow changes, operating steps, and unresolved risks.",
        phase: "verify",
        provides: ["Handoff notes", "Operating instructions"],
        failurePolicy: "continue",
      }),
    )
  }
  const fullPlan = [
    ...applyAvailableAgents(signaledSteps, input.availableAgents),
    ...orchestrationPlan(input.prompt, input.scale, input.availableAgents),
  ].filter((step) => !existing.has(step.agent))
  const take = (phases: OrchestrationPhase[], limit: number) =>
    fullPlan.filter((step) => phases.includes(step.phase)).slice(0, limit)

  if (input.completedAgent === "plan") return take(["design"], 2)
  if (["product-lead", "tech-lead", "architect", "ux-designer"].includes(input.completedAgent)) {
    return take(["build"], 2)
  }
  if (input.completedAgent === "build" || input.completedAgent.endsWith("-engineer")) return take(["verify"], 3)
  return []
}

export function orchestrationStepForTask(
  parent: Task,
  task: Task,
  scale: OrchestrationScale,
  availableAgents?: string[],
): OrchestrationStep {
  return (
    orchestrationPlan(parent.prompt, scale, availableAgents).find(
      (step) => step.agent === task.agent && step.title === task.title,
    ) ??
    orchestrationPlan(parent.prompt, scale, availableAgents).find((step) => step.agent === task.agent) ??
    step({
      agent: task.agent,
      title: task.title,
      brief: "Complete this workflow node and pass concise handoff context to the orchestrator.",
      phase:
        task.agent === "plan"
          ? "plan"
          : task.agent.includes("review") || task.agent.includes("qa")
            ? "verify"
            : "build",
    })
  )
}

export function childPrompt(parent: Task, step: OrchestrationStep, priorContext?: string) {
  const handoffJson = JSON.stringify(
    {
      agent: step.agent,
      phase: step.phase,
      execution: step.execution,
      dependsOn: step.dependsOn,
      requires: step.requires,
      provides: step.provides,
      acceptance: step.acceptance,
      failurePolicy: step.failurePolicy,
    },
    null,
    2,
  )
  return [
    `You are the ${step.agent} role in an autonomous FactorySight orchestration.`,
    workflowMethodologyText(),
    `Phase: ${step.phase}`,
    `Execution mode: ${step.execution}`,
    `Depends on: ${step.dependsOn.length ? step.dependsOn.join("; ") : "none"}`,
    `Parent objective: ${parent.prompt}`,
    priorContext ? `Prior orchestration context:\n${priorContext}` : undefined,
    `Your responsibility: ${step.brief}`,
    "Agent handoff contract:",
    "```json",
    handoffJson,
    "```",
    `- Requires: ${step.requires.join("; ")}`,
    `- Provides: ${step.provides.join("; ")}`,
    `- Acceptance: ${step.acceptance}`,
    `- Failure policy: ${step.failurePolicy}`,
    "If your output reveals missing expertise, new data needs, unresolved security risk, deployment risk, or verification gaps, explicitly recommend the next FactorySight backend agent role to add.",
    "Work in your own bounded context. Do not assume other specialist roles saw your local reasoning.",
    "Return only task-relevant findings, concrete changes, verification notes, uncertainty/conflict markers, and handoff context for the orchestrator.",
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function handoffText(input: {
  from: string
  to: string
  step: OrchestrationStep
  status: "offered" | "accepted" | "failed" | "continued"
}) {
  return [
    `Agent handoff ${input.status}: ${input.from} -> ${input.to}`,
    `Phase: ${input.step.phase}`,
    `Execution: ${input.step.execution}`,
    `Depends on: ${input.step.dependsOn.length ? input.step.dependsOn.join("; ") : "none"}`,
    `Requires: ${input.step.requires.join("; ")}`,
    `Provides: ${input.step.provides.join("; ")}`,
    `Acceptance: ${input.step.acceptance}`,
    `Failure policy: ${input.step.failurePolicy}`,
  ].join("\n")
}
