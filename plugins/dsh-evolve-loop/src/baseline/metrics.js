import { bestOf, verified } from './lineage.js'

export function summarize(rows, routes, budget) {
  const baseline = rows[0]
  const attempts = rows.slice(1)
  const byId = new Map(rows.map(row => [row.id, row]))
  let best = verified(baseline) ? baseline.fitness : undefined
  let area = 0
  let measured = 0
  let rowIndex = 0
  const recovery = []
  // Include spent attempts with no row, such as an interruption during generation.
  for (let i = 1; i <= budget.used; i++) {
    const row = attempts[rowIndex]
    if (row && Number(row.id.slice(1)) === i) {
      if (verified(row)) best = best === undefined ? row.fitness : Math.max(best, row.fitness)
      rowIndex++
    }
    if (best !== undefined) {
      area += best
      measured++
    }
  }
  let valleys = 0
  let crossings = 0
  let steppingStones = 0
  let developedStones = 0
  for (const route of routes) {
    const founder = route.valid[0]
    const anchor = byId.get(route.anchor)
    if (verified(anchor) && founder && founder.fitness < anchor.fitness && route.mode !== 'local') {
      valleys++
      const descendants = route.valid.slice(1).filter(row => {
        let parent = byId.get(row.parent)
        while (parent && parent.id > founder.id) parent = byId.get(parent.parent)
        return parent?.id === founder.id
      })
      if (descendants.some(row => row.fitness > anchor.fitness)) crossings++
      if (descendants.length) developedStones++
      if (descendants.some(row => row.fitness > founder.fitness)) steppingStones++
    }
    if (route.rollbackOf) {
      const original = routes.find(other => other.id === route.rollbackOf)
      const first = route.attempts[0]
      const better = route.valid.find(row => row.fitness > (original?.best ?? route.origin))
      recovery.push({ route: route.id, rollbackOf: route.rollbackOf,
        attemptsToRecover: better && first ? Number(better.id.slice(1)) - Number(first.id.slice(1)) + 1 : null })
    }
  }
  const final = bestOf(rows)?.fitness
  const elapsed = attempts.reduce((sum, row) => sum + (row.costSeconds ?? 0), 0)
  const forecast = attempts.map((row, i) => {
    if (!row.preEvaluation || i + 4 > attempts.length) return undefined
    const parent = byId.get(row.parent)
    if (!verified(parent)) return undefined
    const prefix = bestOf(rows.filter(prior => prior.id < row.id))
    const next = bestOf(attempts.slice(i, i + 4))
    if (!prefix || !next) return undefined
    const { SE, WE } = row.preEvaluation.probabilities
    return { prediction: SE + WE, grew: Number(next.fitness > prefix.fitness) }
  }).filter(Boolean)
  return {
    finalBestScore: final ?? null,
    diagnosisForecast: {
      horizon: 4, observations: forecast.length,
      brier: forecast.length ? forecast.reduce((sum, item) =>
        sum + (item.prediction - item.grew) ** 2, 0) / forecast.length : null,
    },
    bestScoreAUC: measured ? area / measured : null, aucMeasuredAttempts: measured,
    breakthrough: verified(baseline) && final !== undefined ? final > baseline.fitness : null,
    valleyCrossingRate: valleys ? crossings / valleys : null, valleyRoutes: valleys,
    steppingStoneSurvivalRate: valleys ? developedStones / valleys : null, steppingStoneCount: steppingStones,
    wrongRouteRecovery: recovery,
    redundantMutationRate: attempts.length ? attempts.filter(row =>
      row.disposition === 'duplicate-code' || row.repeatedDirection).length / attempts.length : null,
    directionDiversity: new Set(attempts.map(row => row.fingerprint).filter(Boolean)).size,
    improvementPerElapsedSecond: elapsed && verified(baseline) && final !== undefined
      ? (final - baseline.fitness) / elapsed : null,
  }
}

