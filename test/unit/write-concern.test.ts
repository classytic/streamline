/**
 * Write-concern tripwire — durability regression guard.
 *
 * `WorkflowRunModel` and the strict-concurrency counter both pin
 * `writeConcern: { w: 'majority', j: true }` at the Mongoose SCHEMA level.
 * Every mongokit `Repository` write bottoms out at `Model.findOneAndUpdate`,
 * which inherits the schema-level concern — mongokit itself has NO per-call
 * writeConcern knob (confirmed against `@classytic/mongokit` Repository).
 *
 * If anyone ever moves the concern off the schema expecting mongokit to carry
 * it per-call, acknowledged writes can silently vanish on a primary failover.
 * This test is the tripwire that catches that regression at unit speed (no DB
 * connection required — schema options are populated at model-registration
 * time).
 */

import type mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { WorkflowConcurrencyCounterModel } from '../../src/storage/concurrency-counter.model.js';
import { WorkflowRunModel } from '../../src/storage/run.model.js';

/**
 * Assert a model's schema carries the majority/journaled write concern.
 * Internal helper — the durability guard the design calls for.
 */
function assertWriteConcern(model: mongoose.Model<unknown>): void {
  const wc = model.schema.options.writeConcern;
  expect(wc, `${model.modelName} must declare a schema-level writeConcern`).toBeDefined();
  expect(wc?.w, `${model.modelName} writeConcern.w must be 'majority'`).toBe('majority');
  expect(wc?.j, `${model.modelName} writeConcern.j must be true`).toBe(true);
}

describe('schema-level write concern (durability tripwire)', () => {
  it('WorkflowRunModel pins { w: majority, j: true }', () => {
    assertWriteConcern(WorkflowRunModel as unknown as mongoose.Model<unknown>);
  });

  it('WorkflowConcurrencyCounterModel pins { w: majority, j: true }', () => {
    assertWriteConcern(WorkflowConcurrencyCounterModel as unknown as mongoose.Model<unknown>);
  });
});
