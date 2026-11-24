import { MODES } from './policy.js'

export function verified(row) {
  return row && Number.isFinite(row.fitness) && (row.verified ?? row.fitness !== 0)
}

export function evaluation(result) {
  const { fitness, metrics = {} } = result
  const judge = metrics.judge_result
  const accepted = typeof judge === 'string' && ['AC', 'ACCEPTED'].includes(judge.toUpperCase())
  const valid = Number.isFinite(fitness) && !metrics.error &&
    (judge === undefined ? fitness !== 0 : accepted)
  return { fitness: valid ? fitness : null, verified: valid, feedback: {
    judge, message: String(metrics.message ?? metrics.error ?? metrics.standard_error ?? '').slice(0, 700),
    executionSeconds: metrics.max_execution_time_sec,
  } }
}

export function bestOf(rows) {
  return rows.filter(verified).reduce((best, row) =>
    !best || row.fitness > best.fitness ? row : best, undefined)
}

export function routeHistory(rows, seeds, policy) {
  const groups = new Map(seeds.map(seed => [seed.id, { ...seed, attempts: [] }]))
  for (const row of rows) {
    const plan = row.plan
    if (!plan) continue
    if (!groups.has(plan.id)) groups.set(plan.id, { ...plan, attempts: [] })
    groups.get(plan.id).attempts.push(row)
  }
  const byId = new Map(rows.map(row => [row.id, row]))
  const routes = [...groups.values()].map(route => {
    const valid = route.attempts.filter(verified)
    const parent = byId.get(route.anchor)
    const origin = verified(parent) ? parent.fitness : valid[0]?.fitness ?? 0
    const best = bestOf(valid)
    let record = -Infinity
    let stale = 0
    let gains = 0
    // Reset stagnation only when the route establishes a new record.
    for (const row of route.attempts) {
      if (verified(row) && row.fitness > record) {
        if (record !== -Infinity) gains++
        record = row.fitness
        stale = 0
      } else stale++
    }
    const frontier = best
    const recent = valid.slice(-policy.horizon - 1)
    const trend = recent.length > 1 ? (recent.at(-1).fitness - recent[0].fitness) / (recent.length - 1) : 0
    const returnByCandidate = {}
    for (const row of valid) {
      const start = byId.get(row.parent)
      const base = verified(start) ? start.fitness : origin
      let value = row.fitness - base
      if (policy.delayedCredit) {
        // Credit only actual descendants. A better sibling does not repay this branch's debt.
        for (const child of valid) {
          let previous = child
          let depth = 0
          while (previous && depth < policy.horizon && previous.id !== row.id) {
            const ancestor = byId.get(previous.parent)
            if (!verified(ancestor)) break
            depth++
            previous = ancestor
          }
          if (previous?.id === row.id && depth < policy.horizon) {
            // Walk order was from descendant to ancestor. Reweight chronologically.
            let path = child
            let reward = 0
            for (let i = depth; i > 0; i--) {
              const ancestor = byId.get(path.parent)
              reward += policy.discount ** i * (path.fitness - ancestor.fitness)
              path = ancestor
            }
            value = Math.max(value, row.fitness - base + reward)
          }
        }
      }
      returnByCandidate[row.id] = value
    }
    const credit = valid.length ? (returnByCandidate[valid[0].id] ?? 0) : 0
    const increments = recent.slice(1).map((row, i) => row.fitness - recent[i].fitness)
    const variance = increments.reduce((sum, gain) => sum + (gain - trend) ** 2, 0) / Math.max(1, increments.length)
    const costs = route.attempts.map(row => row.costSeconds).filter(Number.isFinite)
    return { ...route, valid, frontier, stale, origin, best: best?.fitness ?? origin, trend, credit,
      returnByCandidate, noise: Math.sqrt(variance),
      hitRate: (gains + 1) / (route.attempts.length + 2),
      cost: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : 1 }
  })
  // Compare prefixes with the same starting parent and number of charged attempts.
  for (const route of routes) {
    if (route.mode === 'local') continue
    const references = routes.filter(ref => ref.anchor === route.anchor && ref.mode === 'local')
    const reference = references.sort((a, b) => b.attempts.length - a.attempts.length)[0]
    const visits = Math.min(policy.horizon, route.attempts.length, reference?.attempts.length ?? 0)
    if (visits === 0) continue
    const score = bestOf(route.attempts.slice(0, visits))
    const control = bestOf(reference.attempts.slice(0, visits))
    if (score && control) route.comparison = { reference: reference.id, visits, advantage: score.fitness - control.fitness }
  }
  return routes
}

export function archives(rows, routes, protection) {
  const elite = bestOf(rows)
  const families = new Map()
  for (const row of rows.filter(verified)) {
    const family = row.direction?.family || row.plan?.operation || 'baseline'
    if (!families.has(family) || families.get(family).fitness < row.fitness) families.set(family, row)
  }
  const incubation = routes.filter(route => route.mode !== 'local' && route.frontier &&
    route.attempts.length < protection && route.frontier.id !== elite?.id).map(route => route.frontier.id)
  const active = routes.filter(route => !route.dormant && route.frontier &&
    !incubation.includes(route.frontier.id)).map(route => route.frontier.id)
  const protectedIds = new Set([elite?.id, ...[...families.values()].map(row => row.id), ...incubation, ...active])
  return {
    active,
    best: elite?.id ?? null,
    elite: Object.fromEntries([...families].map(([family, row]) => [family, row.id])),
    incubation,
    dormant: rows.filter(row => !protectedIds.has(row.id)).map(row => row.id),
  }
}

export function profile(rows, routes, unit, expected) {
  const start = Math.max(1, rows.length - 24)
  const baseline = bestOf(rows.slice(0, start)) ?? bestOf(rows)
  const samples = rows.slice(start).filter(row => verified(row) && row.id !== baseline?.id)
  const anchor = baseline?.fitness ?? 0
  const local = routes.filter(route => route.mode === 'local' && route.attempts.length)
  const structural = routes.filter(route => route.mode !== 'local' && route.valid.length)
  const familyCounts = new Map()
  for (const row of rows.filter(row => row.plan)) {
    const family = row.direction?.family || row.plan.operation
    familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1)
  }
  const count = [...familyCounts.values()].reduce((a, b) => a + b, 0)
  const observed = routes.filter(route => route.valid.length).length
  // During the matched diagnostic use its common anchor. Subsequently diagnose the incumbent
  // against recent alternatives and use parent-relative improvements for the local probes.
  const initial = rows[0]
  const diagnostic = routes.filter(route => route.diagnostic)
  const diagnosing = diagnostic.some(route => route.attempts.length < expected.horizon)
  const probes = diagnosing ? diagnostic.flatMap(route => route.valid.slice(0, 1)) : samples.slice(-24)
  const reference = diagnosing && verified(initial) ? initial.fitness : anchor
  const recentLocal = local.flatMap(route => route.valid).slice(-12)
  const records = new Map(rows.map(row => [row.id, row]))
  const L = recentLocal.reduce((sum, row) =>
    sum + Math.max(0, row.fitness - (records.get(row.parent)?.fitness ?? reference)) / unit, 0)
  const recentStructural = structural.slice(-8)
  const uncertainties = routes.map(route => route.uncertainty)
  return {
    R: probes.length ? probes.filter(row => reference >= row.fitness).length / probes.length : 0.5,
    L: L / Math.max(1, recentLocal.length),
    G: recentStructural.length ? Math.max(...recentStructural.map(route => (route.best - route.origin) / unit)) : 0,
    C: count ? [...familyCounts.values()].reduce((sum, n) => sum + (n / count) ** 2, 0) : 0,
    U: uncertainties.length ? uncertainties.reduce((a, b) => a + b, 0) / uncertainties.length : 1,
    observed, expected: expected.routes,
    reference: diagnosing ? initial.id : baseline?.id,
  }
}

export function modeCredits(routes, unit) {
  return Object.fromEntries(MODES.map(mode => {
    const recent = routes.filter(route => route.mode === mode && route.valid.length)
      .sort((a, b) => a.valid.at(-1).id.localeCompare(b.valid.at(-1).id)).slice(-8).reverse()
    const weights = recent.map((_, i) => 0.8 ** i)
    const earned = recent.reduce((sum, route, i) =>
      sum + weights[i] * (route.credit + (route.comparison?.advantage ?? 0)) / unit, 0)
    return [mode, earned / Math.max(1, weights.reduce((a, b) => a + b, 0))]
  }))
}

