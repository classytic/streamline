import { WorkflowEngine } from '../execution/engine.js';
import { createContainer } from '../core/container.js';
import type { WorkflowDefinition, WorkflowHandlers } from '../core/types.js';

interface WorkflowPluginOptions {
  workflows: Array<{
    definition: WorkflowDefinition;
    handlers: WorkflowHandlers;
  }>;
}

async function workflowPlugin(fastify: unknown, options: WorkflowPluginOptions): Promise<void> {
  const engines = new Map<string, WorkflowEngine>();
  const fastifyInstance = fastify as {
    decorate: (name: string, value: unknown) => void;
    addHook: (event: string, handler: () => Promise<void>) => void;
  };

  for (const { definition, handlers } of options.workflows) {
    const container = createContainer();
    const engine = new WorkflowEngine(definition, handlers, container);
    engines.set(definition.id, engine);
  }

  fastifyInstance.decorate('workflows', engines);

  fastifyInstance.decorate('getWorkflow', (id: string) => {
    const engine = engines.get(id);
    if (!engine) throw new Error(`Workflow ${id} not found`);
    return engine;
  });

  fastifyInstance.addHook('onClose', async () => {
    for (const engine of engines.values()) {
      engine.shutdown();
    }
  });
}

export default workflowPlugin;
