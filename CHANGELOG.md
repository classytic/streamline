# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-01-13

### 🎉 Initial Release - MongoDB-Native Workflow Engine

#### Core Features
- ✅ **Durable workflow execution** - Sequential step execution with state persistence
- ✅ **Wait/Resume** - Human-in-the-loop workflows with `ctx.wait()`
- ✅ **Sleep/Timers** - Time-based pausing with `ctx.sleep(ms)`
- ✅ **Parallel execution** - `Promise.all`, `Promise.race`, `Promise.any` modes
- ✅ **Conditional steps** - Skip steps based on context predicates
- ✅ **Retry logic** - Exponential backoff with configurable max retries
- ✅ **Step timeouts** - Per-step timeout configuration
- ✅ **Error handling** - Graceful failure handling with retry

#### Storage & Persistence
- ✅ **MongoDB persistence** - Native MongoDB storage via Mongoose
- ✅ **MongoKit integration** - Repository pattern with plugins
- ✅ **Cache-first architecture** - In-memory cache for active workflows
- ✅ **Atomic state updates** - Transactional updates for consistency

#### Developer Experience
- ✅ **Fluent builder API** - `defineWorkflow().step().build()`
- ✅ **TypeScript-first** - Full type safety and IntelliSense
- ✅ **Step context** - Rich context API with `set()`, `getOutput()`, `wait()`, `sleep()`
- ✅ **Event system** - Event-driven architecture for monitoring

#### Advanced Features
- ✅ **Concurrency control** - CPU-aware throttling with queue management
- ✅ **Memory management** - Automatic garbage collection and cache eviction
- ✅ **Workflow rewind** - Rewind to any step and re-execute
- ✅ **Auto-execute** - Workflows execute automatically after `start()`
- ✅ **Fastify integration** - Optional Fastify plugin

#### Documentation
- ✅ **Comprehensive README** - Multi-tenant indexing, cleanup strategies, UI integration examples
- ✅ **Example workflows** - 7 complete examples (hello-world, wait, sleep, parallel, conditional, newsletter, AI pipeline)
- ✅ **Testing guide** - Full testing documentation with examples
- ✅ **Vercel comparison** - Architectural analysis vs Vercel Workflow
- ✅ **Temporal comparison** - Honest comparison with Temporal.io
- ✅ **Enterprise readiness** - Assessment for enterprise applications

