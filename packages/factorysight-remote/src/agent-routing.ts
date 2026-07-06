const primaryRunnerAgents = new Set(["build", "plan"])

export function runnerAgentFor(agent: string) {
  if (primaryRunnerAgents.has(agent)) return agent
  return "build"
}
