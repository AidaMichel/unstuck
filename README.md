# 🛟 UNSTUCK

**The AI agent that gets AI-built code unstuck.**

You built something fast with Lovable, Cursor, Bolt, v0 or Claude Code. Now every fix breaks something else, nobody knows if it's safe to ship, and the AI keeps undoing its own work.

UNSTUCK reads your project like a principal engineer, QA lead, risk officer and product skeptic at once — then tells you, in plain language, what's wrong, what to fix first, and what to stop doing.

```bash
npx unstuck rescue
```

---

## What it does

Every run goes through five passes:

| Pass | What it checks |
|------|----------------|
| 🔍 **Code review** | Logic bugs, money and timezone math, race conditions, double writes, broken fallbacks, token-heavy prompts, and AI-generated code smells (duplicate implementations, dead attempts, contradicting comments) |
| 🧹 **Refactor plan** | Small, safe, numbered steps — never mixing refactor and behavior change |
| 🧪 **QA** | Actually runs your tests, typecheck and build, reports exact counts, and lists the missing test cases (incl. RTL text, multiple currencies, offline, expired sessions) |
| ⚖️ **Risk & compliance** | Security, privacy, dependencies, plus domain checks: GDPR, UAE PDPL, Egypt PDPL, fintech, health, kids, AI-specific risks. Legal items are flagged, never "signed off" |
| 💡 **Challenge** | Pre-mortem, premise check, the 10x simpler version, inversion, and walking the feature as very different real users |

It starts by **learning your project** — stack, domain, users, region — so a fintech app and a portfolio site get different checks.

## Three modes

```bash
unstuck review          # changes since the last tag / last 10 commits
unstuck review -b origin/main   # just this branch
unstuck audit           # the whole project
unstuck rescue          # it's broken or stuck: triage → map → diagnose → stabilize → guardrails
```

Every report starts with a verdict (**Ship / Ship with fixes / Do not ship**), then a table of findings with IDs and severities (P0–P3).

Then you choose what gets fixed:

```bash
unstuck fix F1,F4,R2
```

## Safe by design

AI proposes, code decides. Every action the agent takes passes through a guard written in plain code, not a prompt:

- **Review, audit and rescue are read-only.** Edits and file-changing shell commands are blocked.
- **`fix` only edits what you picked** — and never your locked files.
- **Never, in any mode:** reading `.env` or secrets, `git push`, deploys, database migrations, `npm publish`, piping scripts from the internet, or touching anything outside your project.

## Your rules: `GUARDIAN.md`

```bash
unstuck init
```

Creates a `GUARDIAN.md` in your project with your permanent rules, locked files, priorities and compliance scope. Breaking a permanent rule is always P0. Locked files are enforced by the guard — the AI physically cannot edit them.

Your AI coding sessions (Claude Code, Cursor, Lovable) can read the same file, so they stop breaking the same things.

## On every pull request

Add `.github/workflows/unstuck.yml`:

```yaml
name: UNSTUCK review
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: AidaMichel/unstuck@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          fail-on: P0
```

UNSTUCK comments its report on the PR and blocks the merge if it finds a P0.

## Setup

1. Node.js 18 or newer.
2. An Anthropic API key from [console.anthropic.com](https://console.anthropic.com):
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Run it in your project folder:
   ```bash
   npx unstuck review
   ```

A review typically costs a few cents to a couple of dollars depending on project size; the cost is printed at the end of each run.

## Prefer Claude Code?

`agents/code-guardian.md` is the same brain as a Claude Code subagent. Copy it to `~/.claude/agents/` and say "use code-guardian to review this".

## Built with

[Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview) · TypeScript

## License

MIT
