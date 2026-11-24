import { MODES, STATES } from './policy.js'
import { bestOf, modeCredits, profile, routeHistory, verified } from './lineage.js'

export function initialPlan(policy, max) {
  const probes = policy.probes.filter(probe =>
    (policy.incubation || probe.mode !== 'incubation') &&
    (policy.counterfactual || probe.mode !== 'competition'))
  const selected = probes.slice(0, max)
  const horizon = Math.min(policy.horizon, Math.floor(max / Math.max(1, selected.length)))
  return {
    horizon: policy.diagnosis || policy.counterfactual ? horizon : 0,
    routes: selected.map((probe, i) => ({
      ...probe, id: `probe-${i + 1}`, anchor: 'c000000', parent: 'c000000', diagnostic: true,
    })),
  }
}

export function searchState(rows, initial, policy, budget) {
  const routes = routeHistory(rows, initial.horizon ? initial.routes : [], policy)
  const incumbent = bestOf(rows) ?? rows[0]
  const anchor = verified(rows[0]) ? rows[0].fitness : incumbent.fitness ?? 0
  const unit = Math.max(1e-9, Math.abs(anchor), Math.abs((incumbent.fitness ?? anchor) - anchor))
  const globalBest = incumbent.fitness ?? anchor
  for (const route of routes) {
    route.uncertainty = Math.min(1, 1 / Math.sqrt(1 + route.valid.length) + route.noise / unit)
    route.index = policy.potential(route, { remaining: budget.remaining, max: budget.max, globalBest, unit, policy })
    if (policy.fingerprints && route.attempts[0]?.repeatedDirection) {
      route.index -= unit * 0.15 / route.cost
    }
    route.dormant = route.stale >= policy.stagnation ||
      route.valid.at(-1)?.direction?.outcome === 'contradicted' ||
      (!route.valid.length && route.attempts.length > policy.repairLimit)
  }
  const diagnosis = profile(rows, routes, unit,
    { horizon: initial.horizon, routes: Math.max(1, initial.routes.length) })
  const probabilities = policy.diagnosis ? policy.estimateState(diagnosis) : [0.25, 0.25, 0.25, 0.25]
  if (!Array.isArray(probabilities) || probabilities.length !== STATES.length ||
      probabilities.some(p => !Number.isFinite(p) || p < 0) ||
      Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) > 1e-6) {
    throw new Error('baseline policy must return four state probabilities totaling one')
  }
  const credits = modeCredits(routes, unit)
  const matrix = policy.budgetMatrix(credits, policy.adaptiveBudget)
  const weights = policy.weights(probabilities, credits, policy.adaptiveBudget, matrix)
  if (!Array.isArray(weights) || weights.length !== MODES.length || weights.some(w => !Number.isFinite(w) || w < 0)) {
    throw new Error('baseline policy must return four finite nonnegative budget weights')
  }
  return { routes, incumbent, profile: diagnosis, probabilities: Object.fromEntries(
    STATES.map((state, i) => [state, probabilities[i]])), weights, matrix, unit }
}

function newRoute(mode, anchor, budget, operation, goal) {
  return { id: `route-${budget.used + 1}`, mode, anchor, parent: anchor, operation, goal }
}

function rewind(route, rows, routes) {
  const byId = new Map(rows.map(row => [row.id, row]))
  let checkpoint = byId.get(route.anchor)
  // The anchor precedes the route's founding decision. Walk farther back when
  // this route itself grew out of the same stalled strategic direction.
  while (checkpoint?.plan?.mode !== 'local' && checkpoint?.plan?.anchor) {
    const earlier = byId.get(checkpoint.plan.anchor)
    if (!earlier || earlier.id >= checkpoint.id) break
    checkpoint = earlier
  }
  const siblings = routes.filter(other => other.id !== route.id && other.anchor === checkpoint?.id)
  if (!checkpoint) return undefined
  return { checkpoint, siblings }
}

export function selectRoute(state, rows, initial, policy, budget) {
  const { routes, incumbent, weights } = state
  const diagnostics = routes.filter(route => route.diagnostic && route.attempts.length < initial.horizon)
    .sort((a, b) => a.attempts.length - b.attempts.length)
  if (diagnostics.length) return diagnostics[0]

  const rollbackControl = policy.counterfactual && routes.find(route =>
    route.rollbackOf && route.attempts.length > 0 && !routes.some(ref =>
      ref.mode === 'local' && ref.anchor === route.anchor && ref.attempts.length > 0))
  if (rollbackControl) {
    return newRoute('local', rollbackControl.anchor, budget, 'matched-local-control',
      'Develop the checkpoint using a local improvement as the control for its structural sibling.')
  }

  const protectedRoute = policy.incubation && routes.find(route =>
    route.mode !== 'local' && !route.dormant && route.attempts.length < policy.protection)
  if (protectedRoute) return protectedRoute

  const enabled = MODES.filter(mode =>
    (policy.incubation || mode !== 'incubation') &&
    (policy.counterfactual || !['backtrack', 'competition'].includes(mode)))
  const weightTotal = enabled.reduce((sum, mode) => sum + weights[MODES.indexOf(mode)], 0) || 1
  const recent = rows.filter(row => row.plan && !row.plan.diagnostic).slice(-24)
  const ranked = enabled.map(mode => {
    const used = recent.filter(row => row.plan.mode === mode).length
    return { mode, deficit: weights[MODES.indexOf(mode)] / weightTotal * (recent.length + 1) - used }
  }).sort((a, b) => b.deficit - a.deficit)

  for (const { mode } of ranked) {
    if (mode === 'backtrack') {
      const ongoing = routes.filter(route => route.mode === mode && !route.dormant &&
        route.attempts.length < policy.horizon).sort((a, b) => b.index - a.index)
      if (ongoing.length) return ongoing[0]
      const stalled = routes.filter(route => route.mode !== 'backtrack' && route.attempts.length > 0 &&
        policy.shouldBacktrack(route, policy) && !routes.some(other => other.rollbackOf === route.id))
        .sort((a, b) => a.anchor.localeCompare(b.anchor))
      if (!stalled.length) continue
      const branch = stalled[0]
      const rollback = rewind(branch, rows, routes)
      if (!rollback) continue
      const route = newRoute(mode, rollback.checkpoint.id, budget, 'counterfactual-restart',
        'Return to the checkpoint before the failed strategic choice. Test an untried sibling hypothesis. Use the earlier experiments as evidence.')
      return { ...route, rollbackOf: branch.id, alternatives: rollback.siblings.map(other => other.operation) }
    }

    const eligible = routes.filter(route => route.mode === mode && !route.dormant && route.attempts.length)
      .sort((a, b) => b.index - a.index)
    if (eligible.length && (mode === 'local' || eligible[0].attempts.length < policy.horizon * 2 ||
        eligible[0].index > 0)) return eligible[0]

    if (mode !== 'local' && !budget.remaining) continue
    const dormant = routes.filter(route => route.mode === mode && route.dormant && route.frontier &&
      !routes.some(other => other.reactivatedFrom === route.id) &&
      route.frontier.direction?.outcome !== 'contradicted')
      .sort((a, b) => b.index - a.index)
    if (mode !== 'local' && dormant[0]?.index > 0) {
      const route = newRoute(mode, dormant[0].frontier.id, budget, 'reactivation',
        'Reopen this archived checkpoint with an independent way to address its documented bottleneck.')
      return { ...route, reactivatedFrom: dormant[0].id }
    }
    const alternatives = policy.probes.filter(probe => probe.mode === mode)
    const probe = alternatives[routes.filter(route => route.mode === mode).length % alternatives.length]
    return newRoute(mode, incumbent.id, budget, probe?.operation ?? mode, probe?.goal ??
      'Investigate a distinct hypothesis that addresses the latest measured bottleneck.')
  }
  throw new Error('baseline policy has no enabled search mode')
}

