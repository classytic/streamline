/**
 * Scenario tests for the v2.3 internal upgrades:
 *
 *   1. **`defineStateMachine` + `assertAndClaim`** at engine claim sites.
 *      Pre-v2.3 the engine called `repo.claim` directly; illegal
 *      transitions reached Mongo and the CAS quietly returned null
 *      (indistinguishable from race-loss). Now `assertTransition` runs
 *      in-memory first and throws `IllegalTransitionError` for
 *      programmer bugs — easier to debug than null-return.
 *
 *   2. **`cursor()` for stale scanner.** Replaced bounded `findAll` with
 *      streaming `cursor()` so cluster-crash recovery (potentially
 *      thousands of stale runs) doesn't peak memory.
 *
 * Style: Setup → Script → Assert per testing-infrastructure.md §6.
 */

import { describe, expect, it } from 'vitest';
import { IllegalTransitionError } from '@classytic/primitives/state-machine';
import {
  RUN_MACHINE,
  STEP_MACHINE,
  isValidRunTransition,
  isValidStepTransition,
  isTerminalState,
  workflowRunRepository,
  WorkflowRunModel,
} from '../../src/index.js';
import { useTestDb } from '../helpers/lifecycle.js';

describe('RUN_MACHINE — workflow status state machine (replaces dead validators)', () => {
  it('exposes the same transition table the legacy validators encoded', () => {
    // Sanity: the back-compat shims still work and agree with the
    // primitives-backed machine.
    expect(isValidRunTransition('draft', 'running')).toBe(true);
    expect(isValidRunTransition('draft', 'cancelled')).toBe(true);
    expect(isValidRunTransition('draft', 'done')).toBe(false);

    expect(isValidRunTransition('running', 'waiting')).toBe(true);
    expect(isValidRunTransition('running', 'done')).toBe(true);
    expect(isValidRunTransition('running', 'failed')).toBe(true);
    expect(isValidRunTransition('running', 'cancelled')).toBe(true);

    expect(isValidRunTransition('waiting', 'running')).toBe(true);
    expect(isValidRunTransition('waiting', 'cancelled')).toBe(true);
    expect(isValidRunTransition('waiting', 'done')).toBe(false);

    // Rewind: terminal can go back to running
    expect(isValidRunTransition('done', 'running')).toBe(true);
    expect(isValidRunTransition('failed', 'running')).toBe(true);

    // cancelled is fully terminal
    expect(isValidRunTransition('cancelled', 'running')).toBe(false);
    expect(isValidRunTransition('cancelled', 'done')).toBe(false);
  });

  it('isTerminalState (domain) and RUN_MACHINE.isTerminal (structural) intentionally differ', () => {
    // RUN_MACHINE.isTerminal is structural — only states with NO
    // outgoing transitions are terminal. `done` and `failed` allow
    // `→ running` for rewind support, so the machine treats them as
    // non-terminal. Only `cancelled` is structurally terminal.
    expect(RUN_MACHINE.isTerminal('cancelled')).toBe(true);
    expect(RUN_MACHINE.isTerminal('done')).toBe(false); // ← structural says no
    expect(RUN_MACHINE.isTerminal('failed')).toBe(false); // ← structural says no
    expect(RUN_MACHINE.isTerminal('running')).toBe(false);
    expect(RUN_MACHINE.isTerminal('waiting')).toBe(false);
    expect(RUN_MACHINE.isTerminal('draft')).toBe(false);

    // isTerminalState is the DOMAIN semantic — done/failed/cancelled
    // are all "complete" from the engine's perspective (execution loop
    // stops, scheduler ignores). Both checks coexist by design.
    expect(isTerminalState('cancelled')).toBe(true);
    expect(isTerminalState('done')).toBe(true);
    expect(isTerminalState('failed')).toBe(true);
    expect(isTerminalState('running')).toBe(false);
    expect(isTerminalState('waiting')).toBe(false);
    expect(isTerminalState('draft')).toBe(false);
  });

  it('assertTransition throws IllegalTransitionError with structured fields', () => {
    try {
      RUN_MACHINE.assertTransition('run-1', 'cancelled', 'running');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      const e = err as IllegalTransitionError;
      expect(e.entityType).toBe('WorkflowRun');
      expect(e.entityId).toBe('run-1');
      expect(e.from).toBe('cancelled');
      expect(e.to).toBe('running');
      expect(e.code).toBe('illegal_transition');
      expect(e.status).toBe(422);
    }
  });

  it('validSources(to) returns every legal predecessor', () => {
    // Every status that can transition INTO 'cancelled':
    //   draft → cancelled    ✓
    //   running → cancelled  ✓
    //   waiting → cancelled  ✓
    //   done → cancelled     ✗ (not in the table)
    //   failed → cancelled   ✗
    const sources = RUN_MACHINE.validSources('cancelled');
    expect(sources).toEqual(expect.arrayContaining(['draft', 'running', 'waiting']));
    expect(sources).not.toContain('done');
    expect(sources).not.toContain('failed');
    expect(sources).not.toContain('cancelled');
  });
});

describe('STEP_MACHINE — step status state machine', () => {
  it('rejects illegal step transitions', () => {
    expect(() => STEP_MACHINE.assertTransition('s', 'done', 'failed')).toThrow(
      IllegalTransitionError,
    );
    expect(() => STEP_MACHINE.assertTransition('s', 'skipped', 'pending')).toThrow(
      IllegalTransitionError,
    );
  });

  it('allows pending → running, running → done|failed|waiting|pending, waiting → pending|done|failed', () => {
    expect(isValidStepTransition('pending', 'running')).toBe(true);
    expect(isValidStepTransition('pending', 'skipped')).toBe(true);
    expect(isValidStepTransition('running', 'done')).toBe(true);
    expect(isValidStepTransition('running', 'failed')).toBe(true);
    expect(isValidStepTransition('running', 'waiting')).toBe(true);
    expect(isValidStepTransition('running', 'pending')).toBe(true); // retry path
    expect(isValidStepTransition('waiting', 'pending')).toBe(true);
    expect(isValidStepTransition('done', 'pending')).toBe(true); // rewind
  });
});

describe('cursor()-based stale scanner — streaming reads', () => {
  useTestDb();

  it('cursorStaleRunning yields stale runs one at a time and respects consumer break', async () => {
    // Setup: seed 5 stale running workflows + 3 fresh ones.
    const now = Date.now();
    const staleHeartbeat = new Date(now - 60_000); // 60s old
    const freshHeartbeat = new Date(now - 1_000); //  1s old

    for (let i = 0; i < 5; i++) {
      await WorkflowRunModel.create({
        _id: `stale-${i}`,
        workflowId: 'stale-test',
        status: 'running',
        steps: [],
        context: {},
        createdAt: new Date(now - 120_000),
        updatedAt: staleHeartbeat,
        lastHeartbeat: staleHeartbeat,
      });
    }
    for (let i = 0; i < 3; i++) {
      await WorkflowRunModel.create({
        _id: `fresh-${i}`,
        workflowId: 'stale-test',
        status: 'running',
        steps: [],
        context: {},
        createdAt: new Date(now - 5_000),
        updatedAt: freshHeartbeat,
        lastHeartbeat: freshHeartbeat,
      });
    }

    // Script: cursor through stale runs, breaking at 3.
    const seen: string[] = [];
    for await (const run of workflowRunRepository.cursorStaleRunning(30_000, {
      bypassTenant: true,
    })) {
      seen.push(run._id);
      if (seen.length >= 3) break;
    }

    // Assert: exactly 3 yielded; all are stale (not fresh); all distinct.
    expect(seen).toHaveLength(3);
    for (const id of seen) {
      expect(id.startsWith('stale-')).toBe(true);
    }
    expect(new Set(seen).size).toBe(3);
  });

  it('cursorStaleRunning yields all stale runs when not bounded by break', async () => {
    const now = Date.now();
    const staleHeartbeat = new Date(now - 60_000);
    for (let i = 0; i < 4; i++) {
      await WorkflowRunModel.create({
        _id: `stale-all-${i}`,
        workflowId: 'stale-all-test',
        status: 'running',
        steps: [],
        context: {},
        createdAt: new Date(now - 120_000),
        updatedAt: staleHeartbeat,
        lastHeartbeat: staleHeartbeat,
      });
    }

    const seen: string[] = [];
    for await (const run of workflowRunRepository.cursorStaleRunning(30_000, {
      bypassTenant: true,
    })) {
      seen.push(run._id);
    }

    expect(seen).toHaveLength(4);
  });

  it('cursorStaleRunning excludes paused runs (notPaused() in the query)', async () => {
    const now = Date.now();
    const staleHeartbeat = new Date(now - 60_000);

    await WorkflowRunModel.create({
      _id: 'stale-active',
      workflowId: 'paused-test',
      status: 'running',
      steps: [],
      context: {},
      createdAt: new Date(now - 120_000),
      updatedAt: staleHeartbeat,
      lastHeartbeat: staleHeartbeat,
      paused: false,
    });
    await WorkflowRunModel.create({
      _id: 'stale-paused',
      workflowId: 'paused-test',
      status: 'running',
      steps: [],
      context: {},
      createdAt: new Date(now - 120_000),
      updatedAt: staleHeartbeat,
      lastHeartbeat: staleHeartbeat,
      paused: true,
    });

    const seen: string[] = [];
    for await (const run of workflowRunRepository.cursorStaleRunning(30_000, {
      bypassTenant: true,
    })) {
      seen.push(run._id);
    }

    expect(seen).toEqual(['stale-active']);
  });
});
