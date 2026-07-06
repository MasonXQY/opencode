import type { Task } from "./shared"

export type OrchestrationScale = "focused" | "balanced" | "wide"
export type OrchestrationPhase = "plan" | "shape" | "design" | "build" | "verify"

export type OrchestrationStep = {
  agent: string
  title: string
  brief: string
  phase: OrchestrationPhase
}

export function orchestrationPlan(prompt: string, scale: OrchestrationScale): OrchestrationStep[] {
  const normalized = prompt.toLowerCase()
  const agents: OrchestrationStep[] = [
    {
      agent: "plan",
      title: "Plan orchestration sequence",
      brief:
        "Create the execution plan first: clarify goal, dependencies, sequence, risks, acceptance criteria, and which specialist roles should act next.",
      phase: "plan",
    },
    {
      agent: "product-lead",
      title: "Shape product intent and acceptance criteria",
      brief: "Clarify user value, scope, edge cases, and acceptance criteria.",
      phase: "shape",
    },
    {
      agent: "tech-lead",
      title: "Design implementation approach",
      brief: "Choose architecture, sequencing, risks, and integration points.",
      phase: "design",
    },
  ]

  if (scale !== "focused" && /(architecture|platform|scale|tenant|安全边界|架构|平台|多用户|权限)/i.test(normalized)) {
    agents.push({
      agent: "architect",
      title: "Map system architecture",
      brief: "Define boundaries, state flow, risks, and long-term architecture constraints.",
      phase: "design",
    })
  }

  if (/(ui|frontend|web|mobile|page|screen|ux|界面|前端|手机|体验)/i.test(normalized)) {
    agents.push({
      agent: "ux-designer",
      title: "Shape user workflow",
      brief: "Design the interaction model, information hierarchy, and task flow.",
      phase: "design",
    })
    agents.push({
      agent: "frontend-engineer",
      title: "Implement user-facing experience",
      brief: "Build the responsive UI, states, and interaction flow.",
      phase: "build",
    })
  }

  if (/(api|backend|server|database|auth|runner|后端|接口|数据库)/i.test(normalized)) {
    agents.push({
      agent: "backend-engineer",
      title: "Implement backend capability",
      brief: "Build APIs, storage behavior, permissions, and runner integration.",
      phase: "build",
    })
  }

  if (scale === "wide" || /(security|auth|permission|public|internet|公网|安全|登录|权限)/i.test(normalized)) {
    agents.push({
      agent: "security-reviewer",
      title: "Review security and isolation",
      brief: "Check exposure, permissions, credentials, and cross-user isolation.",
      phase: "verify",
    })
  }

  if (scale === "wide" || /(deploy|ops|server|tunnel|cloud|部署|运维|公网)/i.test(normalized)) {
    agents.push({
      agent: "devops-engineer",
      title: "Check deployment and operations",
      brief: "Validate service startup, health, exposure model, and operational risks.",
      phase: "verify",
    })
  }

  if (scale === "wide" || /(docs|readme|north star|文档|说明)/i.test(normalized)) {
    agents.push({
      agent: "technical-writer",
      title: "Prepare handoff notes",
      brief: "Document decisions, operating steps, and follow-up work.",
      phase: "verify",
    })
  }

  agents.push(
    {
      agent: "build",
      title: "Execute implementation",
      brief: "Make the code changes needed to deliver the target behavior.",
      phase: "build",
    },
    {
      agent: "qa-engineer",
      title: "Verify behavior",
      brief: "Check build, type safety, core flows, and regression risk.",
      phase: "verify",
    },
    {
      agent: "code-reviewer",
      title: "Review final changes",
      brief: "Look for bugs, missing tests, security issues, and unclear behavior.",
      phase: "verify",
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

export function childPrompt(parent: Task, step: OrchestrationStep, priorContext?: string) {
  return [
    `You are the ${step.agent} role in an autonomous FactorySight orchestration.`,
    `Phase: ${step.phase}`,
    `Parent objective: ${parent.prompt}`,
    priorContext ? `Prior orchestration context:\n${priorContext}` : undefined,
    `Your responsibility: ${step.brief}`,
    "Work in your own bounded context. Do not assume other specialist roles saw your local reasoning.",
    "Return only task-relevant findings, concrete changes, verification notes, and handoff context for the orchestrator.",
  ]
    .filter(Boolean)
    .join("\n\n")
}
