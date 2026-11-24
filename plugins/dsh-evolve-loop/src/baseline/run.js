import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { alive } from '../population.js'
import { MODES, resolvePolicy } from './policy.js'
import { initialPlan, searchState, selectRoute } from './controller.js'
import { describeDirection, programDigest, workerInstruction } from './direction.js'
import { archives, bestOf, evaluation, verified } from './lineage.js'
import { summarize } from './metrics.js'

const PENDING = 'baseline/pending.json'
export const REPORT = 'baseline/report.json'

export async function baselineSettings(task) {
  const ahc = basename(dirname(task)) === 'ale_bench' && /^ahc\d+$/.test(basename(task))
  const raw = await readFile(join(task, 'task.json'), 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (raw === undefined) return undefined
  const settings = JSON.parse(raw)
  if (settings.baseline_search === false || (!ahc && !settings.baseline_search)) return undefined
  return { program: settings.program, policy: settings.baseline_search === true ? {} : settings.baseline_search }
}

async function writeJSON(files, path, value) {
  await files.write(path, JSON.stringify(value, null, 2) + '\n')
}

async function official(candidate, evolve) {
  const path = `evals/${candidate.id}.json`
  const cached = await evolve.files.read(path)
  if (cached !== undefined) return evaluation(JSON.parse(cached))
  await evolve.evaluateOfficial(candidate)
  return evaluation(JSON.parse(await evolve.files.read(path)))
}

async function recordCandidate(pending, rows, population, evolve) {
  if (rows.some(row => row.id === pending.id)) return
  const started = performance.now()
  const result = pending.disposition === 'evaluate'
    ? await official({ id: pending.id, dir: evolve.files.resolve(`candidates/${pending.id}`) }, evolve)
    : { fitness: null, verified: false }
  await population.append({
    ...pending,
    ...result,
    costSeconds: pending.costSeconds + (performance.now() - started) / 1000,
    disposition: pending.disposition === 'evaluate' ? result.verified ? 'verified' : 'invalid' : pending.disposition,
    survival: result.verified ? 'yes' : 'no',
  })
}

function routeMetadata(route) {
  const { id, anchor, mode, operation, goal, diagnostic, rollbackOf, reactivatedFrom, alternatives } = route
  return { id, anchor, mode, operation, goal, diagnostic, rollbackOf, reactivatedFrom, alternatives }
}

async function report(evolve, rows, initial, policy, budget) {
  const state = searchState(rows, initial, policy, budget)
  const archive = archives(rows, state.routes, policy.incubation ? policy.protection : 0)
  const status = {
    budget, profile: state.profile, probabilities: state.probabilities,
    evidenceInsufficient: state.profile.observed < state.profile.expected,
    matchedBudget: initial.horizon,
    weights: Object.fromEntries(MODES.map((mode, i) => [mode, state.weights[i]])),
    budgetMatrix: state.matrix,
    archive, metrics: summarize(rows, state.routes, budget),
    providers: evolve.listProviders(),
    policyEvolutionEnabled: policy.policyEvolution,
    routes: state.routes.map(route => ({
      id: route.id, mode: route.mode, operation: route.operation, anchor: route.anchor,
      attempts: route.attempts.map(row => row.id), best: route.frontier?.id, bestFitness: route.frontier?.fitness,
      trend: route.trend, stale: route.stale,
      uncertainty: route.uncertainty, index: route.index, comparison: route.comparison,
      dormant: route.dormant, rollbackOf: route.rollbackOf, reactivatedFrom: route.reactivatedFrom,
      credit: route.credit, descendantCredit: route.returnByCandidate, meanCostSeconds: route.cost,
    })),
  }
  await writeJSON(evolve.files, REPORT, status)
}

export async function runBaseline(evolve, settings) {
  const population = evolve.population()
  const ctx = await evolve.context()
  const policy = resolvePolicy(settings.policy, evolve.getProvider('baseline_policy'))
  const useCustomSelect = !evolve.currentRun().policyFrozen && evolve.providerStacks().select.length > 1
  const saved = await evolve.files.read('baseline/initial.json')
  const initial = saved ? JSON.parse(saved) : initialPlan(policy, ctx.budget.max)
  if (!saved) await writeJSON(evolve.files, 'baseline/initial.json', initial)

  let rows = await population.rows()
  if (!rows.length) {
    const base = await evolve.copyTask()
    const result = await official(base, evolve)
    await population.append({
      ...result, id: base.id, parent: null, survival: 'yes',
      digest: await programDigest(base.dir, settings.program),
    })
    rows = await population.rows()
  }
  // Import official scores when continuing a run started by the original loop.
  if (rows.some(row => row.verified === undefined)) {
    rows = await Promise.all(rows.map(async row => {
      if (row.verified !== undefined) return row
      const cache = await evolve.files.read(`evals/${row.id}.json`)
      const result = cache ? evaluation(JSON.parse(cache)) : { fitness: null, verified: false }
      return { ...row, ...result, survival: row.parent === null || result.verified ? row.survival : 'no' }
    }))
    await population.write(rows)
  }
  // Resume a generated candidate without another worker or another allocation.
  const pending = await evolve.files.read(PENDING)
  if (pending) {
    await recordCandidate(JSON.parse(pending), rows, population, evolve)
    await evolve.files.remove(PENDING)
    rows = await population.rows()
  }

  let budget = (await evolve.context()).budget
  for (let created = 0; created < (ctx.candidates ?? Infinity) && budget.remaining; created++) {
    evolve.currentRun().signal.throwIfAborted()
    const state = searchState(rows, initial, policy, budget)
    const route = selectRoute(state, rows, initial, policy, budget)
    let parentId = policy.selectParent(route, { rows, state, budget, policy })
    const repairing = route.attempts?.length && !route.valid.length
    if (repairing) {
      const prior = route.attempts.at(-1)
      if (prior?.disposition === 'invalid' && route.attempts.length <= policy.repairLimit) parentId = prior.id
    }
    const unchangedLocalSelection = route.mode === 'local' && !route.diagnostic && !route.attempts?.length
    if (unchangedLocalSelection && useCustomSelect) {
      parentId = await evolve.select(population)
      route.anchor = parentId
    }
    const parent = rows.find(row => row.id === parentId)
    if (!parent) throw new Error(`baseline policy selected unknown parent ${parentId}`)
    const started = performance.now()
    const candidate = await evolve.mutate({
      parent: parent.id, parentFitness: parent.fitness,
      instruction: workerInstruction(parent, route, rows, policy),
      name: route.operation,
    })
    const digest = await programDigest(candidate.dir, settings.program).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    const direction = describeDirection(candidate.workerText)
    const fingerprint = direction && policy.routeKey(direction)
    const duplicateCode = digest && rows.some(row => row.digest === digest)
    const repeatedDirection = policy.fingerprints && fingerprint && !route.attempts?.length &&
      rows.some(row => row.fingerprint === fingerprint && row.plan?.id !== route.id && row.plan?.mode !== 'local')
    // A direction report guides research allocation. Every distinct generated
    // program gets official evaluation, even if its report resembles a past route.
    const entry = {
      id: candidate.id, parent: parent.id, plan: routeMetadata(route), digest, direction, fingerprint,
      repeatedDirection: Boolean(repeatedDirection),
      policy: evolve.listProviders(),
      preEvaluation: { profile: state.profile, probabilities: state.probabilities, weights: state.weights },
      disposition: !digest ? 'missing-program' : duplicateCode ? 'duplicate-code' : 'evaluate',
      costSeconds: (performance.now() - started) / 1000,
    }
    await writeJSON(evolve.files, PENDING, entry)
    await recordCandidate(entry, rows, population, evolve)
    await evolve.files.remove(PENDING)
    rows = await population.rows()
    if (alive(rows).length >= ctx.maxPopulation) {
      const elite = bestOf(rows)?.id
      await evolve.survive(Object.freeze({
        runDir: population.runDir,
        rows: () => population.rows(),
        write: proposed => {
          const flags = new Map(proposed.map(row => [row.id, row.survival]))
          return population.write(rows.map(row => ({
            ...row,
            survival: row.id === elite ? 'yes' :
              flags.get(row.id) === 'no' || !verified(row) ? 'no' : row.survival,
          })))
        },
      }))
      rows = await population.rows()
    }
    budget = (await evolve.context()).budget
  }
  await report(evolve, rows, initial, policy, budget)
  const best = bestOf(rows)
  return { best_id: best?.id ?? 'c000000', best_fitness: best?.fitness ?? 0,
    verified: Boolean(best), remaining: budget.remaining, baseline_report: `run/${REPORT}` }
}

