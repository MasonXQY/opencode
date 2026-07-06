# Product

## Register

product

## Users

FactorySight Remote is for engineers and technical leads coordinating FactorySight agent runs from a browser or desktop shell. They use it while moving between devices, tracking active work, sharing task state, and reviewing agent output without staying attached to a local terminal.

## Product Purpose

The product turns the FactorySight backend into a web-facing control plane: sign in, register projects by server path, launch direct or swarm tasks, monitor live events, review artifacts, tune project permissions, and share sessions. Success means users can understand what is running, what changed, what needs attention, and what can be opened or approved in seconds.

## Backend Boundary

FactorySight/opencode owns backend execution, including agent orchestration, model calls, permission enforcement, task status transitions, file writes, and artifact generation. Remote and the Mac desktop app are frontends plus thin gateway surfaces. They should not become an alternate backend runtime.

## Brand Personality

Calm, operational, exact. The interface should feel like a reliable engineering console with enough hierarchy to reduce cognitive load, not a decorative AI dashboard.

## Anti-references

Avoid marketing-page drama, decorative gradients, glass-heavy panels, novelty controls, oversized metrics, and dark-mode-by-default command-center aesthetics unless the user explicitly chooses that theme. Do not make the task composer more visually important than task state and outcomes.

## Design Principles

- State before chrome: active project, permissions, running work, errors, and artifacts should be visible before decorative controls.
- Dense but legible: preserve high information density while making grouping, labels, and status vocabulary consistent.
- Standard controls win: use familiar buttons, selects, tabs, panels, and lists; do not invent affordances for routine operations.
- Progressive complexity: expose swarm, model, style, and sharing controls without overwhelming the first scan.
- Trust through clarity: dangerous actions, permission levels, errors, and runner output need explicit states and readable contrast.

## Accessibility & Inclusion

Target WCAG AA contrast for text and controls. Preserve keyboard focus visibility, avoid motion that is required to understand state, and keep responsive layouts usable on tablet and mobile widths.
