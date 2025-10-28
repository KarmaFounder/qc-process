import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import mondaySdk from "monday-sdk-js";

// Environment-configurable IDs and labels (defaults provided from your board snippet)
const CFG = {
  TARGET_BOARD_ID: numOrUndef(process.env.MONDAY_TARGET_BOARD_ID),

  // Columns
  TASK_STAGE_COLUMN_ID: process.env.MONDAY_TASK_STAGE_COLUMN_ID || "status", // replace with actual id if known
  QC1_COLUMN_ID: process.env.MONDAY_QC1_COLUMN_ID || "color_mkwzfjx8",
  QC2_COLUMN_ID: process.env.MONDAY_QC2_COLUMN_ID || "color_mkx4wfdz",
  QC3_COLUMN_ID: process.env.MONDAY_QC3_COLUMN_ID || "color_mkx4rwcm",
  CURRENTLY_WITH_COLUMN_ID: process.env.MONDAY_CURRENTLY_WITH_COLUMN_ID || "multiple_person_mkwzxjqy",
  AI_QC_COLUMN_ID: process.env.MONDAY_AI_QC_COLUMN_ID || undefined, // set this via env
  JOB_BAG_OWNER_COLUMN_ID: process.env.MONDAY_JOB_BAG_OWNER_COLUMN_ID || "person", // set exact id via env

  // Labels / indices
  INTERNAL_REVIEW_LABEL: process.env.MONDAY_INTERNAL_REVIEW_LABEL || "Internal Review",
  INTERNAL_REVIEW_INDEX: numOrUndef(process.env.MONDAY_INTERNAL_REVIEW_INDEX),
  INT_REVERTS_LABEL: process.env.MONDAY_INT_REVERTS_LABEL || "6. Int. Reverts",
  INT_REVERTS_INDEX: numOrUndef(process.env.MONDAY_INT_REVERTS_INDEX) ?? 8,

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
};

const http = httpRouter();

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

    const inTargetBoard = CFG.TARGET_BOARD_ID ? (boardId === CFG.TARGET_BOARD_ID) : true;

    console.log("qc:webhook:event", JSON.stringify({
      boardId, itemId, columnId, labelText, labelIndex
    }));

    if (!inTargetBoard || !itemId) return textResponse("Ignored", 200);

    try {
      // 1) When Task Stage becomes Internal Review -> start Copy QC
      if (columnId === CFG.TASK_STAGE_COLUMN_ID && matchesLabel(labelText, labelIndex, CFG.INTERNAL_REVIEW_LABEL, CFG.INTERNAL_REVIEW_INDEX)) {
        await ensureStatus(boardId, itemId, CFG.QC1_COLUMN_ID, CFG.STATUS_IN_REVIEW_LABEL);
        await ensurePeople(boardId, itemId, CFG.CURRENTLY_WITH_COLUMN_ID, [CFG.PERSON_CAROLINE, CFG.PERSON_LUSANDA]);
        if (CFG.AI_QC_COLUMN_ID) {
          await ensureStatus(boardId, itemId, CFG.AI_QC_COLUMN_ID, CFG.AI_QC_TRIGGER_LABEL, CFG.AI_QC_TRIGGER_INDEX);
        }
        return textResponse("OK", 200);
      }

      // 2) When QC1 changes
      if (columnId === CFG.QC1_COLUMN_ID) {
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_PASS_LABEL)) {
          // QC1 Pass -> set QC2 In Review and assign Christine
          await ensureStatus(boardId, itemId, CFG.QC2_COLUMN_ID, CFG.STATUS_IN_REVIEW_LABEL);
          await ensurePeople(boardId, itemId, CFG.CURRENTLY_WITH_COLUMN_ID, [CFG.PERSON_CHRISTINE]);
          return textResponse("OK", 200);
        }
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_REVERTS_LABEL)) {
          await ensureStatus(boardId, itemId, CFG.TASK_STAGE_COLUMN_ID, CFG.INT_REVERTS_LABEL, CFG.INT_REVERTS_INDEX);
          return textResponse("OK", 200);
        }
      }

      // 3) When QC2 changes
      if (columnId === CFG.QC2_COLUMN_ID) {
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_PASS_LABEL)) {
          // QC2 Pass -> set QC3 In Review and assign job bag owner (from parent item)
          await ensureStatus(boardId, itemId, CFG.QC3_COLUMN_ID, CFG.STATUS_IN_REVIEW_LABEL);
          const ownerIds = await resolveJobBagOwnerPeople(itemId);
          if (ownerIds.length) {
            await ensurePeople(boardId, itemId, CFG.CURRENTLY_WITH_COLUMN_ID, ownerIds);
          }
          return textResponse("OK", 200);
        }
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_REVERTS_LABEL)) {
          await ensureStatus(boardId, itemId, CFG.TASK_STAGE_COLUMN_ID, CFG.INT_REVERTS_LABEL, CFG.INT_REVERTS_INDEX);
          return textResponse("OK", 200);
        }
      }

      // 4) When QC3 changes -> failures set Int. Reverts
      if (columnId === CFG.QC3_COLUMN_ID) {
        if (matchesLabel(labelText, labelIndex, CFG.STATUS_REVERTS_LABEL)) {
          await ensureStatus(boardId, itemId, CFG.TASK_STAGE_COLUMN_ID, CFG.INT_REVERTS_LABEL, CFG.INT_REVERTS_INDEX);
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
  try {
    return await req.json();
  } catch {
    return null;
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

// ---------- Monday helpers ----------
const monday = mondaySdk();
if (process.env.MONDAY_API_TOKEN) monday.setToken(process.env.MONDAY_API_TOKEN);

async function mondayApi<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  if (!process.env.MONDAY_API_TOKEN) throw new Error("MONDAY_API_TOKEN is not set");
  const res = await monday.api(query, { variables });
  if ((res as any)?.errors) {
    console.error("monday:gql:errors", JSON.stringify((res as any).errors));
  }
  return (res as any).data ?? (res as any);
}

async function setMondayColumnValue(boardId: number, itemId: number, columnId: string, value: string) {
  const m = `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }
  `;
  await mondayApi(m, { boardId: String(boardId), itemId: String(itemId), columnId, value });
}
async function setMondayStatus(boardId: number, itemId: number, columnId: string, label: string, index?: number) {
  const val = typeof index === "number" ? JSON.stringify({ index }) : JSON.stringify({ label });
  await setMondayColumnValue(boardId, itemId, columnId, val);
}
async function setMondayPeople(boardId: number, itemId: number, columnId: string, personIds: number[]) {
  const personsAndTeams = personIds.filter(Boolean).map((id) => ({ id, kind: "person" }));
  const val = JSON.stringify({ personsAndTeams });
  await setMondayColumnValue(boardId, itemId, columnId, val);
}

async function fetchItemWithParentAndColumns(itemId: number | string) {
  const q = `
    query ($ids: [ID!]) {
      items (ids: $ids) {
        id
        name
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
    if (current && current.toLowerCase() === label.toLowerCase()) return; // idempotent
  } catch {}
  await setMondayStatus(boardId, itemId, columnId, label, index);
}
async function ensurePeople(boardId: number, itemId: number, columnId: string, ids: number[]) {
  await setMondayPeople(boardId, itemId, columnId, ids);
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
