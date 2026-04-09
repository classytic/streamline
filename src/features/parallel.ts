/**
 * Parallel Execution Utilities
 *
 * Provides utilities for executing multiple async operations in parallel
 * with support for different modes, concurrency limits, and timeouts.
 *
 * @example
 * ```typescript
 * // Execute all tasks in parallel
 * const results = await executeParallel([
 *   () => fetchUser(1),
 *   () => fetchUser(2),
 *   () => fetchUser(3),
 * ]);
 *
 * // With concurrency limit
 * const results = await executeParallel(tasks, { concurrency: 2 });
 *
 * // With allSettled mode (never throws)
 * const results = await executeParallel(tasks, { mode: 'allSettled' });
 * ```
 */

export interface ExecuteParallelOptions {
  /**
   * Execution mode:
   * - 'all': Wait for all tasks to complete (throws if any fails)
   * - 'race': Complete when first task completes
   * - 'any': Complete when first task succeeds
   * - 'allSettled': Wait for all tasks, return success/failure for each
   *
   * @default 'all'
   */
  mode?: 'all' | 'race' | 'any' | 'allSettled';
  /**
   * Maximum number of tasks to run concurrently
   * @default Infinity
   */
  concurrency?: number;
  /**
   * Maximum time in milliseconds for each task
   * @default undefined (no timeout)
   */
  timeout?: number;
}

async function executeWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  const errors: Array<{ index: number; error: unknown }> = [];
  const executing: Set<Promise<void>> = new Set();

  for (let i = 0; i < tasks.length; i++) {
    const index = i;
    const promise = tasks[index]()
      .then((result) => {
        results[index] = result; // Preserve order
      })
      .catch((error: unknown) => {
        // Capture errors instead of letting them become unhandled rejections
        errors.push({ index, error });
      })
      .finally(() => {
        executing.delete(promise);
      });

    executing.add(promise);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);

  // Re-throw the first error if any task failed
  if (errors.length > 0) {
    // Sort by index to throw the earliest error first (consistent behavior)
    errors.sort((a, b) => a.index - b.index);
    throw errors[0].error;
  }

  return results;
}

async function executeWithConcurrencySettled<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<Array<{ success: boolean; value?: T; reason?: unknown }>> {
  const results: Array<{ success: boolean; value?: T; reason?: unknown }> = new Array(tasks.length);
  const executing: Set<Promise<void>> = new Set();

  for (let i = 0; i < tasks.length; i++) {
    const index = i;
    const promise = tasks[index]()
      .then((value) => {
        results[index] = { success: true, value }; // Preserve order
      })
      .catch((reason: unknown) => {
        results[index] = { success: false, reason }; // Preserve order
      })
      .finally(() => {
        executing.delete(promise);
      });

    executing.add(promise);

    if (executing.size >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

/**
 * Execute multiple async tasks in parallel with configurable mode,
 * concurrency limits, and timeouts.
 *
 * @param tasks - Array of async task functions to execute
 * @param options - Execution options (mode, concurrency, timeout)
 * @returns Array of results (exact type depends on mode)
 *
 * @example Basic parallel execution
 * ```typescript
 * const results = await executeParallel([
 *   () => fetch('/api/users'),
 *   () => fetch('/api/posts'),
 *   () => fetch('/api/comments'),
 * ]);
 * ```
 *
 * @example With concurrency limit
 * ```typescript
 * // Only 2 requests at a time
 * const results = await executeParallel(urlTasks, { concurrency: 2 });
 * ```
 *
 * @example With allSettled mode (never throws)
 * ```typescript
 * const results = await executeParallel(tasks, { mode: 'allSettled' });
 * for (const result of results) {
 *   if (result.success) {
 *     console.log('Success:', result.value);
 *   } else {
 *     console.log('Failed:', result.reason);
 *   }
 * }
 * ```
 */
export async function executeParallel<T>(
  tasks: Array<() => Promise<T>>,
  options: ExecuteParallelOptions = {},
): Promise<T[] | Array<{ success: boolean; value?: T; reason?: unknown }>> {
  const { mode = 'all', concurrency = Infinity, timeout } = options;

  // Wrap tasks with timeout if specified
  const wrappedTasks = timeout
    ? tasks.map(
        (task) => () =>
          Promise.race([
            task(),
            new Promise<T>((_, reject) =>
              setTimeout(() => reject(new Error(`Task timeout after ${timeout}ms`)), timeout),
            ),
          ]),
      )
    : tasks;

  // Validate mode + concurrency combination
  // Race and any modes with concurrency limiting don't make semantic sense:
  // - race: Returns first to complete, but concurrency limits which tasks even start
  // - any: Returns first success, but concurrency limits which tasks even start
  // This would lead to confusing behavior where the "winner" depends on concurrency slot availability
  if (concurrency !== Infinity && (mode === 'race' || mode === 'any')) {
    throw new Error(
      `executeParallel: mode '${mode}' cannot be combined with concurrency limiting. ` +
        `The '${mode}' mode requires all tasks to start simultaneously to determine the winner. ` +
        `Either remove the concurrency limit or use mode 'all' or 'allSettled'.`,
    );
  }

  // Apply concurrency limiting if specified
  if (concurrency !== Infinity) {
    switch (mode) {
      case 'allSettled':
        return executeWithConcurrencySettled(wrappedTasks, concurrency);
      default:
        return executeWithConcurrency(wrappedTasks, concurrency);
    }
  }

  // No concurrency limiting - use native Promise methods
  switch (mode) {
    case 'all':
      return Promise.all(wrappedTasks.map((t) => t()));
    case 'race':
      return [await Promise.race(wrappedTasks.map((t) => t()))];
    case 'any':
      return Promise.any(wrappedTasks.map((t) => t())).then((result) => [result]);
    case 'allSettled': {
      const settled = await Promise.allSettled(wrappedTasks.map((t) => t()));
      return settled.map((result) =>
        result.status === 'fulfilled'
          ? { success: true, value: result.value }
          : { success: false, reason: result.reason },
      );
    }
    default:
      return Promise.all(wrappedTasks.map((t) => t()));
  }
}
