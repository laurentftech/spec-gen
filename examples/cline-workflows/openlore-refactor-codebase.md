# openlore: Refactor Codebase (redirected)

This workflow has been split into two focused workflows for better reliability
with limited models:

- **`/openlore-plan-refactor`** — static analysis, impact assessment, and
  written plan saved to `.openlore/refactor-plan.md` (no code changes)
- **`/openlore-execute-refactor`** — reads the plan and applies changes
  incrementally, with tests after each step

Tell the user:
> "The `/openlore-refactor-codebase` workflow has been split. Please use:
> 1. `/openlore-plan-refactor` to analyse the codebase and write a plan
> 2. `/openlore-execute-refactor` to apply the plan
>
> This two-step approach is more reliable, especially with smaller models."
