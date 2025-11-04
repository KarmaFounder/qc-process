import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import mondaySdk from "monday-sdk-js";

// Environment-configurable IDs and labels (defaults provided from your board snippet)
const CFG = {
  TARGET_BOARD_ID: numOrUndef(process.env.MONDAY_TARGET_BOARD_ID),

  // Columns
  TASK_STAGE_COLUMN_ID: process.env.MONDAY_TASK_STAGE_COLUMN_ID || "status1", // default seen in logs
  QC1_COLUMN_ID: process.env.MONDAY_QC1_COLUMN_ID || "color_mkwzfjx8",
  QC2_COLUMN_ID: process.env.MONDAY_QC2_COLUMN_ID || "color_mkx4wfdz",
  QC3_COLUMN_ID: process.env.MONDAY_QC3_COLUMN_ID || "color_mkx4rwcm",
  CURRENTLY_WITH_COLUMN_ID: process.env.MONDAY_CURRENTLY_WITH_COLUMN_ID || "multiple_person_mkwzxjqy",
  AI_QC_COLUMN_ID: process.env.MONDAY_AI_QC_COLUMN_ID || undefined, // set this via env
  JOB_BAG_OWNER_COLUMN_ID: process.env.MONDAY_JOB_BAG_OWNER_COLUMN_ID || "person", // set exact id via env
  BRIEFED_BY_COLUMN_ID: process.env.MONDAY_BRIEFED_BY_COLUMN_ID || undefined, // parent item people column to mirror assignee
  TEST_GROUP_ID: process.env.MONDAY_TEST_GROUP_ID || "group_mktsne0w",
  TASK_TYPE_COLUMN_ID: process.env.MONDAY_TASK_TYPE_COLUMN_ID || undefined, // e.g. a Status/Text column titled "Task Type"

  // Labels / indices
  INTERNAL_REVIEW_LABEL: process.env.MONDAY_INTERNAL_REVIEW_LABEL || "Internal Review",
  INTERNAL_REVIEW_INDEX: numOrUndef(process.env.MONDAY_INTERNAL_REVIEW_INDEX) ?? 7,
  INT_REVERTS_LABEL: process.env.MONDAY_INT_REVERTS_LABEL || "6. Int. Reverts",
  INT_REVERTS_INDEX: numOrUndef(process.env.MONDAY_INT_REVERTS_INDEX) ?? 8,

  READY_TO_SEND_LABEL: process.env.MONDAY_READY_TO_SEND_LABEL || process.env.MONDAY_ALL_PASS_STAGE_LABEL || "Ready to Send",
  READY_TO_SEND_INDEX: numOrUndef(process.env.MONDAY_READY_TO_SEND_INDEX) ?? numOrUndef(process.env.MONDAY_ALL_PASS_STAGE_INDEX),
  COMPLETED_LABEL: process.env.MONDAY_COMPLETED_LABEL || "Completed",
  COMPLETED_INDEX: numOrUndef(process.env.MONDAY_COMPLETED_INDEX),

  STATUS_IN_REVIEW_LABEL: process.env.MONDAY_STATUS_IN_REVIEW_LABEL || "In Review",
  STATUS_PASS_LABEL: process.env.MONDAY_STATUS_PASS_LABEL || "Pass",
  STATUS_REVERTS_LABEL: process.env.MONDAY_STATUS_REVERTS_LABEL || "Reverts",

  // AI QC label to set for external automation
  AI_QC_TRIGGER_LABEL: process.env.MONDAY_AI_QC_TRIGGER_LABEL || "AI QC",
  AI_QC_TRIGGER_INDEX: numOrUndef(process.env.MONDAY_AI_QC_TRIGGER_INDEX),

  // People
  PERSON_CHRISTINE: Number(process.env.MONDAY_PERSON_CHRISTINE || 77673213),
  PERSON_CAROLINE: Number(process.env.MONDAY_PERSON_CAROLINE || 70707376),
  PERSON_LUSANDA: Number(process.env.MONDAY_PERSON_LUSANDA || 77846388),

  // Task types to apply this flow to (normalize/compare lowercased)
  TASK_TYPES_ALLOWED_CSV: process.env.MONDAY_TASK_TYPES_ALLOWED_CSV || "creative,animation,presentation,editing,copy",
};

const http = httpRouter();

// Monday initial verification sometimes sends a JSON POST with { challenge } and may also issue a GET with ?challenge=
http.route({
  path: "/monday/qc",
  method: "GET",
  handler: (httpAction(async (_ctx: any, req: Request) => {
    const url = new URL(req.url);
    const challenge = url.searchParams.get("challenge");
    if (challenge) return jsonResponse({ challenge });
    return textResponse("OK", 200);
  })) as any,
});

http.route({
  path: "/monday/qc",
  method: "POST",
  handler: (httpAction(async (_ctx: any, req: Request) => {
    const payload = await safeJson(req);

    if (payload?.challenge) return jsonResponse({ challenge: payload.challenge });

    const event = payload?.event;
    if (!event) return textResponse("No event", 400);

    const boardId = Number(event.boardId);
    const itemId = Number(event.pulseId || event.itemId || event.entityId);
    const columnId = String(event.columnId || "");
    const labelText = getLabelTextFromEvent(event);
    const labelIndex = getLabelIndexFromEvent(event);
    const eventGroupId = typeof event.groupId === "string" ? event.groupId : undefined;

    const inTargetBoard = CFG.TARGET_BOARD_ID ? (boardId === CFG.TARGET_BOARD_ID) : true;

    console.log("qc:webhook:event", JSON.stringify({
      boardId, itemId, columnId, labelText, labelIndex, eventGroupId
    }));
    const normLabel = normalize(typeof labelText === "string" ? labelText : JSON.stringify(labelText));
    console.log("qc:label", { labelText, normLabel, labelIndex, wantIndex: CFG.INTERNAL_REVIEW_INDEX });

    if (!inTargetBoard || !itemId) return textResponse("Ignored", 200);


    // Resolve column IDs dynamically by board (fallback to env)
    const cols = await resolveBoardColumns(boardId);
    const TASK_STAGE = (cols.taskStageId ?? CFG.TASK_STAGE_COLUMN_ID) as string;
    const QC1 = (cols.qc1Id ?? CFG.QC1_COLUMN_ID) as string;
    const QC2 = (cols.qc2Id ?? CFG.QC2_COLUMN_ID) as string;
    const QC3 = (cols.qc3Id ?? CFG.QC3_COLUMN_ID) as string;
    const CURRENTLY_WITH = (cols.currentlyWithId ?? CFG.CURRENTLY_WITH_COLUMN_ID) as string;
    const AIQC = (cols.aiQcId ?? CFG.AI_QC_COLUMN_ID) as string | undefined;
    const TASK_TYPE = (cols.taskTypeId ?? CFG.TASK_TYPE_COLUMN_ID) as string | undefined;
    console.log("qc:columns:resolved", { TASK_STAGE, QC1, QC2, QC3, CURRENTLY_WITH, AIQC, TASK_TYPE });

    // Only react to Task Stage, QC1, QC2, QC3 columns
    if (![TASK_STAGE, QC1, QC2, QC3].includes(columnId)) {
      console.log("qc:webhook:skip:notTarget", { columnId });
      return textResponse("Ignored", 200);
    }

    // Quick diagnostics for matching (supports "any column" webhook)
    const isTaskStage = columnId === TASK_STAGE;
    const isQc1 = columnId === QC1;
    const isQc2 = columnId === QC2;
    const isQc3 = columnId === QC3;
    const matchesInternal = matchesLabel(labelText, labelIndex, CFG.INTERNAL_REVIEW_LABEL, CFG.INTERNAL_REVIEW_INDEX)
      || containsNormalized(labelText, "internal review");
    console.log("qc:webhook:diagnostic", JSON.stringify({ isTaskStage, isQc1, isQc2, isQc3, matchesInternal }));

    try {
      // Determine task type and scope once
      let typeNormGlobal: string | undefined;
      try {
        const item = await fetchItemWithParentAndColumns(itemId);
        const t = TASK_TYPE ? getColumnText(item, TASK_TYPE) : undefined;
        typeNormGlobal = normalize(t);
      } catch {}
      const allowedSet = String(CFG.TASK_TYPES_ALLOWED_CSV || "").split(/[,\s]+/).map(normalize).filter(Boolean);
      const isCopyGlobal = typeNormGlobal === "copy";
      const inScope = !TASK_TYPE || (allowedSet.includes(typeNormGlobal || ""));

      if (!inScope) {
        console.log("qc:skip:out_of_scope_task_type", { itemId, typeNormGlobal, allowedSet });
        return textResponse("Ignored", 200);
      }

      // 0) When Task Stage becomes Completed -> reset all QC columns and clear Currently With
      if (isTaskStage && (
        matchesLabel(labelText, labelIndex, CFG.COMPLETED_LABEL, CFG.COMPLETED_INDEX) ||
        containsNormalized(labelText, "completed")
      )) {
        console.log("qc:completed:trigger", { itemId, columnId, labelText, labelIndex });
        await resetStatuses(boardId, itemId, [QC1, QC2, QC3]);
        await setMondayPeople(boardId, itemId, CURRENTLY_WITH, []);
        return textResponse("OK", 200);
      }

      // 1) When Task Stage becomes Internal Review -> start all QC in Review and assign full team
      if (isTaskStage && (
        matchesLabel(labelText, labelIndex, CFG.INTERNAL_REVIEW_LABEL, CFG.INTERNAL_REVIEW_INDEX) ||
        containsNormalized(labelText, "internal review")
      )) {
        console.log("qc:internal:trigger", { itemId, columnId, labelText, labelIndex });
        await logColumnsSnapshot(itemId, { TASK_STAGE, QC1, QC2, QC3, CURRENTLY_WITH, AIQC, TASK_TYPE });

        // Copy vs normal for Internal Review
        const isCopy = (typeNormGlobal === "copy");

        if (isCopy) {
          // Copy tasks: leave QC1 & QC2 blank, set QC3 to In Review, CW = Briefed By only
          await resetStatuses(boardId, itemId, [QC1, QC2]);
          await ensureStatus(boardId, itemId, QC3, CFG.STATUS_IN_REVIEW_LABEL);
          const briefed = await resolveParentPeopleByColumn(itemId, CFG.BRIEFED_BY_COLUMN_ID);
          await ensurePeople(boardId, itemId, CURRENTLY_WITH, briefed);
        } else {
          // Normal process for other task types
          await ensureStatus(boardId, itemId, QC1, CFG.STATUS_IN_REVIEW_LABEL);
          await ensureStatus(boardId, itemId, QC2, CFG.STATUS_IN_REVIEW_LABEL);
          await ensureStatus(boardId, itemId, QC3, CFG.STATUS_IN_REVIEW_LABEL);
          await recomputeCurrentlyWith(boardId, itemId, CURRENTLY_WITH, QC1, QC2, QC3);
        }

        await logColumnsSnapshot(itemId, { TASK_STAGE, QC1, QC2, QC3, CURRENTLY_WITH, AIQC, TASK_TYPE });
        return textResponse("OK", 200);
      }

      // 2) When QC1 changes
      if (isQc1) {
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_PASS_LABEL) || isPassLabel(labelText)) {
          // Q1 Pass: only remove copywriters from Currently With; do not change any QC statuses
          console.log("flow:qc1:pass", { itemId, labelIndex });
          await recomputeCurrentlyWith(boardId, itemId, CURRENTLY_WITH, QC1, QC2, QC3);
          await evaluateAndUpdateStage(boardId, itemId, TASK_STAGE, QC1, QC2, QC3, CURRENTLY_WITH, TASK_TYPE);
          return textResponse("OK", 200);
        }
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_REVERTS_LABEL) || isRevertsLabel(labelText)) {
          // Q1 Reverts: only remove copywriters; do not change QC2/QC3 statuses
          console.log("flow:qc1:reverts", { itemId, labelIndex });
          await recomputeCurrentlyWith(boardId, itemId, CURRENTLY_WITH, QC1, QC2, QC3);
          await evaluateAndUpdateStage(boardId, itemId, TASK_STAGE, QC1, QC2, QC3, CURRENTLY_WITH, TASK_TYPE);
          return textResponse("OK", 200);
        }
      }

      // 3) When QC2 changes
      if (isQc2) {
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_PASS_LABEL) || isPassLabel(labelText)) {
          // QC2 Pass: only remove Christine; do not change QC3
          console.log("flow:qc2:pass", { itemId, labelIndex });
          await recomputeCurrentlyWith(boardId, itemId, CURRENTLY_WITH, QC1, QC2, QC3);
          await evaluateAndUpdateStage(boardId, itemId, TASK_STAGE, QC1, QC2, QC3, CURRENTLY_WITH, TASK_TYPE);
          return textResponse("OK", 200);
        }
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_REVERTS_LABEL) || isRevertsLabel(labelText)) {
          // QC2 Reverts: only remove Christine; do not change other QC columns
          console.log("flow:qc2:reverts", { itemId, labelIndex });
          await recomputeCurrentlyWith(boardId, itemId, CURRENTLY_WITH, QC1, QC2, QC3);
          await evaluateAndUpdateStage(boardId, itemId, TASK_STAGE, QC1, QC2, QC3, CURRENTLY_WITH, TASK_TYPE);
          return textResponse("OK", 200);
        }
      }

      // 4) When QC3 changes -> handle Pass/Fail effects
      if (isQc3) {
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_REVERTS_LABEL) || isRevertsLabel(labelText)) {
          console.log("flow:qc3:reverts", { itemId });
          // Remove parent briefed-by person(s) from Currently With
          const briefed = await resolveParentPeopleByColumn(itemId, CFG.BRIEFED_BY_COLUMN_ID);
          if (briefed.length) await removePeopleFromCurrentlyWith(boardId, itemId, CURRENTLY_WITH, briefed);
          await recomputeCurrentlyWith(boardId, itemId, CURRENTLY_WITH, QC1, QC2, QC3);
          await evaluateAndUpdateStage(boardId, itemId, TASK_STAGE, QC1, QC2, QC3, CURRENTLY_WITH, TASK_TYPE);
          return textResponse("OK", 200);
        }
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_PASS_LABEL) || isPassLabel(labelText)) {
          console.log("flow:qc3:pass", { itemId });
          // On CS pass, remove parent briefed-by person(s) from Currently With
          const briefed = await resolveParentPeopleByColumn(itemId, CFG.BRIEFED_BY_COLUMN_ID);
          if (briefed.length) await removePeopleFromCurrentlyWith(boardId, itemId, CURRENTLY_WITH, briefed);
          await recomputeCurrentlyWith(boardId, itemId, CURRENTLY_WITH, QC1, QC2, QC3);
          await evaluateAndUpdateStage(boardId, itemId, TASK_STAGE, QC1, QC2, QC3, CURRENTLY_WITH, TASK_TYPE);
          return textResponse("OK", 200);
        }
      }

      return textResponse("Ignored", 200);
    } catch (e: any) {
      console.error("qc:webhook:error", { message: e?.message, stack: e?.stack });
      return textResponse("OK", 200); // avoid Monday retries
    }
  })) as any,
});

export default http;

// ---------- Helpers ----------
function textResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}
function jsonResponse(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
async function safeJson(req: Request): Promise<any> {
  // Try JSON; if that fails, try to find a challenge in the querystring
  try {
    return await req.json();
  } catch {
    try {
      const url = new URL(req.url);
      const ch = url.searchParams.get("challenge");
      if (ch) return { challenge: ch };
    } catch {}
    return null;
  }
}

async function resolveAiQcColumnId(boardId: number): Promise<string | undefined> {
  try {
    const q = `
      query ($ids: [ID!]) {
        boards (ids: $ids) {
          id
          name
          columns { id title type settings_str }
        }
      }
    `;
    const d: any = await mondayApi(q, { ids: [String(boardId)] });
    const board = (d as any)?.boards?.[0] ?? (d as any)?.data?.boards?.[0];
    const cols = (board?.columns ?? []) as any[];
    // Prefer a status/color column with a label named "AI QC" in settings_str
    for (const c of cols) {
      try {
        const settings = c?.settings_str ? JSON.parse(c.settings_str) : undefined;
        const labels: any = settings?.labels || settings?.labels_colors || settings?.labels_text || {};
        const values = Array.isArray(labels) ? labels.map((x) => x?.label || x?.text || x).filter(Boolean)
          : Object.values(labels || {});
        if (String(c?.type).includes("color") && values.find((v: any) => String(v).toLowerCase() === "ai qc")) {
          return String(c.id);
        }
      } catch {}
    }
    // Fallback: column title is "AI QC"
    const byTitle = cols.find((c: any) => String(c?.title || "").toLowerCase() === "ai qc");
    return byTitle?.id ? String(byTitle.id) : undefined;
  } catch (e: any) {
    console.log("aiqc:resolve:error", { message: e?.message });
    return undefined;
  }
}
function getLabelTextFromEvent(event: any): string | undefined {
  try {
    const v = typeof event.value === "string" ? JSON.parse(event.value) : event.value;
    return v?.label?.text || v?.label?.title || v?.label;
  } catch {
    return undefined;
  }
}
function getLabelIndexFromEvent(event: any): number | undefined {
  try {
    const v = typeof event.value === "string" ? JSON.parse(event.value) : event.value;
    const idx = v?.label?.index ?? v?.label?.id;
    return typeof idx === "number" ? idx : undefined;
  } catch {
    return undefined;
  }
}
function matchesLabel(text: string | undefined, index: number | undefined, wantText?: string, wantIndex?: number) {
  if (typeof wantIndex === "number" && typeof index === "number") return index === wantIndex;
  if (wantText && text) return String(text).toLowerCase() === String(wantText).toLowerCase();
  return false;
}
function numOrUndef(s: string | number | undefined | null) {
  if (s === undefined || s === null) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
function normalize(s: string | undefined) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function containsNormalized(s: string | undefined, needle: string) {
  const n1 = normalize(s);
  const n2 = normalize(needle);
  return !!n1 && !!n2 && n1.includes(n2);
}
function isPassLabel(s?: string) {
  return containsNormalized(s, "pass");
}
function isRevertsLabel(s?: string) {
  return containsNormalized(s, "reverts") || containsNormalized(s, "fail");
}
function preview(v: string, n = 80) {
  return v.length > n ? v.slice(0, n) + "…" : v;
}
function summarizeVars(variables?: Record<string, any>) {
  if (!variables) return undefined;
  const safe: Record<string, any> = { ...variables };
  if (typeof safe.value === "string") safe.value = preview(safe.value);
  return safe;
}

function uniquePeople(ids: number[]) {
  const s = new Set(ids.filter(Boolean));
  return Array.from(s);
}

async function logColumnsSnapshot(itemId: number, ids: { [k: string]: string | undefined }) {
  try {
    const item = await fetchItemWithParentAndColumns(itemId);
    const snapshot: Record<string, any> = {};
    for (const [name, id] of Object.entries(ids)) {
      if (!id) { snapshot[name] = null; continue; }
      snapshot[name] = getColumnText(item, id);
    }
    console.log("qc:snapshot", { itemId, snapshot });
  } catch (e: any) {
    console.log("qc:snapshot:error", { itemId, message: e?.message });
  }
}

type ResolvedColumns = {
  taskStageId?: string;
  qc1Id?: string;
  qc2Id?: string;
  qc3Id?: string;
  currentlyWithId?: string;
  aiQcId?: string;
  taskTypeId?: string;
};
async function resolveBoardColumns(boardId: number): Promise<ResolvedColumns> {
  try {
    const q = `
      query ($ids: [ID!]) {
        boards (ids: $ids) {
          id
          name
          columns { id title type settings_str }
        }
      }
    `;
    const d: any = await mondayApi(q, { ids: [String(boardId)] });
    const board = (d as any)?.boards?.[0] ?? (d as any)?.data?.boards?.[0];
    const cols = (board?.columns ?? []) as any[];
    const findByTitle = (t: string) => cols.find((c: any) => normalize(c?.title) === normalize(t))?.id as string | undefined;
    const findStatusByLabel = (label: string) => {
      for (const c of cols) {
        try {
          const settings = c?.settings_str ? JSON.parse(c.settings_str) : undefined;
          const labels: any = settings?.labels || settings?.labels_colors || settings?.labels_text || {};
          const values = Array.isArray(labels) ? labels.map((x) => x?.label || x?.text || x).filter(Boolean)
            : Object.values(labels || {});
          if (String(c?.type).includes("color") && values.find((v: any) => normalize(String(v)) === normalize(label))) {
            return String(c.id);
          }
        } catch {}
      }
      return undefined;
    };
    return {
      taskStageId: findByTitle("Task Stage") || findStatusByLabel("Internal Review"),
      qc1Id: findByTitle("QC 1 - Copy"),
      qc2Id: findByTitle("QC 2 - Design"),
      qc3Id: findByTitle("QC 3 - CS"),
      currentlyWithId: findByTitle("Currently With"),
      aiQcId: findByTitle("AI QC") || findStatusByLabel("AI QC"),
      taskTypeId: findByTitle("Task Type") || CFG.TASK_TYPE_COLUMN_ID,
    };
  } catch (e: any) {
    console.log("columns:resolve:error", { message: e?.message });
    return {};
  }
}

// ---------- Monday helpers ----------
const monday = mondaySdk();
if (process.env.MONDAY_API_TOKEN) monday.setToken(process.env.MONDAY_API_TOKEN);

async function mondayApi<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  if (!process.env.MONDAY_API_TOKEN) throw new Error("MONDAY_API_TOKEN is not set");
  try {
    const res = await monday.api(query, { variables });
    if ((res as any)?.errors) {
      console.error("monday:gql:errors", JSON.stringify((res as any).errors));
    }
    return (res as any).data ?? (res as any);
  } catch (e: any) {
    console.error("monday:gql:error", { message: e?.message, variables_summary: summarizeVars(variables) });
    throw e;
  }
}

async function setMondayColumnValue(boardId: number, itemId: number, columnId: string, value: string) {
  console.log("monday:setColumn", { boardId, itemId, columnId, value_preview: preview(value) });
  const m = `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }
  `;
  const r = await mondayApi(m, { boardId: String(boardId), itemId: String(itemId), columnId, value });
  console.log("monday:setColumn:ok", { columnId, itemId });
  return r;
}
async function setMondayStatus(boardId: number, itemId: number, columnId: string, label: string, index?: number) {
  const val = typeof index === "number" ? JSON.stringify({ index }) : JSON.stringify({ label });
  console.log("monday:setStatus", { columnId, label, index });
  await setMondayColumnValue(boardId, itemId, columnId, val);
}
async function resetStatuses(boardId: number, itemId: number, columnIds: string[]) {
  for (const c of columnIds) {
    console.log("monday:resetStatus", { columnId: c });
    await setMondayStatus(boardId, itemId, c, "");
  }
}

async function evaluateAndUpdateStage(boardId: number, itemId: number, TASK_STAGE: string, QC1: string, QC2: string, QC3: string, CURRENTLY_WITH?: string, TASK_TYPE?: string) {
  try {
    const item = await fetchItemWithParentAndColumns(itemId);
    const s1 = getColumnText(item, QC1);
    const s2 = getColumnText(item, QC2);
    const s3 = getColumnText(item, QC3);
    const typeText = TASK_TYPE ? getColumnText(item, TASK_TYPE) : undefined;
    const typeNorm = normalize(typeText);

    const inRev1 = containsNormalized(s1, "in review");
    const inRev2 = containsNormalized(s2, "in review");
    const inRev3 = containsNormalized(s3, "in review");

    const rev1 = isRevertsLabel(s1);
    const rev2 = isRevertsLabel(s2);
    const rev3 = isRevertsLabel(s3);

    const allPass = (typeNorm === "copy")
      ? isPassLabel(s3)
      : (isPassLabel(s1) && isPassLabel(s2) && isPassLabel(s3));
    const noneInReview = !inRev1 && !inRev2 && !inRev3;
    const anyReverts = rev1 || rev2 || rev3;

    console.log("qc:aggregate", { s1, s2, s3, inRev1, inRev2, inRev3, allPass, noneInReview, anyReverts });

    if (noneInReview && anyReverts) {
      // Move to Internal Reverts using label (avoid index mismatches)
      await ensureStatus(boardId, itemId, TASK_STAGE, CFG.INT_REVERTS_LABEL);
      return;
    }

    if (allPass) {
      // Set stage to Ready to Send and set Currently With to only Briefed By
      const label = CFG.READY_TO_SEND_LABEL;
      const idx = CFG.READY_TO_SEND_INDEX;
      if (label || typeof idx === "number") {
        await ensureStatus(boardId, itemId, TASK_STAGE, label || "", idx);
      }
      if (CURRENTLY_WITH) {
        const briefed = await resolveParentPeopleByColumn(itemId, CFG.BRIEFED_BY_COLUMN_ID);
        await ensurePeople(boardId, itemId, CURRENTLY_WITH, briefed);
      }
    }
  } catch (e: any) {
    console.log("qc:aggregate:error", { message: e?.message });
  }
}
async function setMondayPeople(boardId: number, itemId: number, columnId: string, personIds: number[]) {
  const personsAndTeams = personIds.filter(Boolean).map((id) => ({ id, kind: "person" }));
  const val = JSON.stringify({ personsAndTeams });
  console.log("monday:setPeople", { columnId, itemId, persons: personIds });
  await setMondayColumnValue(boardId, itemId, columnId, val);
}

async function fetchItemWithParentAndColumns(itemId: number | string) {
  const q = `
    query ($ids: [ID!]) {
      items (ids: $ids) {
        id
        name
        board { id name }
        group { id title }
        parent_item { id }
        column_values { id text value type }
      }
    }
  `;
  const data: any = await mondayApi(q, { ids: [String(itemId)] });
  return (data as any)?.items?.[0] ?? (data as any)?.data?.items?.[0];
}

function getColumn(item: any, columnId: string) {
  return (item?.column_values ?? []).find((c: any) => c.id === columnId);
}
function getColumnText(item: any, columnId: string): string | undefined {
  try {
    const cv = getColumn(item, columnId);
    if (!cv) return undefined;
    const v = typeof cv.value === "string" ? JSON.parse(cv.value) : cv.value;
    return v?.label?.text || cv.text;
  } catch { return undefined; }
}

async function ensureStatus(boardId: number, itemId: number, columnId: string, label: string, index?: number) {
  try {
    const item = await fetchItemWithParentAndColumns(itemId);
    const current = getColumnText(item, columnId);
    console.log("ensureStatus", { itemId, columnId, current, desired: label, index });
    if (current && current.toLowerCase() === label.toLowerCase()) return; // idempotent
  } catch (e: any) {
    console.log("ensureStatus:fetch:error", { message: e?.message });
  }
  await setMondayStatus(boardId, itemId, columnId, label, index);
}
async function ensurePeople(boardId: number, itemId: number, columnId: string, ids: number[]) {
  console.log("ensurePeople", { itemId, columnId, ids });
  await setMondayPeople(boardId, itemId, columnId, ids);
}
async function ensurePeopleUnion(boardId: number, itemId: number, columnId: string, idsToAdd: number[]) {
  const current = await getPeopleIds(boardId, itemId, columnId);
  const next = uniquePeople([...current, ...idsToAdd]);
  if (arraysEqual(current, next)) return;
  console.log("cw:add", { itemId, columnId, add: idsToAdd, next });
  await setMondayPeople(boardId, itemId, columnId, next);
}
async function removePeopleFromCurrentlyWith(boardId: number, itemId: number, columnId: string, idsToRemove: number[]) {
  const current = await getPeopleIds(boardId, itemId, columnId);
  const rm = new Set(idsToRemove);
  const next = current.filter((id) => !rm.has(id));
  if (arraysEqual(current, next)) return;
  console.log("cw:remove", { itemId, columnId, remove: idsToRemove, next });
  await setMondayPeople(boardId, itemId, columnId, next);
}
function arraysEqual(a: number[], b: number[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
async function recomputeCurrentlyWith(boardId: number, itemId: number, columnId: string, QC1: string, QC2: string, QC3: string) {
  try {
    const item = await fetchItemWithParentAndColumns(itemId);
    const s1 = getColumnText(item, QC1);
    const s2 = getColumnText(item, QC2);
    const s3 = getColumnText(item, QC3);
    const briefed = await resolveParentPeopleByColumn(itemId, CFG.BRIEFED_BY_COLUMN_ID);
    const ids: number[] = [];
    if (containsNormalized(s1, "in review")) ids.push(CFG.PERSON_CAROLINE, CFG.PERSON_LUSANDA);
    if (containsNormalized(s2, "in review")) ids.push(CFG.PERSON_CHRISTINE);
    if (containsNormalized(s3, "in review")) ids.push(...briefed);
    const desired = uniquePeople(ids);
    const current = await getPeopleIds(boardId, itemId, columnId);
    if (arraysEqual(current, desired)) return;
    console.log("cw:recompute", { itemId, desired });
    await setMondayPeople(boardId, itemId, columnId, desired);
  } catch (e: any) {
    console.log("cw:recompute:error", { message: e?.message });
  }
}
async function getPeopleIds(boardId: number, itemId: number, columnId: string): Promise<number[]> {
  try {
    const item = await fetchItemWithParentAndColumns(itemId);
    const cv = getColumn(item, columnId);
    const v = typeof cv?.value === "string" ? JSON.parse(cv.value) : cv?.value;
    const pts = (v?.personsAndTeams ?? []).filter((p: any) => p?.kind === "person").map((p: any) => Number(p.id)).filter(Boolean);
    return pts;
  } catch {
    return [];
  }
}

async function resolveJobBagOwnerPeople(itemId: number): Promise<number[]> {
  // If this is a subitem, Monday provides parent_item via GraphQL; fallback to event fields if needed
  const item = await fetchItemWithParentAndColumns(itemId);
  const parentId = item?.parent_item?.id ? Number(item.parent_item.id) : undefined;
  const targetItemId = parentId || itemId;

  const ownerItem = targetItemId === itemId ? item : await fetchItemWithParentAndColumns(targetItemId);
  const ownerCv = getColumn(ownerItem, CFG.JOB_BAG_OWNER_COLUMN_ID);
  try {
    const v = typeof ownerCv?.value === "string" ? JSON.parse(ownerCv.value) : ownerCv?.value;
    const persons = (v?.personsAndTeams ?? []).filter((p: any) => p?.kind === "person").map((p: any) => Number(p.id)).filter(Boolean);
    return persons;
  } catch {
    return [];
  }
}
async function resolveParentPeopleByColumn(itemId: number, columnId?: string): Promise<number[]> {
  if (!columnId) return [];
  try {
    const child = await fetchItemWithParentAndColumns(itemId);
    const parentId = child?.parent_item?.id ? Number(child.parent_item.id) : undefined;
    if (!parentId) return [];
    const parent = await fetchItemWithParentAndColumns(parentId);
    const cv = getColumn(parent, columnId);
    const v = typeof cv?.value === "string" ? JSON.parse(cv.value) : cv?.value;
    const persons = (v?.personsAndTeams ?? []).filter((p: any) => p?.kind === "person").map((p: any) => Number(p.id)).filter(Boolean);
    return persons;
  } catch {
    return [];
  }
}
