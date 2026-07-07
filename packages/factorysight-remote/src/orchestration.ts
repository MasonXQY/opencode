import type { Task } from "./shared"

export type OrchestrationScale = "focused" | "balanced" | "wide"
export type OrchestrationPhase = "plan" | "shape" | "design" | "build" | "verify"

export type OrchestrationStep = {
  agent: string
  title: string
  brief: string
  phase: OrchestrationPhase
  requires: string[]
  provides: string[]
  acceptance: string
  failurePolicy: "stop" | "retry" | "continue"
}

function step(
  input: Omit<OrchestrationStep, "requires" | "provides" | "acceptance" | "failurePolicy"> & {
    requires?: string[]
    provides?: string[]
    acceptance?: string
    failurePolicy?: OrchestrationStep["failurePolicy"]
  },
): OrchestrationStep {
  return {
    requires: ["Parent objective", "Project workspace", "Prior handoff context"],
    provides: ["Findings", "Concrete next-step context"],
    acceptance: "Return concise task-relevant output that the next agent can directly use.",
    failurePolicy: input.phase === "verify" ? "continue" : "stop",
    ...input,
  }
}

export function orchestrationPlan(prompt: string, scale: OrchestrationScale): OrchestrationStep[] {
  const normalized = prompt.toLowerCase()
  const agents: OrchestrationStep[] = [
    step({
      agent: "plan",
      title: "Plan orchestration sequence",
      brief:
        "Create the execution plan first: clarify goal, dependencies, sequence, risks, acceptance criteria, and which specialist roles should act next.",
      phase: "plan",
      requires: ["User objective", "Project workspace", "Available agent roster"],
      provides: ["Execution sequence", "Risks", "Acceptance criteria", "Recommended specialist roles"],
      acceptance: "A downstream agent can start work without re-discovering scope or order.",
      failurePolicy: "stop",
    }),
    step({
      agent: "product-lead",
      title: "Shape product intent and acceptance criteria",
      brief: "Clarify user value, scope, edge cases, and acceptance criteria.",
      phase: "shape",
      requires: ["Planner sequence", "User objective"],
      provides: ["User value", "Non-goals", "Acceptance criteria"],
    }),
    step({
      agent: "tech-lead",
      title: "Design implementation approach",
      brief: "Choose architecture, sequencing, risks, and integration points.",
      phase: "design",
      requires: ["Planner sequence", "Product acceptance criteria", "Existing codebase context"],
      provides: ["Implementation approach", "Risk controls", "Verification strategy"],
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
      brief: "Check build, type safety, core flows, and regression risk.",
      phase: "verify",
      requires: ["Implementation output", "Acceptance criteria"],
      provides: ["Regression results", "Remaining risks"],
      failurePolicy: "continue",
    }),
    step({
      agent: "code-reviewer",
      title: "Review final changes",
      brief: "Look for bugs, missing tests, security issues, and unclear behavior.",
      phase: "verify",
      requires: ["Implementation output", "Verification results"],
      provides: ["Review findings", "Merge readiness recommendation"],
      failurePolicy: "continue",
    }),
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

export function initialOrchestrationPlan(prompt: string, scale: OrchestrationScale): OrchestrationStep[] {
  const coreAgents = new Set(["plan", "product-lead", "tech-lead", "build"])
  return orchestrationPlan(prompt, scale).filter((step) => coreAgents.has(step.agent))
}

export function adaptiveOrchestrationSteps(input: {
  prompt: string
  scale: OrchestrationScale
  completedAgent: string
  existingAgents: string[]
}): OrchestrationStep[] {
  const existing = new Set(input.existingAgents)
  const fullPlan = orchestrationPlan(input.prompt, input.scale).filter((step) => !existing.has(step.agent))
  const take = (phases: OrchestrationPhase[], limit: number) =>
    fullPlan.filter((step) => phases.includes(step.phase)).slice(0, limit)

  if (input.completedAgent === "plan") return take(["design"], 2)
  if (["product-lead", "tech-lead", "architect", "ux-designer"].includes(input.completedAgent)) {
    return take(["build"], 2)
  }
  if (input.completedAgent === "build" || input.completedAgent.endsWith("-engineer")) return take(["verify"], 3)
  return []
}

export function orchestrationStepForTask(parent: Task, task: Task, scale: OrchestrationScale): OrchestrationStep {
  return (
    orchestrationPlan(parent.prompt, scale).find((step) => step.agent === task.agent && step.title === task.title) ??
    orchestrationPlan(parent.prompt, scale).find((step) => step.agent === task.agent) ??
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
  return [
    `You are the ${step.agent} role in an autonomous FactorySight orchestration.`,
    `Phase: ${step.phase}`,
    `Parent objective: ${parent.prompt}`,
    priorContext ? `Prior orchestration context:\n${priorContext}` : undefined,
    `Your responsibility: ${step.brief}`,
    "Agent handoff contract:",
    `- Requires: ${step.requires.join("; ")}`,
    `- Provides: ${step.provides.join("; ")}`,
    `- Acceptance: ${step.acceptance}`,
    `- Failure policy: ${step.failurePolicy}`,
    "Work in your own bounded context. Do not assume other specialist roles saw your local reasoning.",
    "Return only task-relevant findings, concrete changes, verification notes, and handoff context for the orchestrator.",
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
    `Requires: ${input.step.requires.join("; ")}`,
    `Provides: ${input.step.provides.join("; ")}`,
    `Acceptance: ${input.step.acceptance}`,
    `Failure policy: ${input.step.failurePolicy}`,
  ].join("\n")
}
