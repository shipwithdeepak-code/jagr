import type { OvernightRun, Task, WorkspaceSettings } from '@/domain/types';
import { TEAMS } from '@/domain/defaults';
import { createSimulationAdapters } from '@/simulation/adapters';
import { SCENARIOS, type ScenarioId } from '@/simulation/scenarios';
import type { DecideOptions } from './actions';
import { runOvernight } from './orchestrator';
import { createDeterministicReasoner, type ReasoningEngine } from './reasoning';

/**
 * Wire a scenario's simulated adapters into the orchestrator. Swapping to production means
 * building an AdapterSet from real connectors instead of `createSimulationAdapters`.
 */
export async function runScenario(
  scenarioId: ScenarioId,
  settings: WorkspaceSettings,
  opts: { runId?: string; seedTasks?: Task[]; reasoner?: ReasoningEngine; decide?: DecideOptions } = {},
): Promise<OvernightRun> {
  const dataset = SCENARIOS[scenarioId]();
  const adapters = createSimulationAdapters(dataset, { availability: settings.integrations, seedIssues: opts.seedTasks ?? [], teams: TEAMS });
  return runOvernight({
    runId: opts.runId ?? `run-${scenarioId}`,
    scenario: { id: dataset.id, name: dataset.name },
    nightStart: dataset.nightStart,
    buckets: dataset.buckets,
    settings,
    teams: TEAMS,
    adapters,
    reasoner: opts.reasoner ?? createDeterministicReasoner(),
    decide: opts.decide,
  });
}
