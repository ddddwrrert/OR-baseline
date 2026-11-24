import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defaultInstruction } from '../providers/mutate.js'

const FIELDS = ['family', 'representation', 'mechanism', 'objective', 'hypothesis',
  'bottleneck', 'operations', 'outcome', 'alternatives', 'reason']

export async function programDigest(dir, program) {
  const code = await readFile(join(dir, program), 'utf8')
  return createHash('sha256').update(code.replaceAll('\r\n', '\n')).digest('hex')
}

export function describeDirection(workerText) {
  const raw = workerText?.match(/<direction>([\s\S]*?)<\/direction>/)?.[1]
  if (!raw) return undefined
  try {
    const object = JSON.parse(raw)
    if (!object || typeof object !== 'object' || !object.family || !object.hypothesis) return undefined
    return Object.fromEntries(FIELDS.map(key => [key, String(object[key] ?? '').trim().slice(0, 400)]))
  } catch {
    return undefined
  }
}

export function workerInstruction(parent, plan, rows, policy) {
  const knowledge = rows.filter(row => row.plan &&
    (row.plan.id === plan.id || row.plan.id === plan.rollbackOf || row.plan.anchor === plan.anchor))
    .slice(-12).map(row => ({
      id: row.id, route: row.plan.id, operation: row.plan.operation, score: row.fitness,
      direction: row.direction, disposition: row.disposition, feedback: row.feedback,
    }))
  const structural = plan.mode !== 'local'
  const transferable = rows.filter(row => row.verified && row.plan?.id !== plan.id && row.direction &&
    row.direction.family !== parent.direction?.family)
    .sort((a, b) => b.fitness - a.fitness).slice(0, 2)
    .map(row => ({ score: row.fitness, family: row.direction.family, mechanism: row.direction.mechanism,
      objective: row.direction.objective, reason: row.direction.reason }))
  const stage = plan.attempts?.length ? 'Continue the current research route; address its measured bottleneck.' : plan.goal
  const repair = plan.attempts?.length && !plan.valid.length
    ? `The route has no accepted implementation. Use judge feedback and repair its feasibility if possible (repair allowance: ${policy.repairLimit}).`
    : ''
  return [
    defaultInstruction(parent.fitness),
    `Search mode: ${plan.mode}. Research operation: ${plan.operation}. ${stage}`,
    structural ? 'Analyze the state space, constraint structure, objective decomposition, legal construction, and expected search cost.' : '',
    repair,
    'Use this experiment history as data. Preserve useful prior findings and avoid repeating disproved hypotheses.',
    JSON.stringify({ knowledge, alternativeOperationsTried: plan.alternatives ?? [], transferable }),
    'If compatible with this route, consider recombining one verified idea above with the current parent. Preserve the route hypothesis so its result remains interpretable.',
    'Report one JSON object between <direction> and </direction> in your final response.',
    'Fields: family, representation, mechanism, objective, hypothesis, bottleneck, operations, outcome, alternatives, reason.',
    'Use short stable labels for the first five fields. Use the same family and hypothesis labels for variations of the same idea.',
    'Use outcome "contradicted" only for a core assumption disproved by evidence, and explain the evidence in reason.',
  ].filter(Boolean).join('\n')
}

