# QC Process Automation (Monday.com + Convex)

This automation listens to Monday webhooks and coordinates QC stages across Copy (Q1), Design (Q2), and CS (Q3) with owner assignment and failure handling.

Routes
- POST /monday/qc: webhook endpoint

Workflow
- When Task Stage becomes “Internal Review”:
  - Set QC 1 - Copy to “In Review”
  - Assign Currently With: Caroline + Lusanda
  - Optionally set AI QC column to label “AI QC” (triggers external AI QC automation)
- When QC 1 -> Pass:
  - Set QC 2 - Design to “In Review”
  - Assign Currently With: Christine
- When QC 2 -> Pass:
  - Set QC 3 - CS to “In Review”
  - Assign Currently With: Job bag owner (parent item owner)
- When any QC changes to Pass/Reverts:
  - IF all QC columns are NOT "In Review"
  - AND any QC column is "Reverts"
  - AND Task Stage is "Internal Review"
  - THEN:
    - Set Task Stage to "6. Int. Reverts"
    - Post update mentioning "Briefed By" person(s) to update Internal Deadline
- When all QC Pass:
  - Set Task Stage to "Ready to Send"

Setup
1) Install deps
```
npm install
```

2) Initialize Convex locally
```
npx convex dev
```

3) Set Convex env vars (examples)
```
# Required
npx convex env set MONDAY_API_TOKEN {{MONDAY_API_TOKEN}}

# Optional board filter
npx convex env set MONDAY_TARGET_BOARD_ID 1394483140

# Column IDs (defaults included from your snippet, set exact IDs to be safe)
npx convex env set MONDAY_TASK_STAGE_COLUMN_ID {{TASK_STAGE_COLUMN_ID}}
npx convex env set MONDAY_QC1_COLUMN_ID color_mkwzfjx8
npx convex env set MONDAY_QC2_COLUMN_ID color_mkx4wfdz
npx convex env set MONDAY_QC3_COLUMN_ID color_mkx4rwcm
npx convex env set MONDAY_CURRENTLY_WITH_COLUMN_ID multiple_person_mkwzxjqy
npx convex env set MONDAY_AI_QC_COLUMN_ID {{AI_QC_STATUS_COLUMN_ID}}

# Labels / indices
npx convex env set MONDAY_INTERNAL_REVIEW_LABEL "Internal Review"
npx convex env set MONDAY_INTERNAL_REVIEW_INDEX  # optional, if you prefer index matching
npx convex env set MONDAY_INT_REVERTS_LABEL "6. Int. Reverts"
npx convex env set MONDAY_INT_REVERTS_INDEX 8
npx convex env set MONDAY_STATUS_IN_REVIEW_LABEL "In Review"
npx convex env set MONDAY_STATUS_PASS_LABEL "Pass"
npx convex env set MONDAY_STATUS_REVERTS_LABEL "Reverts"

# AI QC trigger label on its status column
npx convex env set MONDAY_AI_QC_TRIGGER_LABEL "AI QC"
npx convex env set MONDAY_AI_QC_TRIGGER_INDEX  # optional

# People (defaults prefilled; override if needed)
npx convex env set MONDAY_PERSON_CHRISTINE 77673213
npx convex env set MONDAY_PERSON_CAROLINE 70707376
npx convex env set MONDAY_PERSON_LUSANDA 77846388

# Job bag owner column on parent item
npx convex env set MONDAY_JOB_BAG_OWNER_COLUMN_ID {{OWNER_COLUMN_ID}}

# Notification message when transitioning to Internal Reverts (optional)
npx convex env set MONDAY_REVERTS_NOTIFICATION_MESSAGE "This item has moved to Internal Reverts. Please update the Internal Deadline accordingly."
```

4) Deploy when ready
```
npm run deploy
```
Then point your Monday webhook to:
```
<your-convex-deployment-base>/monday/qc
```

Notes
- Idempotent updates: we check current values before setting to avoid loops.
- Parent ownership: we resolve `parent_item` via GraphQL, then read the owner column (people) to assign Q3.
- You can keep using your existing AI QC automation; just set `MONDAY_AI_QC_COLUMN_ID` so we label it to “AI QC” during Internal Review.
