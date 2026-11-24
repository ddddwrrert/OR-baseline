export const MODES = ['local', 'incubation', 'competition', 'backtrack']
export const STATES = ['SS', 'SE', 'WU', 'WE']
const PRIOR = [
  [0.20, 0.50, 0.20, 0.10],
  [0.55, 0.25, 0.15, 0.05],
  [0.10, 0.20, 0.50, 0.20],
  [0.50, 0.20, 0.20, 0.10],
]

export const defaultPolicy = Object.freeze({
  probes: [
    { mode: 'local', operation: 'parameters', goal: 'Test a meaningful parameter change within the current algorithm.' },
    { mode: 'local', operation: 'local-logic', goal: 'Change a local decision or move without replacing the solver architecture.' },
    { mode: 'incubation', operation: 'neighborhood-objective', goal: 'Redesign the move neighborhood or evaluation function around a testable hypothesis.' },
    { mode: 'incubation', operation: 'state-representation', goal: 'Design a substantially different state representation using the constraints and objective.' },
    { mode: 'competition', operation: 'independent-algorithm', goal: 'Implement a distinct solver justified by the problem structure. Choose the algorithm yourself.' },
  ],
  horizon: 4,
  protection: 2,
  repairLimit: 1,
  stagnation: 4,
  discount: 0.85,
  beta: 0.7,
  diagnosis: true,
  incubation: true,
  counterfactual: true,
  delayedCredit: true,
  fingerprints: true,
  adaptiveBudget: true,
  policyEvolution: true,
  estimateState({ R, L, G, C, U, observed, expected }) {
    const confidence = Math.min(1, observed / expected)
    const strong = 0.5 + confidence * (R - 0.5)
    const improvable = 1 - Math.exp(-5 * (L + Math.max(0, G) * (1 - U) * (1 - C) / 2))
    const strongGrowth = confidence * improvable + (1 - confidence) / 2
    const weakGrowth = strongGrowth * (1 - U / 2)
    return [strong * (1 - strongGrowth), strong * strongGrowth,
      (1 - strong) * (1 - weakGrowth), (1 - strong) * weakGrowth]
  },
  budgetMatrix(credits, adaptive) {
    if (!adaptive) {
      const fixed = PRIOR[0].map((_, i) => PRIOR.reduce((sum, row) => sum + row[i] / 4, 0))
      return STATES.map(() => fixed)
    }
    return PRIOR.map(row => {
      const weights = row.map((weight, i) =>
        weight * Math.exp(Math.max(-1, Math.min(1, credits[MODES[i]] ?? 0))))
      return weights.map(weight => weight / weights.reduce((a, b) => a + b, 0))
    })
  },
  weights(state, credits, adaptive, matrix) {
    return MODES.map((_, i) => matrix.reduce((sum, row, j) => sum + row[i] * state[j], 0))
  },
  routeKey(direction) {
    return ['family', 'representation', 'mechanism', 'objective', 'hypothesis']
      .map(key => String(direction[key] ?? '').normalize('NFKC').toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()).join('|')
  },
  selectParent(route, { policy }) {
    const latest = route.valid?.at(-1)
    if (policy.incubation && route.mode !== 'local' && latest && latest.id !== route.frontier?.id) {
      const prior = route.valid.find(row => row.id === latest.parent)
      if (latest.fingerprint && prior?.fingerprint && latest.fingerprint !== prior.fingerprint &&
          latest.direction?.outcome !== 'contradicted') return latest.id
    }
    return route.frontier?.id ?? route.parent
  },
  shouldBacktrack(route, policy) {
    const last = route.valid.at(-1)
    return route.stale >= policy.stagnation || last?.direction?.outcome === 'contradicted'
  },
  potential(route, { remaining, max, globalBest, unit, policy }) {
    const horizon = Math.min(remaining, policy.horizon)
    const expectedGain = Math.max(0, route.trend) * horizon * route.hitRate
    const advantage = route.comparison?.advantage ?? 0
    const value = route.best + expectedGain + (route.credit + advantage) / 4
    const beta = policy.beta * Math.sqrt(Math.max(0, remaining) / Math.max(1, max))
    return (value - globalBest + beta * route.uncertainty * unit) / Math.max(route.cost, 0.001)
  },
})

export function resolvePolicy(settings, provider) {
  const policy = { ...defaultPolicy, ...settings, ...provider }
  if (settings?.policyEvolution === false) Object.assign(policy, defaultPolicy, settings)
  for (const key of ['horizon', 'protection', 'repairLimit', 'stagnation']) {
    const minimum = key === 'horizon' || key === 'stagnation' ? 1 : 0
    if (!Number.isSafeInteger(policy[key]) || policy[key] < minimum) throw new Error(`invalid baseline policy ${key}`)
  }
  if (!(policy.discount > 0 && policy.discount <= 1) || !Number.isFinite(policy.beta) || policy.beta < 0) {
    throw new Error('invalid baseline policy discount or beta')
  }
  if (!Array.isArray(policy.probes) || policy.probes.length === 0 || policy.probes.some(
    probe => !MODES.includes(probe.mode) || typeof probe.operation !== 'string' || typeof probe.goal !== 'string'
  )) throw new Error('invalid baseline policy probes')
  return policy
}

