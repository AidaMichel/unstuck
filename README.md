# 🛟 UNSTUCK

**An AI agent team that gets AI-built code unstuck.**

You built something fast with Lovable, Cursor, Bolt, v0 or Claude Code. Now every fix breaks something else, nobody knows if it's safe to ship, and the AI keeps undoing its own work.

UNSTUCK puts a senior team on your project — a code reviewer, a refactor architect, a QA lead, a risk & compliance officer and a product challenger — led by an agent that checks their work. You get one report, in plain language: what's wrong, what to fix first, and what to stop doing.

```bash
npx unstuck rescue
```

---

## The team

| Specialist | What they do |
|------------|--------------|
| 🔍 **Code Reviewer** | Logic bugs, money and timezone math, race conditions, double writes, broken fallbacks, token-heavy prompts, and AI-generated code smells (duplicate implementations, dead attempts, comments that contradict the code) |
| 🧹 **Refactor Architect** | Small, safe, numbered refactor steps — never mixing a refactor with a behavior change |
| 🧪 **QA Lead** | Actually runs your tests, typecheck and build, reports exact counts, and designs the missing test cases (RTL text, multiple currencies, offline, expired sessions…) |
| ⚖️ **Risk & Compliance Officer** | Security, secrets in git history, privacy, dependencies, and the rules for your domain and region: GDPR, UAE PDPL, Egypt PDPL, fintech, health, kids, AI-specific risks. Legal items are flagged, never "signed off" |
| 💡 **Product Challenger** | Thinks outside the box: pre-mortem, premise check, the 10x simpler version, inversion, and walking the feature as very different real users |
| 🧭 **Lead** | Learns your project first (stack, domain, users, region), briefs all five in parallel, merges their findings, **personally verifies every P0 and P1 against the code**, and writes the final report |

A fintech app and a portfolio site get different checks, because the lead works out what your project is before anyone starts.

## Modes

```bash
unstuck review                    # recent changes (since last tag / last 10 commits)
unstuck review -b origin/main     # just this branch
unstuck audit                     # the whole project, full team
unstuck rescue                    # broken or stuck: triage → map → diagnose → stabilize → guardrails
```

`audit` and `rescue` use the full team by default; `review` runs as one agent to stay fast and cheap. Switch with `--team` or `--solo`.

Every report starts with a verdict (**Ship / Ship with fixes / Do not ship**), then a findings table with IDs and severities:

- **P0** — breaks security, data, money, user trust, or one of your permanent rules. Block the release.
- **P1** — real bug or risk, fix soon.
- **P2** — worth fixing.
- **P3** — idea or polish.

Then you choose what gets fixed:

```bash
unstuck fix F1,F4,R2
```

Reports in your language: `unstuck audit --lang Arabic`.

## Safe by design

AI proposes, code decides. UNSTUCK has three layers of protection that don't depend on the AI behaving:

1. **A guard on every action.** Every file read, edit and shell command — by the lead or any specialist — is checked by plain code before it runs.
   - `review`, `audit` and `rescue` are read-only.
   - `fix` only edits what you picked, and never your locked files, `.env` files, keys, CI workflows or git internals.
   - Never allowed in any mode: reading secrets, `git push` or history rewrites, recursive deletes, deploys, database migrations, publishing, running scripts piped from the internet, or touching anything outside your project.
2. **A before/after fingerprint of your project.** If anything changes when it shouldn't (say, a test script writes files), the report tells you exactly what. If a locked file changes, UNSTUCK **puts it back automatically**.
3. **Secret redaction.** API keys, tokens, JWTs, private keys and database passwords are scrubbed from every report and PR comment, even if the agent quotes one.

## Your rules: `GUARDIAN.md`

```bash
unstuck init
```

Creates a `GUARDIAN.md` in your project (and keeps reports out of git). Fill in:

- **Permanent rules** — breaking one is always P0.
- **Locked files** — enforced by the guard; the AI cannot edit them. A folder works too (`legacy/`).
- **Priorities right now**, **compliance scope**, and **known issues** not to re-flag.

Your AI coding tools (Claude Code, Cursor, Lovable) can read the same file, so they stop breaking the same things. The template includes a filled-in fintech example.

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
          fail-on: P0        # block the merge on a P0
          # team: true       # full specialist team on every PR
          # lang: Arabic
```

UNSTUCK posts its report as a PR comment (updating the same comment on each push), adds it to the job summary, uploads it as an artifact, and fails the check if it finds a P0. Pull requests from forks don't get your secret, so they're skipped with a notice.

> **Security:** use the `pull_request` trigger as shown. Don't use `pull_request_target` — it would run an AI agent with your API key on code from strangers.

## Setup

1. Node.js 18 or newer.
2. An Anthropic API key from [console.anthropic.com](https://console.anthropic.com):
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-...
   ```
   (Amazon Bedrock and Google Vertex work too, via Claude Code's usual environment variables.)
3. In your project folder:
   ```bash
   npx unstuck review
   ```

The cost is printed at the end of each run. A solo review of a small change is usually cents; a full team audit of a large project costs more. Use `--model sonnet` for cheaper runs.

## Prefer Claude Code?

`agents/code-guardian.md` is the same brain as a Claude Code subagent. Copy it to `~/.claude/agents/` and say "use code-guardian to review this".

## Development

```bash
npm install
npm test          # builds, then runs the guard, snapshot, report and team tests
npm run typecheck
```

## Built with

[Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview) · TypeScript

## License

MIT
