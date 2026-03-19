---
description: Configure claude-pulse as your statusline
allowed-tools: Bash, Read, Edit, AskUserQuestion
---

# claude-pulse Setup

## Step 0: Check prerequisites

**Check bun (required):**

macOS/Linux/Win-bash:
```bash
command -v bun 2>/dev/null && bun --version || echo "NOT_FOUND"
```

If bun is not found, stop and tell user to install it from https://bun.sh before continuing.

**Check ccusage (required for cost data):**

```bash
command -v ccusage 2>/dev/null && echo "FOUND" || echo "NOT_FOUND"
```

If ccusage is not found, stop and tell the user:
> claude-pulse requires `ccusage` for daily/weekly cost data.
> Install it with: `npm install -g ccusage` or `bun add -g ccusage`
> Then re-run `/claude-pulse:setup`

## Step 1: Find plugin path

**macOS/Linux/Win-bash:**
```bash
ls -d "$HOME"/.claude/plugins/cache/claude-pulse/claude-pulse/*/ 2>/dev/null \
  | awk -F/ '{ print $(NF-1) "\t" $0 }' \
  | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n \
  | tail -1 | cut -f2-
```

If empty, the plugin is not installed. Tell user to run `/plugin install claude-pulse` first.

## Step 2: Get bun absolute path

```bash
command -v bun 2>/dev/null
```

Verify it exists:
```bash
ls -la {BUN_PATH}
```

## Step 3: Test the command

Run this to verify the script works:
```bash
echo '{}' | {BUN_PATH} {PLUGIN_PATH}src/index.ts
```

It should output one line (possibly empty if no active session). If it errors, stop and show the error.

## Step 4: Generate and apply the settings command

The command dynamically finds the latest installed version so updates work automatically:

```
bash -c 'plugin_dir=$(ls -d "$HOME"/.claude/plugins/cache/claude-pulse/claude-pulse/*/ 2>/dev/null | awk -F/ '"'"'{ print $(NF-1) "\t" $0 }'"'"' | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1 | cut -f2-); exec "{BUN_PATH}" "${plugin_dir}src/index.ts"'
```

Read `~/.claude/settings.json` and merge in:
```json
{
  "statusLine": {
    "type": "command",
    "command": "{GENERATED_COMMAND}"
  }
}
```

Preserve all existing settings. If the file has invalid JSON, report the error and stop.

## Step 5: Verify

Ask the user:
- header: "Setup complete"
- question: "The statusline should appear below your input. Is it working?"
- options: ["Yes, working!", "No, something's wrong"]

If no: show the generated command and tell the user to run it manually to see the error.
