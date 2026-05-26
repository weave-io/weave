# Smoke Checklist — Task 2: SDK-Backed Materialization

**Spec**: 20-spec-opencode-adapter-materialization  
**Task**: 2.0 Replace in-memory translation with real SDK-backed materialization  
**Purpose**: Verify that a Weave-authored agent appears in OpenCode after materialization via the real SDK path.

---

## Prerequisites

- OpenCode is installed and accessible (`opencode` CLI or desktop app).
- `@weave/adapter-opencode` is built (`bun run build` from the repo root).
- A project directory with a `.weave/config.weave` file is available.
- The user's normal OpenCode configuration does **not** load the legacy `weave` plugin — use a clean project or temporarily disable it.

---

## Setup

### 1. Create a minimal test project

```bash
mkdir /tmp/weave-smoke-test
cd /tmp/weave-smoke-test
```

### 2. Write a minimal `.weave/config.weave`

```bash
mkdir -p .weave/prompts
cat > .weave/config.weave << 'EOF'
agent smoke-test-agent {
  description "Smoke test agent for Weave materialization"
  prompt "You are a smoke test agent created by Weave materialization."
  models ["claude-sonnet-4-5"]
  mode subagent
  temperature 0.2

  tool_policy {
    read allow
    write deny
    execute deny
    delegate deny
    network deny
  }
}
EOF
```

### 3. Write a minimal OpenCode plugin entry point

Create `weave-plugin.ts` in the test project:

```typescript
import { createOpencodeClient } from "@opencode-ai/sdk";
import { OpenCodeAdapter, SdkOpenCodeClient } from "@weave/adapter-opencode";
import { loadConfig } from "@weave/config";
import { buildDescriptors } from "@weave/engine";

export default async function weavePlugin(ctx: { directory: string }) {
  // Load Weave config
  const configResult = await loadConfig({ projectRoot: ctx.directory });
  if (configResult.isErr()) {
    console.error("Weave config load failed:", configResult.error);
    return;
  }

  // Build agent descriptors
  const descriptors = buildDescriptors(configResult.value);

  // Create SDK client and adapter
  const sdkClient = createOpencodeClient({ directory: ctx.directory });
  const adapter = new OpenCodeAdapter({
    projectRoot: ctx.directory,
    client: new SdkOpenCodeClient(sdkClient),
  });

  // Initialize and materialize
  await adapter.init();
  for (const descriptor of descriptors) {
    await adapter.spawnSubagent(descriptor);
    console.log(`Materialized agent: ${descriptor.name}`);
  }
}
```

---

## Verification Steps

### Step 1: Run the plugin entry point

```bash
cd /tmp/weave-smoke-test
bun run weave-plugin.ts
```

**Expected output:**
```
Materialized agent: smoke-test-agent
```

**Expected log output (pino JSON):**
```json
{"level":30,"module":"adapter-opencode","agent":"smoke-test-agent","msg":"Agent descriptor translated successfully"}
{"level":30,"module":"adapter-opencode","agent":"smoke-test-agent","msg":"Agent materialized successfully via OpenCode SDK"}
```

### Step 2: Verify the agent appears in OpenCode

Open OpenCode (CLI or desktop) in the test project directory and list agents:

```bash
# If using OpenCode CLI
opencode agents list
```

**Expected**: `smoke-test-agent` appears in the agent list with:
- Description containing `[weave-managed]`
- Prompt: `"You are a smoke test agent created by Weave materialization."`
- Mode: `subagent`

### Step 3: Verify idempotency (update path)

Run the plugin entry point a second time:

```bash
bun run weave-plugin.ts
```

**Expected**: No error. The agent is updated in place (not duplicated). The `[weave-managed]` tag is preserved.

### Step 4: Verify collision protection

Manually create an agent named `smoke-test-agent` in OpenCode **without** the `[weave-managed]` tag (e.g. via the OpenCode UI or config file), then run the plugin again:

```bash
bun run weave-plugin.ts
```

**Expected**: The plugin logs a `CollisionError` and exits with a non-zero code. The manually created agent is **not** overwritten.

---

## Pass Criteria

| Check | Expected |
|-------|----------|
| Plugin runs without uncaught exception | ✅ |
| `smoke-test-agent` appears in OpenCode agent list | ✅ |
| Agent description contains `[weave-managed]` | ✅ |
| Second run updates agent without error | ✅ |
| Foreign agent with same name triggers CollisionError | ✅ |

---

## Notes

- This checklist uses `@weave/adapter-opencode` only — the legacy `weave` OpenCode plugin must not be active during this test.
- The `[weave-managed]` ownership tag is the primary signal that distinguishes Weave-managed agents from manually created ones.
- SDK calls flow through `SdkOpenCodeClient` → `client.app.agents()` (list) and `client.config.update()` (create/update).
- If OpenCode is not running, `listAgents()` will return a `ListAgentsError` and materialization will fail with a clear error message.
