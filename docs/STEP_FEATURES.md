# Step Features Reference

Quick reference for all supported step control flow features.

---

## ✅ Built-In Features

### 1. **Retry Logic**

Automatic retry with exponential backoff.

```typescript
import { createWorkflow } from '@classytic/streamline';

const workflow = createWorkflow<{ url: string }>('api-call', {
  steps: {
    callApi: {
      handler: async (ctx) => {
        try {
          return await externalAPI.call(ctx.context.url);
        } catch (err) {
          if (err.code === 503) {
            err.retriable = true;  // Transient - retry
            throw err;
          }
          err.retriable = false;   // Permanent - don't retry
          throw err;
        }
      },
      retries: 3,    // Retry up to 3 times
      timeout: 5000, // 5 second timeout per attempt
    },
  },
  context: (input) => ({ url: input.url }),
});
```

### 2. **Timeout**

Step-level timeout protection.

```typescript
const workflow = createWorkflow<{ id: string }>('with-timeout', {
  steps: {
    slowApi: {
      handler: async (ctx) => { /* long operation */ },
      timeout: 10000,  // Fail if step takes > 10 seconds
    },
  },
  context: (input) => ({ id: input.id }),
});
```

### 3. **Sleep (Durable Timers)**

Pause workflow for any duration (seconds to years).

```typescript
const workflow = createWorkflow<{}>('delayed', {
  steps: {
    waitPayment: async (ctx) => {
      await ctx.sleep(24 * 60 * 60 * 1000); // Sleep 24 hours
      return { resumed: true };
    },
  },
  context: () => ({}),
});

// Works for LONG delays (bypasses setTimeout 24.8 day limit)
await ctx.sleep(365 * 24 * 60 * 60 * 1000); // Sleep 1 year
```

### 4. **Wait (Human-in-the-Loop)**

Pause workflow for external input.

```typescript
import { createWorkflow, resumeHook, createHook } from '@classytic/streamline';

const approval = createWorkflow<{ requestId: string; amount: number }>('approval', {
  steps: {
    requestApproval: async (ctx) => {
      const hook = createHook(ctx, 'pending-approval');
      // Send hook.path to approver via email/slack
      // IMPORTANT: Include hookToken for secure resume validation
      return ctx.wait('Approval required', {
        amount: ctx.context.amount,
        hookToken: hook.token  // Validates token on resume
      });
    },
  },
  context: (input) => ({ requestId: input.requestId, amount: input.amount }),
});

// Resume via hook token (from email link, webhook, etc.)
const { run } = await resumeHook(token, { approved: true, approvedBy: 'manager@company.com' });
```

---

## 🔀 Advanced Features (src/features/)

### 5. **Conditional Steps**

Skip steps based on context values.

```typescript
import { createWorkflow, conditions } from '@classytic/streamline';

interface OrderContext { emailEnabled: boolean; amount: number; email: string }

const workflow = createWorkflow<OrderContext>('order', {
  steps: {
    sendEmail: {
      handler: async (ctx) => {
        await sendEmail(ctx.context.email);
        return { sent: true };
      },
      condition: conditions.equals('emailEnabled', true),
    },
    highValueCheck: {
      handler: async (ctx) => {
        return { requiresApproval: true };
      },
      condition: conditions.greaterThan('amount', 10000),
    },
  },
  context: (input) => ({
    emailEnabled: input.emailEnabled,
    amount: input.amount,
    email: input.email,
  }),
});
```

**Built-in conditions:**
```typescript
// Comparison
conditions.hasValue(key)                    // Check if key exists and is not null/undefined
conditions.equals(key, value)               // Check if key === value
conditions.notEquals(key, value)            // Check if key !== value
conditions.greaterThan(key, value)          // Check if key > value (numeric)
conditions.lessThan(key, value)             // Check if key < value (numeric)
conditions.in(key, values)                  // Check if key is in array

// Logical operators
conditions.and(...predicates)               // All predicates must be true
conditions.or(...predicates)                // At least one predicate must be true
conditions.not(predicate)                   // Negate predicate

// Custom logic
conditions.custom((ctx) => boolean)         // Custom predicate function
```

### 6. **Parallel Execution**

Execute multiple operations simultaneously within a handler.

```typescript
import { createWorkflow, executeParallel } from '@classytic/streamline';

const workflow = createWorkflow<{ userId: string }>('fetch-user-data', {
  steps: {
    fetchData: async (ctx) => {
      // Execute 3 API calls in parallel
      const results = await executeParallel([
        () => fetchUserData(ctx.context.userId),
        () => fetchOrders(ctx.context.userId),
        () => fetchPayments(ctx.context.userId)
      ], {
        mode: 'all',        // Wait for all to complete
        timeout: 30000,     // Overall timeout
        concurrency: 3      // Max concurrent operations
      });

      return { user: results[0], orders: results[1], payments: results[2] };
    },
  },
  context: (input) => ({ userId: input.userId }),
});

// Race mode: First to complete wins
const fastest = await executeParallel([
  () => callAPI1(),
  () => callAPI2(),
  () => callAPI3()
], { mode: 'race' });
```

**Parallel modes:**
- `all`: Wait for all operations (like Promise.all)
- `race`: First to complete (like Promise.race)
- `allSettled`: Wait for all, don't fail on errors

### 7. **Webhook Integration**

Wait for external webhooks using secure hook tokens.

```typescript
import { createWorkflow, createHook, resumeHook } from '@classytic/streamline';

const payment = createWorkflow<{ orderId: string }>('payment', {
  steps: {
    waitPayment: async (ctx) => {
      // Create hook with crypto-secure token
      const hook = createHook(ctx, 'payment-webhook');

      // IMPORTANT: Pass hookToken to ctx.wait for validation on resume
      return ctx.wait('Waiting for payment webhook', {
        hookPath: hook.path,
        hookToken: hook.token  // Token validated when resumeHook is called
      });
    },
  },
  context: (input) => ({ orderId: input.orderId }),
});

// In your webhook endpoint
app.post('/webhooks/payment/:token', async (req, res) => {
  // Token is validated against stored hookToken before resuming
  const { run } = await resumeHook(req.params.token, req.body);
  res.json({ received: true, status: run.status });
});
```

**Security notes:**
- `createHook` generates tokens with crypto-random suffixes (unguessable)
- Pass `hookToken` in `ctx.wait()` data to enable token validation on resume
- `resumeHook` validates the token before resuming the workflow

---

## ❌ NOT Supported (By Design)

### Loops

**Why not?**
- Risk of infinite loops
- Resource exhaustion
- Most workflows don't need them

**Alternatives:**
1. **Use retry logic** for fixed iterations
2. **Use array processing** in handlers
3. **Start new workflows** from step output

```typescript
import { createWorkflow } from '@classytic/streamline';

// Pattern 1: Retry logic (built-in)
const poll = createWorkflow<{ url: string }>('poll', {
  steps: {
    pollStatus: {
      handler: async (ctx) => { /* check status */ },
      retries: 10,  // Will retry up to 10 times
    },
  },
  context: (input) => ({ url: input.url }),
});

// Pattern 2: Process array in handler
const batch = createWorkflow<{ items: string[] }>('batch', {
  steps: {
    processItems: async (ctx) => {
      for (const item of ctx.context.items) {
        await processItem(item);
      }
      return { processed: ctx.context.items.length };
    },
  },
  context: (input) => ({ items: input.items }),
});
```

---

## Feature Comparison

| Feature | Built-in | Import | Use Case |
|---------|----------|--------|----------|
| Retry | ✅ | `createWorkflow` | Transient failures |
| Timeout | ✅ | `createWorkflow` | Slow operations |
| Sleep | ✅ | `createWorkflow` | Time-based delays |
| Wait/Hooks | ✅ | `createWorkflow`, `resumeHook` | Human input |
| Conditional | ✅ | `conditions` | Skip steps |
| Parallel | ✅ | `executeParallel` | Concurrent ops |
| Webhooks | ✅ | `createHook`, `resumeHook` | External triggers |

---

## Real-World Examples

### Payment Gateway Flow

```typescript
import { createWorkflow, createHook, conditions } from '@classytic/streamline';

interface PaymentContext {
  amount: number;
  paymentId?: string;
  requires3DS?: boolean;
  status?: string;
}

const payment = createWorkflow<PaymentContext>('payment', {
  steps: {
    initiate: {
      handler: async (ctx) => {
        const payment = await paymentGateway.create({ amount: ctx.context.amount });
        await ctx.set('paymentId', payment.id);
        return { paymentId: payment.id };
      },
      timeout: 5000,
      retries: 2,
    },
    check3ds: async (ctx) => {
      const requires3DS = ctx.context.amount > 1000;
      await ctx.set('requires3DS', requires3DS);
      return { requires3DS };
    },
    authenticate: {
      handler: async (ctx) => {
        const hook = createHook(ctx, '3ds-callback');
        return ctx.wait('3DS authentication', {
          authUrl: hook.path,
          hookToken: hook.token  // Secure token validation
        });
      },
      condition: (context) => context.requires3DS === true,
    },
    process: {
      handler: async (ctx) => {
        const result = await paymentGateway.capture(ctx.context.paymentId!);
        await ctx.set('status', result.status);
        return { success: result.status === 'completed' };
      },
      timeout: 10000,
      retries: 3,
    },
  },
  context: (input) => ({ amount: input.amount }),
});
```

### Loan Approval with Risk Assessment

```typescript
import { createWorkflow, executeParallel, conditions } from '@classytic/streamline';

interface LoanContext {
  ssn: string;
  amount: number;
  applicationId: string;
  creditScore?: number;
  riskScore?: number;
  requiresReview?: boolean;
  approved?: boolean;
}

const loan = createWorkflow<LoanContext>('loan-approval', {
  steps: {
    creditCheck: {
      handler: async (ctx) => {
        const [creditScore, bureauData] = await executeParallel([
          () => getCreditScore(ctx.context.ssn),
          () => getBureauData(ctx.context.ssn)
        ], { mode: 'all', timeout: 30000 });
        await ctx.set('creditScore', creditScore);
        return { creditScore };
      },
      timeout: 30000,
    },
    riskAssessment: async (ctx) => {
      const riskScore = calculateRisk(ctx.context.creditScore!, ctx.context.amount);
      await ctx.set('riskScore', riskScore);
      await ctx.set('requiresReview', riskScore > 70);
      return { riskScore };
    },
    autoDecision: async (ctx) => {
      if (!ctx.context.requiresReview) {
        await ctx.set('approved', true);
        return { approved: true, auto: true };
      }
      return { needsReview: true };
    },
    manualReview: {
      handler: async (ctx) => {
        return ctx.wait('Manual review required', { riskScore: ctx.context.riskScore });
      },
      condition: (context) => context.requiresReview === true && !context.approved,
    },
  },
  context: (input) => ({
    ssn: input.ssn,
    amount: input.amount,
    applicationId: input.applicationId,
  }),
});
```

---

## Tips & Best Practices

1. **Use retries for transient failures**, not business logic
2. **Use conditionals for branching**, not complex if-else in handlers
3. **Use parallel execution** when operations are independent
4. **Use wait() for external input**, sleep() for time delays
5. **Keep handlers focused** - one step = one responsibility
6. **Store important data in context** - it survives restarts
7. **Don't store large blobs** - store references instead
8. **Use secure hook tokens** - always pass `hookToken` in `ctx.wait()` data

```typescript
// ❌ Bad: Store entire file in context
await ctx.set('fileData', largeBuffer);

// ✅ Good: Store file reference
await saveToS3(largeBuffer, 'file-123');
await ctx.set('fileKey', 'file-123');
```
