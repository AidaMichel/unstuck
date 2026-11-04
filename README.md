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
| 🧪 **QA Lead** | Runs your tests, typecheck and build when you allow it (`--run-checks`), reports exact counts, and designs the missing test cases (RTL text, multiple currencies, offline, expired sessions…) |
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

`fix` reads this project's latest report from the report folder (or `--report <file>`). It's the only mode that changes your project, and it never commits.

Reports in your language: `unstuck audit --lang Arabic`.

## Safe by design

AI proposes, code decides. `review`, `audit` and `rescue` are designed never to change your project, even if another editor or coding agent is working in it at the same time.

1. **Reports live outside your project.** By default in `~/.unstuck/reports/<project>/` (override with `UNSTUCK_REPORT_DIR` or `--out`). UNSTUCK refuses an output path inside the project, including through a symlink, and refuses to write through a symlinked file.
2. **A guard on every action.** Every file read, edit and shell command — by the lead or any specialist — is checked by plain code before it runs.
   - In read-only modes, shell commands must come from a short allowlist of inspection commands (`git log/diff/show/status`, `ls`, `cat`, `grep`, `find`, …). Flags that write or run programs (`find -delete`, `sort -o`, `git -c`, `rg --pre` …), redirection to files, variable expansion and subshells are refused.
   - Project scripts (tests, build, lint) don't run unless you pass `--run-checks`.
   - `fix` only edits what you picked, and never your locked files, `.env` files, keys, CI workflows or git internals.
   - Never allowed in any mode: reading `.env` secrets or secret-looking environment variables, `git push` or history rewrites, recursive deletes, deploys, database migrations, publishing, or running scripts piped from the internet.
3. **A before/after fingerprint, observe only.** If files change during a run, the report lists them as a warning. UNSTUCK doesn't claim it caused them (another tool may have), and **never reverts anything**. If a locked file changes during `fix`, the run fails so you can check it.
4. **Secret redaction.** API keys, tokens, JWTs, private keys and database passwords are scrubbed from every report and PR comment, even if the agent quotes one.

### Limits — read this

These layers reduce risk; they are not a sandbox, and tests of them don't prove UNSTUCK is secure.

- **The shell guard reads command text.** It can't see what a program does once it runs. With `--run-checks`, your tests and build scripts run real code from the project: they can write files, use the network, and read environment variables (including your API key). Only use `--run-checks` on code you trust, ideally in a disposable copy or CI.
- **Bash can still read files outside the project** that the path check doesn't recognise (for example, through paths built inside a program). Don't run UNSTUCK as a user with access to secrets it shouldn't see.
- **Git inspection isn't perfectly side-effect-free.** UNSTUCK sets `GIT_OPTIONAL_LOCKS=0`, but a repository's own git config (for example custom diff drivers) can still run commands.
- **Team mode relies on the Claude Agent SDK applying the same permission check to specialists.** This has not been independently verified for every SDK version.
- **The change fingerprint skips** `node_modules`, `.git`, build output and caches, and stops at 50,000 files.
- **Prompt injection:** a repository can contain text written to manipulate the agent. The guard limits what a manipulated agent can do; it doesn't stop the agent from writing a misleading report.

For strong isolation, run UNSTUCK in a container or a throwaway clone with no secrets beyond the API key.

## Your rules: `GUARDIAN.md`

```bash
unstuck init
```

Creates a `GUARDIAN.md` in your project. Fill in:

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
      - uses: actions/checkout@v5
        with: { fetch-depth: 0 }
      - uses: AidaMichel/unstuck@v0
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          fail-on: P0        # block the merge on a P0
          # team: true       # full specialist team on every PR
          # lang: Arabic
          # run-checks: true # run your tests/build (runs PR code with the key in the environment)
```

UNSTUCK writes its report outside the checkout, posts it as a PR comment (updating the same comment on each push), adds it to the job summary, uploads it as an artifact, and fails the check if it finds a P0. Pull requests from forks don't get your secret, so they're skipped with a notice.

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

## Releasing (maintainers)

1. Bump `version` in `package.json` and push.
2. On GitHub: **Releases → Draft a new release**, tag `vX.Y.Z` matching the version, **Publish**.

The Release workflow tests, publishes to npm with provenance, and moves the `v0` tag. It needs an `NPM_TOKEN` repository secret.

## Built with

[Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview) · TypeScript

## License

MIT
