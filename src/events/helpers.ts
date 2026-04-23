/**
 * `createEvent` — build a `DomainEvent` with the mandatory `meta` block.
 *
 * Extends `@classytic/primitives`' {@link OperationContext} as the input
 * shape so streamline consumers can hand over the same context object they
 * use for any other Classytic package. Maps `actorId` → `meta.userId` to
 * keep the EventMeta contract unchanged.
 */

import type { OperationContext } from '@classytic/primitives/context';
import type { DomainEvent, EventMeta } from '@classytic/primitives/events';
import { createEvent as createPrimitiveEvent } from '@classytic/primitives/events';

/**
 * Streamline event context. Extends primitives' {@link OperationContext} so
 * identity/tracing fields stay uniform; adds `resource` + `resourceId` as
 * streamline-specific conveniences that land on the event meta.
 */
export interface EventContext extends OperationContext {
  /** Narrowed from primitives' `IdLike` to string. */
  actorId?: string;
  /** Narrowed from primitives' `IdLike` to string. */
  organizationId?: string;
  /** Event meta convenience — e.g. `'workflow-run'`. */
  resource?: string;
  /** Event meta convenience — e.g. the workflow run id. */
  resourceId?: string;
}

export function createEvent<T>(
  type: string,
  payload: T,
  ctx?: EventContext,
  meta?: Partial<EventMeta>,
): DomainEvent<T> {
  return createPrimitiveEvent<T>(type, payload, {
    ...(ctx?.actorId !== undefined ? { userId: ctx.actorId } : {}),
    ...(ctx?.organizationId !== undefined ? { organizationId: ctx.organizationId } : {}),
    ...(ctx?.correlationId !== undefined ? { correlationId: ctx.correlationId } : {}),
    ...(ctx?.resource !== undefined ? { resource: ctx.resource } : {}),
    ...(ctx?.resourceId !== undefined ? { resourceId: ctx.resourceId } : {}),
    ...meta,
  });
}
