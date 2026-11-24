import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Evolve } from '../src/evolve.js'
import { searchState, selectRoute, initialPlan } from '../src/baseline/controller.js'
import { defaultPolicy, resolvePolicy } from '../src/baseline/policy.js'
import { evaluation } from '../src/baseline/lineage.js'

async function fixture(t, candidates, settings = {}, options = {}) {
  const testRuns = fileURLToPath(new URL('../.test-runs/', import.meta.url))
  await mkdir(testRuns, { recursive: true })
  const task = await mkdtemp(join(testRuns, 'baseline-'))
  t.after(() => rm(task, { recursive: true, force: true }))
  await mkdir(join(task, 'evaluator'))
  await writeFile(join(task, 'solution.py'), 'VALUE = 100\n')
  await writeFile(join(task, 'task.json'), JSON.stringify({
    program: 'solution.py', sandbox: false, timeout: 4, max_retries: 0, baseline_search: settings,
  }))
  await writeFile(join(task, 'evaluator', 'evaluator.py'), [
    'import runpy', 'def evaluate(path):', '    value = runpy.run_path(path)["VALUE"]',
    '    return {"combined_score": value, "judge_result": "WRONG_ANSWER" if value == 999 else "ACCEPTED"}',
  ].join('\n'))
  let workers = 0
  let calls = 0
  const subprocess = {
    async resolveExecutable() { return 'python' },
    spawn({ argv, cwd }) {
      calls++
      const interrupted = options.failCall === calls
      const output = interrupted ? { status: 1, stdout: '', stderr: 'transient' } :
        spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' })
      return {
        done: Promise.resolve({ exitCode: output.status }),
        collected: Object.fromEntries(['stdout', 'stderr'].map(key => [key, {
          readFrom: () => ({ text: output[key] ?? '' }),
        }])),
      }
    },
  }
  const evolve = new Evolve({
    get: key => key === 'subprocess' ? subprocess : undefined,
    subagents: {
      getProvider: name => ({ name }),
      async start(_, req) {
        const id = basename(req.confine.root)
        const n = Number(id.slice(1))
        const fitness = candidates[n - 1]
        workers++
        if (fitness !== null) await writeFile(join(req.confine.root, 'solution.py'), `VALUE = ${fitness}\n# ${id}\n`)
        const direction = { family: req.label, hypothesis: req.label, representation: 'state' }
        return { async dispose() {}, result: Promise.resolve({
          output: [{ type: 'text', text: `<direction>${JSON.stringify(direction)}</direction>` }],
        }) }
      },
    },
  })
  const exec = { agent: { session: { header: { cwd: task } } } }
  return {
    evolve, run: (candidatesLimit) => evolve.run({
      maxBudget: candidates.length, candidates: candidatesLimit, maxPopulation: 3, k: 1,
    }, exec),
    rows: async () => (await readFile(join(task, 'run', 'population.jsonl'), 'utf8')).trim()
      .split('\n').map(JSON.parse),
    report: async () => JSON.parse(await readFile(join(task, 'run', 'baseline', 'report.json'), 'utf8')),
    workers: () => workers, calls: () => calls,
  }
}

test('matched forks survive low scores, retain the best, and credit actual descendants across chunks', async t => {
  const f = await fixture(t,
    [101, 102, 65, 55, 60, 104, 105, 80, 61, 72, 106, 107, 92, 66, 76, 108, 109, 125, 69, 78])
  const first = await f.run(5)
  assert.equal(first.best_fitness, 102)
  assert.equal(first.remaining, 15)
  const early = await f.report()
  assert.equal(early.matchedBudget, 4)
  assert.ok(early.archive.incubation.includes('c000003'))
  const last = await f.run()
  assert.equal(last.best_id, 'c000018')
  assert.equal(last.best_fitness, 125)
  assert.equal(last.remaining, 0)
  assert.equal(f.calls(), 21)
  const rows = await f.rows()
  assert.equal(rows[8].parent, 'c000003')
  const report = await f.report()
  assert.ok(report.routes.every(route => route.attempts.length === 4))
  const breakthrough = report.routes.find(route => route.best === 'c000018')
  assert.ok(breakthrough.credit > 0)
  assert.equal(breakthrough.comparison.visits, 4)
  assert.ok(breakthrough.comparison.advantage >= 16)
  assert.ok(report.metrics.valleyCrossingRate > 0)
})

test('rejects wrong answers and charges duplicate code without invoking the judge', async t => {
  const f = await fixture(t, [null, 999, 99])
  const result = await f.run()
  assert.equal(result.best_id, 'c000000')
  assert.equal(result.remaining, 0)
  assert.equal(f.calls(), 3)
  const rows = await f.rows()
  assert.equal(rows[1].disposition, 'duplicate-code')
  assert.equal(rows[2].verified, false)
  assert.equal(rows[2].fitness, null)
  assert.equal(evaluation({ fitness: 0, metrics: { judge_result: 'ACCEPTED' } }).verified, true)
})

test('resumes an allocated candidate after a judge transport error', async t => {
  const f = await fixture(t, [110, 120], {}, { failCall: 2 })
  await assert.rejects(f.run(1), /transient/)
  assert.equal(f.workers(), 1)
  const result = await f.run(1)
  assert.equal(f.workers(), 2)
  assert.equal(result.best_fitness, 120)
  assert.equal(result.remaining, 0)
  assert.equal((await f.rows()).length, 3)
})

test('rolls back to the founding decision and keeps alternate op history', () => {
  const policy = resolvePolicy({}, {
    weights: () => [0, 0, 0, 1],
  })
  const trial = { ...initialPlan(policy, 5), horizon: 0 }
  const rows = [
    { id: 'c000000', parent: null, fitness: 100, verified: true },
    { id: 'c000001', parent: 'c000000', fitness: 60, verified: true,
      plan: { id: 'A', anchor: 'c000000', mode: 'incubation', operation: 'state' } },
    { id: 'c000002', parent: 'c000001', fitness: 62, verified: true,
      direction: { outcome: 'contradicted' },
      plan: { id: 'B', anchor: 'c000001', mode: 'competition', operation: 'mix' } },
  ]
  const budget = { used: 2, max: 30, remaining: 28 }
  const state = searchState(rows, trial, { ...policy, incubation: false }, budget)
  const route = selectRoute(state, rows, trial, { ...policy, incubation: false }, budget)
  assert.equal(route.rollbackOf, 'B')
  assert.equal(route.parent, 'c000000')
  assert.deepEqual(route.alternatives, ['state'])
  assert.equal(defaultPolicy.routeKey({ family: '  Simulated Annealing !!' }),
    defaultPolicy.routeKey({ family: 'simulated annealing' }))
})

test('a runtime policy can replace the probe and diagnosis hooks', async t => {
  const f = await fixture(t, [110, 120])
  const dispose = f.evolve.register('baseline_policy', {
    name: 'policy-fixture',
    probes: [{ mode: 'local', operation: 'revised', goal: 'Test revised behavior.' }],
    estimateState: () => [0.2, 0.3, 0.4, 0.1],
  })
  await f.run(1)
  const report = await f.report()
  assert.equal(report.providers.baseline_policy, 'policy-fixture')
  assert.equal(report.routes[0].operation, 'revised')
  assert.equal(report.probabilities.WU, 0.4)
  dispose()
  assert.equal(f.evolve.listProviders().baseline_policy, 'baseline-default')
})


test('policy evolution ablation bypasses activated loop, mutate, and baseline policy providers', async t => {
  const f = await fixture(t, [110], { policyEvolution: false })
  const forbidden = () => { throw new Error('dynamic provider should be disabled') }
  f.evolve.register('loop', forbidden)
  f.evolve.register('mutate', forbidden)
  f.evolve.register('baseline_policy', { estimateState: forbidden })
  const result = await f.run()
  assert.equal(result.best_fitness, 110)
  assert.equal((await f.report()).policyEvolutionEnabled, false)
})

test('legacy default loop still accepts the original task config and output contract', async t => {
  const f = await fixture(t, [110], false)
  const result = await f.run()
  assert.deepEqual(result, { best_id: 'c000001', best_fitness: 110, remaining: 0 })
})
