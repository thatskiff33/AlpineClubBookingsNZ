# TACBookings - Development Workflow with Claude Code

This document describes the session-per-phase approach used to build TACBookings with Claude Code. Retained for reference.

---

## Overview

The build uses a **session-per-phase** approach. Each session focuses on one build phase, runs autonomously with minimal interruption, and hands off cleanly to the next session via CLAUDE.md. Within each session, Claude uses sub-agents in parallel where modules are independent.

## Step 1: Configure Claude Code for Autonomous Work

Create `.claude/settings.json` in the project root to pre-approve safe commands so Claude doesn't ask permission for every npm/git/prisma operation:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm *)",
      "Bash(npx *)",
      "Bash(node *)",
      "Bash(git add *)",
      "Bash(git commit *)",
      "Bash(git push *)",
      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(docker compose *)",
      "Bash(mkdir *)",
      "Bash(ls *)",
      "Bash(cat *)",
      "Bash(cp *)",
      "Bash(mv *)",
      "Bash(rm -rf node_modules)",
      "Bash(rm -rf .next)",
      "Read(*)",
      "Edit(*)",
      "Write(*)",
      "Glob(*)",
      "Grep(*)"
    ],
    "deny": [
      "Bash(rm -rf /)*",
      "Bash(rm -rf .git)*"
    ]
  }
}
```

## Step 2: Structure CLAUDE.md for Session Handoff

The CLAUDE.md in the repo root is the **single source of truth** that any new Claude session reads first. It must always contain:

1. **What the project is** (context, requirements) - already written
2. **What has been built so far** - updated at end of each session
3. **What to build next** - the next phase's scope
4. **How to run/test it** - commands that work right now
5. **Known issues / decisions made** - so Claude doesn't re-litigate settled decisions

At the end of each build session, tell Claude: **"Update CLAUDE.md with what was built, what works, and what's next. Commit and push."**

## Step 3: Path-Scoped Rules

Path-scoped rules are in `.claude/rules/` and only load when Claude touches files in matching paths. See `database.md`, `api.md`, `stripe.md`, `testing.md`.

## Step 4: Session-per-Phase Execution

Each phase = one Claude Code session.

**Starting a session:**
```
Read CLAUDE.md. Build Phase [N]: [Phase Name].

Build everything in this phase autonomously. Write tests for all
business logic. Commit after each major milestone. When done, update
CLAUDE.md with what was built, commands to run/test, and what's next.
Push all commits.
```

**When Claude SHOULD interrupt you:**
- Ambiguous requirements (e.g. "should promo codes stack?")
- Architecture decisions not covered in the plan
- External service setup needed (e.g. "I need your Stripe test API key")
- A persistent bug it can't resolve after 2-3 attempts

## Step 5: Security & Quality Checkpoints

After each phase, run a dedicated review session:

```
Read CLAUDE.md. Review Phase [N] code for:
1. Security vulnerabilities (OWASP top 10, input validation, auth bypass)
2. Business logic correctness (edge cases in pricing, bumping, availability)
3. Error handling (what happens when Stripe/Xero is down?)
4. Test coverage gaps
5. Code quality (duplication, unnecessary complexity)

Fix any issues found. Do NOT add features or refactor beyond what's needed.
Commit fixes and push.
```

## Recovery: When Things Go Wrong

If a session produces broken code:
```
Read CLAUDE.md. The last session left the build in a broken state.
Run `npm run build` and `npm test` to see what's failing.
Fix all errors without changing working functionality.
Commit and push when green.
```

If you want to restart a phase from scratch:
```
Read CLAUDE.md. Revert Phase [N] commits and rebuild Phase [N]
from the beginning using a different approach for [specific issue].
```

## Hooks for Auto-Formatting (Optional)

Add to `.claude/settings.json` to auto-format code after every edit:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$CLAUDE_FILE_PATH\" 2>/dev/null || true"
          }
        ]
      },
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "npx prettier --write \"$CLAUDE_FILE_PATH\" 2>/dev/null || true"
          }
        ]
      }
    ]
  }
}
```
