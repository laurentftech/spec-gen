# Story {ID}: {Title}

**Type**: feature | technical-debt | bug | spike
**Epic**: {epic name}
**Status**: Draft | Ready | In Progress | Review | Done

---

## User Story

As a **{role}**,
I want **{capability}**,
so that **{benefit}**.

---

## Acceptance Criteria

> Each criterion must be testable: describe a specific observable outcome, not a vague quality.
> ✗ "The UX should be responsive" — not a criterion
> ✓ "Submitting the form with an empty email field shows a validation error" — testable

- [ ] AC1: {criterion}
- [ ] AC2: {criterion}
- [ ] AC3: {criterion}

---

## Won't Do

> What this story explicitly does NOT cover. Minimum 1 item.
> Prevents scope creep and removes ambiguity for the Dev Agent.

- {out-of-scope item}

---

## Risk Context

> Pre-filled by the Architect Agent using spec-gen.
> Dev Agent reads this — does NOT rediscover it at implementation time.

- **Domains in scope**: {e.g. auth, api}
- **Max risk score**: {0–100} {🟢 low | 🟡 medium | 🟠 high | 🔴 critical}
- **Functions in scope**: {function1 (file), function2 (file)}
- **Blocking refactors**: {none | "Refactor X first — Story {ID}"}
- **Parallel risk**: {none | "Conflicts with Story {ID} on function X"}
- **Insertion points**: {function (strategy, score)}
- **Spec domains linked**: {domain1/spec.md, domain2/spec.md}

### Structural Notes

{Any architectural constraints, patterns to follow, anti-patterns to avoid.
 Filled by Architect Agent based on get_architecture_overview output.}

---

## Technical Constraints

- {constraint 1}
- {constraint 2}

---

## Tasks

> Filled by Dev Agent during implementation.

- [ ] {task 1}
- [ ] {task 2}
- [ ] Add/update tests
- [ ] Run `check_spec_drift` — confirm clean

---

## Dev Agent Record

> Filled by Dev Agent on completion.

### Implementation Summary

- **Insertion point used**: {function} in {file}
- **Files changed**: {list}
- **Tests added**: {N}
- **Spec drift**: ✅ clean | ⚠️ {details}

### Risk Notes

| Function | Actual Risk Score | Delta vs Estimate |
|---|---|---|
| | | |

### Scope Notes

{Were any functions touched outside the planned scope? Why?}

---

## Dependencies

- **Blocked by**: {Story ID — reason} | none
- **Blocks**: {Story ID} | none

---

## Story Points

{estimate} — basis: {risk level, insertion complexity, test surface}
