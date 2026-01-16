/**
 * 🚀 Durable Workflow Engine v3
 * 
 * Inspired by Vercel Workflow's "use workflow" / "use step" simplicity
 * Designed for MongoDB with in-memory + DB sync
 * 
 * KEY PRINCIPLES:
 * 1. Define steps as simple async functions
 * 2. Engine handles persistence, resume, retry automatically  
 * 3. Any step can wait (human input, webhook, timer)
 * 4. Rewind to any step to regenerate from that point
 * 5. Clean state machine - easy to visualize in UI
 */

// ============================================================================
// CORE TYPES - Keep it simple
// ============================================================================

export type StepStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'skipped';
export type RunStatus = 'draft' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';

/**
 * Step - Minimal definition
 * Just an id, name, and optional config
 */
export interface Step {
  id: string;
  name: string;
  description?: string;
  
  // Optional config
  retries?: number;
  timeout?: number; // ms
  
  // Can this step wait for external input?
  canWait?: boolean;
}

/**
 * StepState - Runtime state of a step in a run
 * This is what gets persisted to MongoDB
 */
export interface StepState<TOutput = unknown> {
  stepId: string;
  status: StepStatus;
  
  // Execution tracking
  attempts: number;
  startedAt?: Date;
  endedAt?: Date;
  
  // Data - persisted for resume
  output?: TOutput;
  
  // Waiting state
  waitingFor?: {
    type: 'human' | 'webhook' | 'timer' | 'event';
    reason: string;
    expiresAt?: Date;
    data?: unknown; // UI can use this to render waiting state
  };
  
  // Error tracking
  error?: {
    message: string;
    code?: string;
    retriable: boolean;
  };
  
  // Metadata
  meta?: Record<string, unknown>;
}

/**
 * WorkflowRun - Single execution instance
 * MongoDB Document structure
 */
export interface WorkflowRun<TContext = Record<string, unknown>> {
  // Identity
  _id: string; // MongoDB ObjectId as string, or custom ID
  workflowId: string;
  
  // Status
  status: RunStatus;
  
  // Steps - array preserves order, easy to visualize
  steps: StepState[];
  currentStepId: string | null;
  
  // Shared context - accumulated data across steps
  context: TContext;
  
  // Input/Output
  input: unknown;
  output?: unknown;
  
  // Timing
  createdAt: Date;
  startedAt?: Date;
  updatedAt: Date;
  endedAt?: Date;
  
  // Ownership
  userId?: string;
  
  // For filtering/querying
  tags?: string[];
  
  // Arbitrary metadata
  meta?: Record<string, unknown>;
}

// ============================================================================
// WORKFLOW DEFINITION - The Blueprint
// ============================================================================

/**
 * WorkflowDefinition - Template for creating runs
 */
export interface WorkflowDefinition<TContext = Record<string, unknown>> {
  id: string;
  name: string;
  version: string;
  description?: string;
  
  // Ordered steps
  steps: Step[];
  
  // Default context factory
  createContext: (input: unknown) => TContext;
  
  // Global defaults
  defaults?: {
    retries?: number;
    timeout?: number;
  };
}

// ============================================================================
// STEP EXECUTION CONTEXT - What step handlers receive
// ============================================================================

/**
 * StepContext - Clean API for step execution
 * Inspired by Vercel Workflow's simplicity
 */
export interface StepContext<TContext> {
  // Data access
  context: TContext;
  input: unknown;
  attempt: number;
  
  // Update shared context (persisted immediately)
  set: <K extends keyof TContext>(key: K, value: TContext[K]) => void;
  
  // Get output from a previous step
  getOutput: <T = unknown>(stepId: string) => T | undefined;
  
  // Wait for external input (suspends execution)
  wait: (reason: string, data?: unknown) => Promise<never>;
  
  // Sleep (resumes automatically)
  sleep: (ms: number) => Promise<void>;
  
  // Logging (stored with step)
  log: (message: string, data?: unknown) => void;
}

/**
 * StepHandler - The function that executes a step
 */
export type StepHandler<TOutput = unknown, TContext = Record<string, unknown>> = (
  ctx: StepContext<TContext>
) => Promise<TOutput>;

// ============================================================================
// IN-MEMORY STORE WITH DB SYNC
// ============================================================================

/**
 * WorkflowStore - In-memory cache with MongoDB sync
 * 
 * Design:
 * - Reads: Memory-first, fallback to DB
 * - Writes: Memory immediately, DB async (configurable)
 * - Supports offline operation with later sync
 */
export interface WorkflowStore<TContext = Record<string, unknown>> {
  // CRUD
  get: (runId: string) => Promise<WorkflowRun<TContext> | null>;
  save: (run: WorkflowRun<TContext>) => Promise<void>;
  delete: (runId: string) => Promise<void>;
  
  // Queries
  list: (filter?: RunFilter) => Promise<WorkflowRun<TContext>[]>;
  
  // Sync control
  sync: () => Promise<void>; // Force sync to DB
  hydrate: () => Promise<void>; // Load from DB to memory
}

export interface RunFilter {
  workflowId?: string;
  status?: RunStatus | RunStatus[];
  userId?: string;
  tags?: string[];
  createdAfter?: Date;
  createdBefore?: Date;
  limit?: number;
}

// ============================================================================
// WORKFLOW ENGINE - Simple API
// ============================================================================

/**
 * WorkflowEngine - Main API
 * 
 * Usage:
 *   const engine = createEngine(store, definition, handlers);
 *   const run = await engine.start(input);
 *   await engine.execute(run._id); // Run all steps
 *   await engine.resume(run._id, payload); // Resume waiting step
 *   await engine.rewindTo(run._id, 'step-2'); // Go back and re-run
 */
export interface WorkflowEngine<TContext = Record<string, unknown>> {
  // Create new run
  start: (input: unknown, meta?: Record<string, unknown>) => Promise<WorkflowRun<TContext>>;
  
  // Get run state
  get: (runId: string) => Promise<WorkflowRun<TContext> | null>;
  
  // Execute next step (or all remaining)
  execute: (runId: string, options?: { all?: boolean }) => Promise<WorkflowRun<TContext>>;
  
  // Resume a waiting step
  resume: (runId: string, payload: unknown) => Promise<WorkflowRun<TContext>>;
  
  // Rewind to a specific step (re-execute from there)
  rewindTo: (runId: string, stepId: string) => Promise<WorkflowRun<TContext>>;
  
  // Control
  pause: (runId: string) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
  retry: (runId: string) => Promise<WorkflowRun<TContext>>;
  
  // Queries
  list: (filter?: RunFilter) => Promise<WorkflowRun<TContext>[]>;
}

// ============================================================================
// MONGODB SCHEMA - Clean, indexed
// ============================================================================

/**
 * MongoDB Collection: workflow_runs
 * 
 * Indexes:
 * - { _id: 1 } // automatic
 * - { workflowId: 1, status: 1 }
 * - { userId: 1, createdAt: -1 }
 * - { status: 1, updatedAt: -1 }
 * - { tags: 1 }
 * - { "steps.stepId": 1 } // for querying by step
 * 
 * TTL Index (optional):
 * - { endedAt: 1 }, expireAfterSeconds: 7776000 // 90 days
 */

// ============================================================================
// LINKEDIN WORKFLOW - CONCRETE IMPLEMENTATION
// ============================================================================

/**
 * LinkedIn Engagement Context
 */
export interface LinkedInContext {
  // Input
  url: string;
  linkType: 'linkedin' | 'twitter' | 'other';
  
  // Agents (selected before scraping)
  agents: Array<{
    id: string;
    name: string;
    systemPrompt: string;
    enabled: boolean;
  }>;
  
  // Step outputs (accumulated)
  scrapedPost?: {
    id: string;
    author: { name: string; headline: string; profileUrl: string };
    content: string;
    reactionCount: number;
    commentCount: number;
    timestamp: string;
    images?: string[];
  };
  
  scrapedComments?: Array<{
    id: string;
    author: { name: string; headline: string; profileUrl: string };
    content: string;
    reactionCount: number;
  }>;
  
  analysis?: {
    relevance: 'high' | 'medium' | 'low' | 'none';
    score: number;
    replies: Array<{
      commentId: string;
      agentId: string;
      reply: string;
      confidence: number;
      status: 'pending' | 'confirmed' | 'rejected';
    }>;
  };
  
  postedReplies?: Array<{
    commentId: string;
    replyId: string;
    success: boolean;
    postedAt: Date;
    error?: string;
  }>;
}

/**
 * LinkedIn Workflow Steps
 */
export const LINKEDIN_STEPS: Step[] = [
  {
    id: 'input',
    name: 'Enter URL & Select Agents',
    description: 'Provide the post URL and configure agents',
    canWait: true, // Waits for user input
  },
  {
    id: 'scraping',
    name: 'Scrape Post',
    description: 'Extract post content and comments from LinkedIn',
    retries: 3,
    timeout: 30000,
  },
  {
    id: 'analyzing',
    name: 'Analyze Content',
    description: 'AI analysis using selected agents',
    timeout: 60000,
  },
  {
    id: 'review',
    name: 'Review Replies',
    description: 'Approve or reject suggested replies',
    canWait: true, // Waits for human review
  },
  {
    id: 'posting',
    name: 'Post Replies',
    description: 'Post approved replies to LinkedIn',
    retries: 2,
  },
];

export const LINKEDIN_WORKFLOW: WorkflowDefinition<LinkedInContext> = {
  id: 'linkedin-engagement',
  name: 'LinkedIn Engagement',
  version: '3.0.0',
  description: 'Scrape, analyze, and engage with LinkedIn posts',
  steps: LINKEDIN_STEPS,
  createContext: (input: unknown) => {
    const { url, linkType, agents } = input as { 
      url: string; 
      linkType: string;
      agents: LinkedInContext['agents'];
    };
    return {
      url,
      linkType: linkType as LinkedInContext['linkType'],
      agents: agents || [],
    };
  },
  defaults: {
    retries: 2,
    timeout: 30000,
  },
};

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

let runIdCounter = 0;

export const generateRunId = (): string => {
  runIdCounter++;
  return `run_${Date.now()}_${runIdCounter.toString().padStart(4, '0')}`;
};

/**
 * Create a new workflow run
 */
export const createRun = <TContext>(
  workflow: WorkflowDefinition<TContext>,
  input: unknown,
  userId?: string
): WorkflowRun<TContext> => {
  const now = new Date();
  
  // Initialize all steps as pending
  const steps: StepState[] = workflow.steps.map((step) => ({
    stepId: step.id,
    status: 'pending' as StepStatus,
    attempts: 0,
  }));
  
  return {
    _id: generateRunId(),
    workflowId: workflow.id,
    status: 'draft',
    steps,
    currentStepId: null,
    context: workflow.createContext(input),
    input,
    createdAt: now,
    updatedAt: now,
    userId,
    tags: [],
    meta: {},
  };
};

/**
 * Get step state from run
 */
export const getStepState = <TContext = unknown>(
  run: WorkflowRun<TContext>,
  stepId: string
): StepState | undefined => {
  return run.steps.find((s) => s.stepId === stepId);
};

/**
 * Update step state immutably
 */
export const updateStepState = <TContext>(
  run: WorkflowRun<TContext>,
  stepId: string,
  updates: Partial<StepState>
): WorkflowRun<TContext> => {
  return {
    ...run,
    updatedAt: new Date(),
    steps: run.steps.map((s) =>
      s.stepId === stepId ? { ...s, ...updates } : s
    ),
  };
};

// ============================================================================
// STATUS HELPERS
// ============================================================================

export const isStepComplete = (status: StepStatus): boolean =>
  status === 'done' || status === 'skipped';

export const isStepActive = (status: StepStatus): boolean =>
  status === 'running' || status === 'waiting';

export const isRunComplete = (status: RunStatus): boolean =>
  status === 'done' || status === 'failed' || status === 'cancelled';

/**
 * Derive run status from step states
 */
export const deriveRunStatus = (steps: StepState[]): RunStatus => {
  if (steps.length === 0) return 'draft';
  
  const hasRunning = steps.some((s) => s.status === 'running');
  const hasWaiting = steps.some((s) => s.status === 'waiting');
  const hasFailed = steps.some((s) => s.status === 'failed');
  const allDone = steps.every((s) => isStepComplete(s.status));
  
  if (hasFailed) return 'failed';
  if (hasWaiting) return 'waiting';
  if (hasRunning) return 'running';
  if (allDone) return 'done';
  
  // Some pending, some done = running
  const hasPending = steps.some((s) => s.status === 'pending');
  const hasDone = steps.some((s) => isStepComplete(s.status));
  if (hasPending && hasDone) return 'running';
  
  return 'draft';
};

// ============================================================================
// STEP NAVIGATION
// ============================================================================

export const getStepIndex = <TContext = unknown>(
  workflow: WorkflowDefinition<TContext>,
  stepId: string
): number => {
  return workflow.steps.findIndex((s) => s.id === stepId);
};

export const getNextStep = <TContext = unknown>(
  workflow: WorkflowDefinition<TContext>,
  currentStepId: string
): Step | null => {
  const idx = getStepIndex(workflow, currentStepId);
  if (idx === -1 || idx >= workflow.steps.length - 1) return null;
  return workflow.steps[idx + 1];
};

export const getPrevStep = <TContext = unknown>(
  workflow: WorkflowDefinition<TContext>,
  currentStepId: string
): Step | null => {
  const idx = getStepIndex(workflow, currentStepId);
  if (idx <= 0) return null;
  return workflow.steps[idx - 1];
};

export const canRewindTo = <TContext = unknown>(
  workflow: WorkflowDefinition<TContext>,
  fromStepId: string,
  toStepId: string
): boolean => {
  const fromIdx = getStepIndex(workflow, fromStepId);
  const toIdx = getStepIndex(workflow, toStepId);
  return toIdx >= 0 && toIdx < fromIdx;
};

/**
 * Rewind a run to a specific step
 * Resets all steps from that point forward to 'pending'
 */
export const rewindRun = <TContext>(
  run: WorkflowRun<TContext>,
  workflow: WorkflowDefinition<TContext>,
  toStepId: string
): WorkflowRun<TContext> => {
  const targetIdx = getStepIndex(workflow, toStepId);
  if (targetIdx === -1) return run;
  
  const updatedSteps = run.steps.map((s, i) => {
    // Keep completed steps before target
    if (i < targetIdx) return s;
    
    // Reset target and all after
    return {
      stepId: s.stepId,
      status: 'pending' as StepStatus,
      attempts: 0,
    };
  });
  
  return {
    ...run,
    status: 'running',
    steps: updatedSteps,
    currentStepId: toStepId,
    updatedAt: new Date(),
    endedAt: undefined,
    output: undefined,
  };
};

// ============================================================================
// UI HELPERS - For visualization
// ============================================================================

export interface StepUIState {
  id: string;
  name: string;
  description?: string;
  status: StepStatus;
  isCurrentStep: boolean;
  isPastStep: boolean;
  isFutureStep: boolean;
  canRewindTo: boolean;
  attempts: number;
  waitingFor?: StepState['waitingFor'];
  error?: StepState['error'];
  output?: unknown;
}

/**
 * Get UI-friendly step states for rendering
 */
export const getStepUIStates = <TContext>(
  run: WorkflowRun<TContext>,
  workflow: WorkflowDefinition<TContext>
): StepUIState[] => {
  const currentIdx = run.currentStepId
    ? getStepIndex(workflow, run.currentStepId)
    : -1;
  
  return workflow.steps.map((step, idx) => {
    const state = getStepState(run, step.id);
    const isCurrent = run.currentStepId === step.id;
    const isPast = currentIdx >= 0 && idx < currentIdx;
    const isFuture = currentIdx >= 0 && idx > currentIdx;
    
    return {
      id: step.id,
      name: step.name,
      description: step.description,
      status: state?.status || 'pending',
      isCurrentStep: isCurrent,
      isPastStep: isPast,
      isFutureStep: isFuture,
      canRewindTo: isPast && (state?.status === 'done' || state?.status === 'skipped'),
      attempts: state?.attempts || 0,
      waitingFor: state?.waitingFor,
      error: state?.error,
      output: state?.output,
    };
  });
};

// ============================================================================
// SIMPLE IN-MEMORY STORE (for frontend use)
// ============================================================================

/**
 * Create a simple in-memory store
 * Can be extended to sync with MongoDB
 */
export const createMemoryStore = <TContext>(): WorkflowStore<TContext> => {
  const runs = new Map<string, WorkflowRun<TContext>>();
  
  return {
    get: async (runId) => runs.get(runId) || null,
    save: async (run) => {
      runs.set(run._id, { ...run, updatedAt: new Date() });
    },
    delete: async (runId) => {
      runs.delete(runId);
    },
    list: async (filter) => {
      let results = Array.from(runs.values());
      
      if (filter?.workflowId) {
        results = results.filter((r) => r.workflowId === filter.workflowId);
      }
      if (filter?.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        results = results.filter((r) => statuses.includes(r.status));
      }
      if (filter?.userId) {
        results = results.filter((r) => r.userId === filter.userId);
      }
      if (filter?.limit) {
        results = results.slice(0, filter.limit);
      }
      
      return results.sort((a, b) => 
        b.createdAt.getTime() - a.createdAt.getTime()
      );
    },
    sync: async () => {
      // No-op for memory store
      // MongoDB implementation would sync here
    },
    hydrate: async () => {
      // No-op for memory store
      // MongoDB implementation would load from DB here
    },
  };
};
