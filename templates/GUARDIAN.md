# GUARDIAN.md — project rules for Code Guardian

Put this file in the root of each project and fill it in. Code Guardian reads it before every review. Anything left blank, it works out on its own.

## Project
- Name:
- What it does (one line):
- Users and region:
- Domain (fintech, health, e-commerce, portfolio, AI agent, ...):
- Stage (prototype / MVP / production):

## Permanent rules
Breaking any of these is always P0.
-
-

## Locked files
Never edit these without explicit approval.
-

## Priorities right now
What matters most this phase (e.g. stability over features, cut token cost):
-

## Compliance scope
Laws and standards that apply (e.g. UAE PDPL, GDPR):
-

## Known issues / don't re-flag
-

---

## Example: Navi

### Project
- Name: Navi
- What it does: voice-first AI financial companion for UAE expats managing multi-currency finances
- Users and region: UAE expats; EN/AR/HI prioritized, 13 languages
- Domain: fintech + AI
- Stage: pre-MVP, working toward v1.0-stable

### Permanent rules
- AI proposes, code decides, database is truth
- User identity from JWT only
- RLS tested adversarially
- No full prompts, snapshots or financial payloads in logs
- All model vendors under no-training terms
- Never silently substitute a category; ask via pending_clarifications
- Backfills never overwrite user-confirmed data
- One source of truth for categories, enforced by CI

### Locked files
- NaviAnimation.tsx
- JourneyMap.tsx
- StageAdvancedModal.tsx
- JourneyDetailModal.tsx
- ProfileJourneyHeroCard.tsx
- parse-expense/index.ts

### Priorities right now
- Stop trust failures before adding infrastructure
- Ship v1.0-stable tag and Vercel cutover

### Compliance scope
- UAE PDPL; regulated financial-advice risk (flag for legal review)
