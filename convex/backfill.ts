import { action } from "./_generated/server";
import mondaySdk from "monday-sdk-js";

// Backfill action: For the Testing group only, find items with Task Stage = Internal Review
// and set QC1/QC2/QC3 = In Review and set Currently With = {Christine, Caroline, Lusanda} ∪ Briefed By

const CFG = {
  TARGET_BOARD_ID: numOrUndef(process.env.MONDAY_TARGET_BOARD_ID),
  TEST_GROUP_ID: process.env.MONDAY_TEST_GROUP_ID || "group_mktsne0w",

  TASK_STAGE_COLUMN_ID: process.env.MONDAY_TASK_STAGE_COLUMN_ID || "status1",
  QC1_COLUMN_ID: process.env.MONDAY_QC1_COLUMN_ID || "color_mkwzfjx8",
  QC2_COLUMN_ID: process.env.MONDAY_QC2_COLUMN_ID || "color_mkx4wfdz",
  QC3_COLUMN_ID: process.env.MONDAY_QC3_COLUMN_ID || "color_mkx4rwcm",
  CURRENTLY_WITH_COLUMN_ID: process.env.MONDAY_CURRENTLY_WITH_COLUMN_ID || "multiple_person_mkwzxjqy",
  BRIEFED_BY_COLUMN_ID: process.env.MONDAY_BRIEFED_BY_COLUMN_ID,

  STATUS_IN_REVIEW_LABEL: process.env.MONDAY_STATUS_IN_REVIEW_LABEL || "In Review",

  PERSON_CHRISTINE: Number(process.env.MONDAY_PERSON_CHRISTINE || 77673213),
  PERSON_CAROLINE: Number(process.env.MONDAY_PERSON_CAROLINE || 70707376),
  PERSON_LUSANDA: Number(process.env.MONDAY_PERSON_LUSANDA || 77846388),
};

const monday = mondaySdk();
if (process.env.MONDAY_API_TOKEN) monday.setToken(process.env.MONDAY_API_TOKEN);

export const backfillTestGroup = action(async (_ctx, args: { boardId?: number; dryRun?: boolean; pageSize?: number } = {}) => {
  const boardId = Number(args?.boardId ?? CFG.TARGET_BOARD_ID);
  const dryRun = !!args?.dryRun;
  const pageSize = Number(args?.pageSize ?? 100);
  if (!boardId || Number.isNaN(boardId)) throw new Error("boardId is required (set MONDAY_TARGET_BOARD_ID or pass boardId)");

  console.log("backfill:start", { boardId, groupId: CFG.TEST_GROUP_ID, dryRun, pageSize });

  let cursor: string | undefined;
  let updated = 0;
  let scanned = 0;

while (true) {
    // Fetch only parent items in the Testing group, then operate on their subitems
    const page = await listParentItemsInGroup(boardId, CFG.TEST_GROUP_ID, pageSize, cursor);
    const parents = page.items || [];
    cursor = page.cursor || undefined;

    for (const parent of parents) {
      const subitems = await fetchSubitemsForParent(parent.id);
      for (const it of subitems) {
        scanned++;
        const ts = getColumnText(it, CFG.TASK_STAGE_COLUMN_ID);
        if (!containsNormalized(ts, "internal review")) continue;

      const qc1 = getColumnText(it, CFG.QC1_COLUMN_ID);
      const qc2 = getColumnText(it, CFG.QC2_COLUMN_ID);
      const qc3 = getColumnText(it, CFG.QC3_COLUMN_ID);

      const needsQc1 = !containsNormalized(qc1, CFG.STATUS_IN_REVIEW_LABEL);
      const needsQc2 = !containsNormalized(qc2, CFG.STATUS_IN_REVIEW_LABEL);
      const needsQc3 = !containsNormalized(qc3, CFG.STATUS_IN_REVIEW_LABEL);

      const briefed = await resolveParentPeopleByColumn(it.id, CFG.BRIEFED_BY_COLUMN_ID);
      const team = uniquePeople([CFG.PERSON_CHRISTINE, CFG.PERSON_CAROLINE, CFG.PERSON_LUSANDA, ...briefed]);

      console.log("backfill:item", { id: it.id, name: it.name, needsQc1, needsQc2, needsQc3, team });

      if (!dryRun) {
        if (needsQc1) await setMondayStatus(Number(it.board?.id || boardId), Number(it.id), CFG.QC1_COLUMN_ID, CFG.STATUS_IN_REVIEW_LABEL);
        if (needsQc2) await setMondayStatus(Number(it.board?.id || boardId), Number(it.id), CFG.QC2_COLUMN_ID, CFG.STATUS_IN_REVIEW_LABEL);
        if (needsQc3) await setMondayStatus(Number(it.board?.id || boardId), Number(it.id), CFG.QC3_COLUMN_ID, CFG.STATUS_IN_REVIEW_LABEL);
        await setMondayPeople(Number(it.board?.id || boardId), Number(it.id), CFG.CURRENTLY_WITH_COLUMN_ID, team);
      }

        updated++;
        await delay(150);
      }
    }

    if (!cursor) break;
  }

  console.log("backfill:done", { scanned, updated, dryRun });
  return { scanned, updated, dryRun };
});

// Helpers
async function listParentItemsInGroup(boardId: number, groupId: string, limit = 100, cursor?: string): Promise<{items: any[]; cursor?: string}> {
  const q = `
    query ($boardId: [ID!], $groupIds: [String!], $limit: Int, $cursor: String) {
      boards (ids: $boardId) {
        groups (ids: $groupIds) {
          id
          title
          items_page (limit: $limit, cursor: $cursor) {
            cursor
            items { id name group { id title } board { id name } }
          }
        }
      }
    }
  `;
  const d: any = await mondayApi(q, { boardId: [String(boardId)], groupIds: [groupId], limit, cursor });
  const grp = d?.boards?.[0]?.groups?.[0] ?? d?.data?.boards?.[0]?.groups?.[0] ?? {};
  const page = grp?.items_page ?? {};
  return { items: page.items ?? [], cursor: page.cursor ?? undefined };
}

async function fetchSubitemsForParent(parentId: string | number): Promise<any[]> {
  const q = `
    query ($ids: [ID!]) {
      items (ids: $ids) {
        id
        subitems { id name board { id name } column_values { id text value type } parent_item { id } }
      }
    }
  `;
  const d: any = await mondayApi(q, { ids: [String(parentId)] });
  const parent = d?.items?.[0] ?? d?.data?.items?.[0];
  return parent?.subitems ?? [];
}

async function fetchParentForSubitem(subId: string | number): Promise<any | undefined> {
  try {
    const q = `
      query ($ids: [ID!]) {
        items (ids: $ids) { id parent_item { id } }
      }
    `;
    const d: any = await mondayApi(q, { ids: [String(subId)] });
    const sub = d?.items?.[0] ?? d?.data?.items?.[0];
    const pid = sub?.parent_item?.id;
    if (!pid) return undefined;
    const q2 = `
      query ($ids: [ID!]) { items (ids: $ids) { id group { id title } board { id name } } }
    `;
    const d2: any = await mondayApi(q2, { ids: [String(pid)] });
    return d2?.items?.[0] ?? d2?.data?.items?.[0];
  } catch { return undefined; }
}

async function mondayApi<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
  if (!process.env.MONDAY_API_TOKEN) throw new Error("MONDAY_API_TOKEN is not set");
  const res = await monday.api(query, { variables });
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

async function resolveParentPeopleByColumn(itemId: number | string, columnId?: string): Promise<number[]> {
  if (!columnId) return [];
  try {
    const item = await fetchItemWithParentAndColumns(itemId);
    const parentId = item?.parent_item?.id ? Number(item.parent_item.id) : undefined;
    if (!parentId) return [];
    const parent = await fetchItemWithParentAndColumns(parentId);
    const cv = getColumn(parent, columnId);
    const v = typeof cv?.value === "string" ? JSON.parse(cv.value) : cv?.value;
    const persons = (v?.personsAndTeams ?? []).filter((p: any) => p?.kind === "person").map((p: any) => Number(p.id)).filter(Boolean);
    return persons;
  } catch { return []; }
}

async function fetchItemWithParentAndColumns(itemId: number | string) {
  const q = `
    query ($ids: [ID!]) {
      items (ids: $ids) {
        id name
        parent_item { id }
        group { id title }
        board { id name }
        column_values { id text value type }
      }
    }
  `;
  const d: any = await mondayApi(q, { ids: [String(itemId)] });
  return d?.items?.[0] ?? d?.data?.items?.[0];
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

function uniquePeople(ids: number[]) {
  const s = new Set(ids.filter(Boolean));
  return Array.from(s);
}
function numOrUndef(s: string | number | undefined | null) {
  if (s === undefined || s === null) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
function containsNormalized(s: string | undefined, needle: string) {
  const n1 = String(s || "").toLowerCase();
  const n2 = String(needle || "").toLowerCase();
  return !!n1 && !!n2 && n1.includes(n2);
}
function delay(ms: number) { return new Promise(res => setTimeout(res, ms)); }
