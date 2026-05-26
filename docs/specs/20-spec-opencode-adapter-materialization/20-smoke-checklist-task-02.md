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

### 3. Add `@weave/adapter-opencode` to `opencode.json`

Create or update `opencode.json` in the test project:

```jsonc
// opencode.json
{
  "plugin": ["@weave/adapter-opencode"]
}
```

> **No user-authored wrapper script is required.** The package itself is the plugin entry point. OpenCode loads the default-exported `WeavePlugin` function at startup, which reads `.weave/config.weave`, materializes all declared agents, and returns.

---

## Verification Steps

### Step 1: Start OpenCode in the test project

```bash
cd /tmp/weave-smoke-test
opencode
```

OpenCode loads `@weave/adapter-opencode` at startup. The plugin reads `.weave/config.weave` and materializes `smoke-test-agent`.

**Expected log output (pino JSON, visible in OpenCode app log):**
```json
{"level":30,"module":"adapter-opencode/plugin","directory":"/tmp/weave-smoke-test","msg":"Weave plugin starting"}
{"level":30,"module":"adapter-opencode","agent":"smoke-test-agent","msg":"Agent descriptor translated successfully"}
{"level":30,"module":"adapter-opencode","agent":"smoke-test-agent","msg":"Agent materialized successfully via OpenCode SDK"}
{"level":30,"module":"adapter-opencode/plugin","agentCount":1,"msg":"Weave plugin initialization complete"}
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

Restart OpenCode (or reload the plugin) a second time:

**Expected**: No error. The agent is updated in place (not duplicated). The `[weave-managed]` tag is preserved.

### Step 4: Verify collision protection

Manually create an agent named `smoke-test-agent` in OpenCode **without** the `[weave-managed]` tag (e.g. via the OpenCode UI or config file), then restart OpenCode:

**Expected**: The plugin logs a `CollisionError` and the manually created agent is **not** overwritten.

---

## Pass Criteria

| Check | Expected |
|-------|----------|
| Plugin loads without uncaught exception | ✅ |
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
- The plugin entry point is `src/plugin.ts` — it exports `WeavePlugin` as the default export and `server` as a named export for `PluginModule` compatibility.
