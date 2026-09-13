const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3019);
const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "data", "db.json");

const initialData = {
  tunes: [
    {
      id: "tune_demo",
      title: "雨后圆舞曲",
      composer: "匿名",
      stripSpec: {
        widthMm: 70,
        scale: "20音",
        tempoBpm: 82,
        paperType: "半透明纸带"
      },
      createdAt: new Date().toISOString()
    }
  ],
  sections: [
    {
      id: "section_demo_1",
      tuneId: "tune_demo",
      startBeat: 1,
      endBeat: 32,
      laneRange: "1-10",
      checked: true,
      note: "开头主题已试奏"
    },
    {
      id: "section_demo_2",
      tuneId: "tune_demo",
      startBeat: 33,
      endBeat: 64,
      laneRange: "4-18",
      checked: false,
      note: "副歌段等待校对"
    }
  ],
  issues: [
    {
      id: "issue_demo",
      tuneId: "tune_demo",
      sectionId: "section_demo_2",
      type: "漏孔",
      beat: 41,
      lane: 12,
      description: "第41拍高音孔漏打",
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    }
  ]
};

const routes = [
  "GET /health",
  "GET /tunes",
  "POST /tunes",
  "GET /tunes/:id/progress",
  "GET /tunes/:id/sections",
  "POST /tunes/:id/sections",
  "GET /tunes/:id/unchecked-sections",
  "GET /tunes/:id/publications",
  "POST /tunes/:id/publications",
  "PATCH /sections/:id/check",
  "GET /issues",
  "POST /issues",
  "PATCH /issues/:id/status",
  "GET /publications",
  "GET /publications/diff",
  "GET /publications/:id",
  "POST /publications/:id/dispatch",
  "POST /publications/:id/receipts",
  "GET /reworks",
  "POST /reworks/:id/complete",
  "POST /receipts/offline",
  "GET /receipts/offline/:pubNo",
  "GET /receipts/merge/:pubNo",
  "POST /receipts/merge/:pubNo/resolve"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  const db = JSON.parse(await readFile(DB_FILE, "utf8"));
  // 冲孔发布闭环新增的集合；旧数据文件自动补齐
  db.publications = db.publications || [];
  db.dispatches = db.dispatches || [];
  db.reworkOrders = db.reworkOrders || [];
  db.offlineReceipts = db.offlineReceipts || [];
  db.mergedReceipts = db.mergedReceipts || [];
  return db;
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return { pathname: url.pathname, searchParams: url.searchParams };
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findTune(db, tuneId) {
  const tune = db.tunes.find((item) => item.id === tuneId);
  if (!tune) {
    const error = new Error("曲目不存在");
    error.status = 404;
    throw error;
  }
  return tune;
}

function buildProgress(db, tuneId) {
  findTune(db, tuneId);
  const sections = db.sections.filter((item) => item.tuneId === tuneId);
  const issues = db.issues.filter((item) => item.tuneId === tuneId);
  const checkedCount = sections.filter((item) => item.checked).length;
  const openIssues = issues.filter((item) => item.status !== "resolved").length;
  return {
    tuneId,
    totalSections: sections.length,
    checkedSections: checkedCount,
    uncheckedSections: sections.length - checkedCount,
    openIssues,
    resolvedIssues: issues.length - openIssues,
    percent: sections.length ? Math.round((checkedCount / sections.length) * 100) : 0
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseLaneRange(laneRange) {
  // 支持 "1-10" 与逗号混合，如 "1-3,5,7-9"
  const lanes = new Set();
  for (const part of String(laneRange).split(",")) {
    const range = part.trim();
    if (!range) continue;
    const match = range.match(/^(\d+)\s*-\s*(\d+)$/);
    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      for (let lane = start; lane <= end; lane++) lanes.add(lane);
    } else if (/^\d+$/.test(range)) {
      lanes.add(Number(range));
    }
  }
  return lanes;
}

function checkedSectionsFor(db, tuneId) {
  return db.sections
    .filter((item) => item.tuneId === tuneId && item.checked)
    .sort((a, b) => a.startBeat - b.startBeat);
}

function buildPublicationSnapshot(db, tuneId, body) {
  findTune(db, tuneId);
  const sections = checkedSectionsFor(db, tuneId);
  if (!sections.length) throw httpError(400, "没有已检查区间，无法建版");

  if (!Array.isArray(body.holes) || !body.holes.length) {
    throw httpError(400, "缺少字段：holes（至少一个孔）");
  }

  const laneMap = new Map();
  sections.forEach((section) => laneMap.set(section.id, parseLaneRange(section.laneRange)));

  const holes = [];
  const seen = new Set();
  for (const raw of body.holes) {
    const beat = Number(raw && raw.beat);
    const lane = Number(raw && raw.lane);
    if (!Number.isInteger(beat) || beat <= 0 || !Number.isInteger(lane) || lane <= 0) {
      throw httpError(400, `非法孔位：${JSON.stringify(raw)}（beat/lane 必须为正整数）`);
    }
    const owner = sections.find((section) => beat >= section.startBeat && beat <= section.endBeat);
    if (!owner) throw httpError(400, `第${beat}拍不在任何已检查区间内`);
    if (!laneMap.get(owner.id).has(lane)) {
      throw httpError(400, `第${beat}拍第${lane}轨超出区间 ${owner.id} 的轨位范围 ${owner.laneRange}`);
    }
    const key = `${beat}:${lane}`;
    if (seen.has(key)) throw httpError(400, `重复孔位：第${beat}拍第${lane}轨`);
    seen.add(key);
    holes.push({ beat, lane });
  }
  holes.sort((a, b) => a.beat - b.beat || a.lane - b.lane);

  const tune = db.tunes.find((item) => item.id === tuneId);
  const mmPerBeat = body.mmPerBeat === undefined ? 25 : Number(body.mmPerBeat);
  if (!(mmPerBeat > 0)) throw httpError(400, "mmPerBeat 必须为正数");
  const maxBeat = holes.reduce((max, hole) => Math.max(max, hole.beat), 0);
  const endBeat = sections[sections.length - 1].endBeat;
  const tapeLengthMm =
    body.tapeLengthMm === undefined
      ? Math.max(maxBeat, endBeat) * mmPerBeat
      : Number(body.tapeLengthMm);
  if (!(tapeLengthMm > 0)) throw httpError(400, "tapeLengthMm 必须为正数");

  const tempoBpm = body.tempoBpm === undefined ? tune.stripSpec.tempoBpm : Number(body.tempoBpm);
  const paperType = body.paperType || tune.stripSpec.paperType;

  const sectionSnapshot = sections.map((section) => ({
    id: section.id,
    startBeat: section.startBeat,
    endBeat: section.endBeat,
    laneRange: section.laneRange,
    note: section.note
  }));

  // 问题处理快照：建版时刻问题的状态被冻结进发布版
  const issueSnapshot = db.issues
    .filter((issue) => issue.tuneId === tuneId)
    .map((issue) => ({
      id: issue.id,
      sectionId: issue.sectionId,
      type: issue.type,
      beat: issue.beat,
      lane: issue.lane,
      description: issue.description,
      status: issue.status
    }));

  return {
    holes,
    mmPerBeat,
    expected: { holeCount: holes.length, offsetMm: 0, tapeLengthMm },
    tolerances: {
      offsetMm: body.toleranceOffsetMm === undefined ? 2 : Number(body.toleranceOffsetMm),
      tapeLengthMm: body.toleranceTapeLengthMm === undefined ? 5 : Number(body.toleranceTapeLengthMm)
    },
    tempoBpm,
    paperType,
    sectionSnapshot,
    issueSnapshot
  };
}

function publicationStatus(publication) {
  if (publication.acceptance) return publication.acceptance.result; // accepted | rejected
  if (publication.dispatch) return "dispatched";
  return "built";
}

// 派发/接收后旧版内容只读（rejected 仍可被后继引用，但不可再操作）
function assertPublicationWritable(publication) {
  const status = publicationStatus(publication);
  if (status !== "built") {
    throw httpError(409, `发布版当前状态为 ${status}，为只读不可变版本`);
  }
}

function findPublication(db, id) {
  const publication = db.publications.find((item) => item.id === id);
  if (!publication) throw httpError(404, "发布版不存在");
  return publication;
}

function findPublicationByPubNo(db, pubNo) {
  const dispatch = db.dispatches.find((item) => item.pubNo === pubNo);
  if (!dispatch) return null;
  return db.publications.find((item) => item.id === dispatch.publicationId) || null;
}

function diffHoles(from, to) {
  const key = (hole) => `${hole.beat}:${hole.lane}`;
  const fromMap = new Map(from.holes.map((hole) => [key(hole), hole]));
  const toMap = new Map(to.holes.map((hole) => [key(hole), hole]));
  return {
    fromHoleCount: from.holes.length,
    toHoleCount: to.holes.length,
    holeCountDelta: to.holes.length - from.holes.length,
    added: to.holes.filter((hole) => !fromMap.has(key(hole))),
    removed: from.holes.filter((hole) => !toMap.has(key(hole)))
  };
}

function diffIssueHandling(from, to) {
  const fromMap = new Map(from.issueSnapshot.map((issue) => [issue.id, issue]));
  const toMap = new Map(to.issueSnapshot.map((issue) => [issue.id, issue]));
  const added = [];
  const resolved = [];
  const reopened = [];
  const unchanged = [];
  for (const [id, issueTo] of toMap) {
    const issueFrom = fromMap.get(id);
    if (!issueFrom) {
      added.push({ id, type: issueTo.type, status: issueTo.status, description: issueTo.description });
    } else if (issueFrom.status !== issueTo.status) {
      const entry = { id, type: issueTo.type, fromStatus: issueFrom.status, toStatus: issueTo.status };
      if (issueTo.status === "resolved") resolved.push(entry);
      else reopened.push(entry);
    } else {
      unchanged.push(id);
    }
  }
  const removed = [...fromMap.keys()].filter((id) => !toMap.has(id));
  return { added, resolved, reopened, removed, unchangedCount: unchanged.length };
}

function buildDiff(db, fromId, toId) {
  const from = findPublication(db, fromId);
  const to = findPublication(db, toId);
  if (from.tuneId !== to.tuneId) throw httpError(400, "只能比较同一曲目的两个发布版");
  const sectionIdsFrom = new Set(from.sectionSnapshot.map((section) => section.id));
  const sectionIdsTo = new Set(to.sectionSnapshot.map((section) => section.id));
  return {
    tuneId: from.tuneId,
    from: { publicationId: from.id, version: from.version, pubNo: from.dispatch && from.dispatch.pubNo },
    to: { publicationId: to.id, version: to.version, pubNo: to.dispatch && to.dispatch.pubNo },
    tempo: {
      fromBpm: from.tempoBpm,
      toBpm: to.tempoBpm,
      changed: from.tempoBpm !== to.tempoBpm,
      deltaBpm: to.tempoBpm - from.tempoBpm
    },
    paperType: {
      from: from.paperType,
      to: to.paperType,
      changed: from.paperType !== to.paperType
    },
    holes: diffHoles(from, to),
    sections: {
      added: to.sectionSnapshot.filter((section) => !sectionIdsFrom.has(section.id)),
      removed: from.sectionSnapshot.filter((section) => !sectionIdsTo.has(section.id))
    },
    issueHandling: diffIssueHandling(from, to)
  };
}

function evaluateReceipt(publication, receipt) {
  const mismatches = [];
  const expected = publication.expected;
  const tolerances = publication.tolerances;
  if (receipt.holeCount !== expected.holeCount) {
    mismatches.push({
      field: "holeCount",
      expected: expected.holeCount,
      actual: receipt.holeCount
    });
  }
  if (Math.abs(receipt.offsetMm - expected.offsetMm) > tolerances.offsetMm) {
    mismatches.push({
      field: "offsetMm",
      expected: expected.offsetMm,
      actual: receipt.offsetMm,
      toleranceMm: tolerances.offsetMm
    });
  }
  if (Math.abs(receipt.tapeLengthMm - expected.tapeLengthMm) > tolerances.tapeLengthMm) {
    mismatches.push({
      field: "tapeLengthMm",
      expected: expected.tapeLengthMm,
      actual: receipt.tapeLengthMm,
      toleranceMm: tolerances.tapeLengthMm
    });
  }
  return mismatches;
}

function responsibleSections(publication, mismatchFields) {
  const sections = publication.sectionSnapshot;
  const fields = new Set(mismatchFields);
  const ids = new Set();
  if (fields.has("holeCount")) sections.forEach((section) => ids.add(section.id));
  if (fields.has("offsetMm") && sections[0]) ids.add(sections[0].id);
  if (fields.has("tapeLengthMm") && sections[sections.length - 1]) ids.add(sections[sections.length - 1].id);
  return sections.filter((section) => ids.has(section.id));
}

function recordAcceptance(db, publication, receipt, mismatches, source) {
  if (!mismatches.length) {
    publication.acceptance = {
      result: "accepted",
      source,
      receipt,
      at: new Date().toISOString()
    };
    return { result: "accepted", mismatches: [], reworkOrder: null };
  }
  const reworkOrder = {
    id: makeId("rework"),
    publicationId: publication.id,
    tuneId: publication.tuneId,
    version: publication.version,
    pubNo: publication.dispatch && publication.dispatch.pubNo,
    source,
    receipt,
    mismatches,
    responsibleSectionIds: responsibleSections(publication, mismatches.map((item) => item.field)).map(
      (section) => section.id
    ),
    responsibleSections: responsibleSections(publication, mismatches.map((item) => item.field)),
    status: "open",
    createdAt: new Date().toISOString(),
    completedAt: null
  };
  db.reworkOrders.push(reworkOrder);
  publication.acceptance = {
    result: "rejected",
    source,
    receipt,
    reworkOrderId: reworkOrder.id,
    at: new Date().toISOString()
  };
  publication.superseded = true; // 验收失败，旧版冻结，只能用新版本重试
  return { result: "rejected", mismatches, reworkOrder };
}

function mergeOfflineReceipts(pubNo, receipts) {
  const [a, b] = receipts;
  const fields = ["holeCount", "offsetMm", "tapeLengthMm"];
  const merged = { pubNo };
  const fieldReports = [];
  const conflictFields = [];
  for (const field of fields) {
    const valueA = a.receipt[field];
    const valueB = b.receipt[field];
    const agree = valueA === valueB;
    fieldReports.push({ field, values: [valueA, valueB], agree });
    merged[field] = agree ? valueA : null;
    if (!agree) conflictFields.push(field);
  }
  const machineIdAgree = a.machineId === b.machineId;
  fieldReports.push({ field: "machineId", values: [a.machineId, b.machineId], agree: machineIdAgree });
  merged.machineId = machineIdAgree ? a.machineId : null;
  if (!machineIdAgree) conflictFields.push("machineId");
  return {
    pubNo,
    status: conflictFields.length ? "conflict" : "ready",
    conflictFields,
    fieldReports,
    mergedReceipt: merged,
    sources: receipts.map((item) => ({
      source: item.source,
      machineId: item.machineId,
      receivedAt: item.receivedAt
    })),
    resolution: null
  };
}

async function handle(req, res) {
  const { pathname, searchParams } = parseUrl(req);
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "organ-strip-punch-api", routes });
  }

  if (req.method === "GET" && pathname === "/tunes") {
    const tunes = db.tunes.map((tune) => ({ ...tune, progress: buildProgress(db, tune.id) }));
    return send(res, 200, { data: tunes });
  }

  if (req.method === "POST" && pathname === "/tunes") {
    const body = await parseBody(req);
    required(body, ["title", "stripSpec"]);
    const tune = {
      id: makeId("tune"),
      title: body.title,
      composer: body.composer || "",
      stripSpec: body.stripSpec,
      createdAt: new Date().toISOString()
    };
    db.tunes.push(tune);
    await writeDb(db);
    return send(res, 201, { data: tune });
  }

  const tuneSectionsMatch = pathname.match(/^\/tunes\/([^/]+)\/sections$/);
  if (tuneSectionsMatch && req.method === "GET") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId) });
  }

  if (tuneSectionsMatch && req.method === "POST") {
    const tuneId = tuneSectionsMatch[1];
    findTune(db, tuneId);
    const body = await parseBody(req);
    required(body, ["startBeat", "endBeat", "laneRange"]);
    const section = {
      id: makeId("section"),
      tuneId,
      startBeat: Number(body.startBeat),
      endBeat: Number(body.endBeat),
      laneRange: body.laneRange,
      checked: Boolean(body.checked),
      note: body.note || ""
    };
    db.sections.push(section);
    await writeDb(db);
    return send(res, 201, { data: section });
  }

  const uncheckedMatch = pathname.match(/^\/tunes\/([^/]+)\/unchecked-sections$/);
  if (uncheckedMatch && req.method === "GET") {
    const tuneId = uncheckedMatch[1];
    findTune(db, tuneId);
    return send(res, 200, { data: db.sections.filter((item) => item.tuneId === tuneId && !item.checked) });
  }

  const tunePublicationsMatch = pathname.match(/^\/tunes\/([^/]+)\/publications$/);
  if (tunePublicationsMatch && req.method === "GET") {
    const tuneId = tunePublicationsMatch[1];
    findTune(db, tuneId);
    const publications = db.publications
      .filter((item) => item.tuneId === tuneId)
      .map((item) => ({ ...item, status: publicationStatus(item) }));
    return send(res, 200, { data: publications });
  }

  if (tunePublicationsMatch && req.method === "POST") {
    const tuneId = tunePublicationsMatch[1];
    const body = await parseBody(req);
    findTune(db, tuneId);
    const snapshot = buildPublicationSnapshot(db, tuneId, body);

    const versions = db.publications.filter((item) => item.tuneId === tuneId);
    const hasSupersedes = body.supersedesId !== undefined;
    const supersedesId = hasSupersedes
      ? body.supersedesId
      : versions.length
        ? versions[versions.length - 1].id
        : null;
    if (supersedesId) {
      const predecessor = db.publications.find(
        (item) => item.id === supersedesId && item.tuneId === tuneId
      );
      if (!predecessor) return send(res, 400, { error: "supersedesId 指向的发布版不存在或不属于该曲目" });
      const predecessorStatus = publicationStatus(predecessor);
      const openRework = db.reworkOrders.find(
        (item) => item.publicationId === predecessor.id && item.status === "open"
      );
      if (openRework) {
        return send(res, 409, {
          error: `上一版存在未完成返工单 ${openRework.id}，完成返工后才能派发新版本`,
          reworkOrderId: openRework.id
        });
      }
      if (!hasSupersedes && predecessorStatus === "built") {
        // 最新一版尚未派发，无需再建新版，避免空转版本号
        return send(res, 409, {
          error: `已存在未派发的 v${predecessor.version}，请直接派发或用 supersedesId 显式接续`,
          publicationId: predecessor.id
        });
      }
    }

    const publication = {
      id: makeId("pub"),
      tuneId,
      version: versions.length ? Math.max(...versions.map((item) => item.version)) + 1 : 1,
      createdAt: new Date().toISOString(),
      dispatch: null,
      acceptance: null,
      supersedes: supersedesId,
      supersededBy: null,
      ...snapshot
    };
    if (supersedesId) {
      const predecessor = db.publications.find((item) => item.id === supersedesId);
      predecessor.supersededBy = publication.id;
    }
    db.publications.push(publication);
    await writeDb(db);
    return send(res, 201, { data: { ...publication, status: publicationStatus(publication) } });
  }

  const progressMatch = pathname.match(/^\/tunes\/([^/]+)\/progress$/);
  if (progressMatch && req.method === "GET") {
    return send(res, 200, { data: buildProgress(db, progressMatch[1]) });
  }

  const checkMatch = pathname.match(/^\/sections\/([^/]+)\/check$/);
  if (checkMatch && req.method === "PATCH") {
    const section = db.sections.find((item) => item.id === checkMatch[1]);
    if (!section) return send(res, 404, { error: "区间不存在" });
    const body = await parseBody(req);
    section.checked = body.checked !== undefined ? Boolean(body.checked) : true;
    section.note = body.note ?? section.note;
    await writeDb(db);
    return send(res, 200, { data: section });
  }

  if (req.method === "GET" && pathname === "/issues") {
    const tuneId = searchParams.get("tuneId");
    const status = searchParams.get("status");
    const issues = db.issues.filter((item) => (!tuneId || item.tuneId === tuneId) && (!status || item.status === status));
    return send(res, 200, { data: issues });
  }

  if (req.method === "POST" && pathname === "/issues") {
    const body = await parseBody(req);
    required(body, ["tuneId", "sectionId", "type", "description"]);
    findTune(db, body.tuneId);
    const section = db.sections.find((item) => item.id === body.sectionId && item.tuneId === body.tuneId);
    if (!section) return send(res, 400, { error: "区间不存在或不属于该曲目" });
    const issue = {
      id: makeId("issue"),
      tuneId: body.tuneId,
      sectionId: body.sectionId,
      type: body.type,
      beat: body.beat === undefined ? null : Number(body.beat),
      lane: body.lane === undefined ? null : Number(body.lane),
      description: body.description,
      status: "open",
      createdAt: new Date().toISOString(),
      resolvedAt: null
    };
    db.issues.push(issue);
    await writeDb(db);
    return send(res, 201, { data: issue });
  }

  const issueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/);
  if (issueStatusMatch && req.method === "PATCH") {
    const issue = db.issues.find((item) => item.id === issueStatusMatch[1]);
    if (!issue) return send(res, 404, { error: "问题不存在" });
    const body = await parseBody(req);
    required(body, ["status"]);
    issue.status = body.status;
    issue.resolvedAt = body.status === "resolved" ? new Date().toISOString() : null;
    issue.note = body.note ?? issue.note;
    await writeDb(db);
    return send(res, 200, { data: issue });
  }

  // ---- 冲孔发布闭环 ----

  if (req.method === "GET" && pathname === "/publications") {
    const tuneId = searchParams.get("tuneId");
    const publications = db.publications
      .filter((item) => !tuneId || item.tuneId === tuneId)
      .map((item) => ({ ...item, status: publicationStatus(item) }));
    return send(res, 200, { data: publications });
  }

  if (req.method === "GET" && pathname === "/publications/diff") {
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    if (!from || !to) return send(res, 400, { error: "缺少查询参数 from / to（发布版ID）" });
    return send(res, 200, { data: buildDiff(db, from, to) });
  }

  const publicationMatch = pathname.match(/^\/publications\/([^/]+)$/);
  if (publicationMatch && req.method === "GET") {
    const publication = findPublication(db, publicationMatch[1]);
    return send(res, 200, {
      data: {
        ...publication,
        status: publicationStatus(publication),
        reworkOrders: db.reworkOrders.filter((item) => item.publicationId === publication.id)
      }
    });
  }

  const dispatchMatch = pathname.match(/^\/publications\/([^/]+)\/dispatch$/);
  if (dispatchMatch && req.method === "POST") {
    const publication = findPublication(db, dispatchMatch[1]);
    assertPublicationWritable(publication);
    const body = await parseBody(req);
    required(body, ["paperType", "machineId", "operator"]);

    const pubNo = String(body.pubNo || "").trim();
    if (pubNo) {
      const conflict = db.dispatches.find((item) => item.pubNo === pubNo);
      if (conflict) {
        return send(res, 409, {
          error: `发布号 ${pubNo} 已派发给发布版 ${conflict.publicationId}，同一发布号只能派发一次`,
          pubNo,
          existingDispatch: conflict
        });
      }
    }

    const dispatch = {
      id: makeId("dispatch"),
      pubNo: pubNo || `PUB-${publication.id.slice(4).toUpperCase()}`,
      publicationId: publication.id,
      tuneId: publication.tuneId,
      version: publication.version,
      paperType: body.paperType,
      machineId: body.machineId,
      operator: body.operator,
      dispatchedAt: new Date().toISOString()
    };
    if (db.dispatches.some((item) => item.pubNo === dispatch.pubNo)) {
      return send(res, 409, { error: `发布号 ${dispatch.pubNo} 冲突`, pubNo: dispatch.pubNo });
    }
    db.dispatches.push(dispatch);
    publication.dispatch = dispatch;
    await writeDb(db);
    return send(res, 201, { data: { ...publication, status: publicationStatus(publication) } });
  }

  const receiptMatch = pathname.match(/^\/publications\/([^/]+)\/receipts$/);
  if (receiptMatch && req.method === "POST") {
    const publication = findPublication(db, receiptMatch[1]);
    const status = publicationStatus(publication);
    if (status === "built") return send(res, 409, { error: "发布版尚未派发，无法接收回执" });
    if (status === "accepted") return send(res, 409, { error: "发布版已验收，版本只读" });
    if (status === "rejected") {
      return send(res, 409, {
        error: "发布版已判不合格并冻结，请完成返工后用新发布版重试",
        reworkOrderId: publication.acceptance.reworkOrderId
      });
    }

    const body = await parseBody(req);
    required(body, ["holeCount", "offsetMm", "tapeLengthMm"]);
    const receipt = {
      holeCount: Number(body.holeCount),
      offsetMm: Number(body.offsetMm),
      tapeLengthMm: Number(body.tapeLengthMm),
      machineId: body.machineId || (publication.dispatch && publication.dispatch.machineId) || null,
      note: body.note || ""
    };
    if ([receipt.holeCount, receipt.offsetMm, receipt.tapeLengthMm].some((value) => !Number.isFinite(value))) {
      return send(res, 400, { error: "回执字段必须是数字" });
    }

    const mismatches = evaluateReceipt(publication, receipt);
    const outcome = recordAcceptance(db, publication, receipt, mismatches, "online");
    await writeDb(db);
    return send(res, mismatches.length ? 422 : 200, {
      data: {
        publicationId: publication.id,
        pubNo: publication.dispatch.pubNo,
        status: publicationStatus(publication),
        ...outcome
      }
    });
  }

  if (req.method === "GET" && pathname === "/reworks") {
    const statusFilter = searchParams.get("status");
    const tuneId = searchParams.get("tuneId");
    const orders = db.reworkOrders.filter(
      (item) =>
        (!statusFilter || item.status === statusFilter) && (!tuneId || item.tuneId === tuneId)
    );
    return send(res, 200, { data: orders });
  }

  const reworkCompleteMatch = pathname.match(/^\/reworks\/([^/]+)\/complete$/);
  if (reworkCompleteMatch && req.method === "POST") {
    const order = db.reworkOrders.find((item) => item.id === reworkCompleteMatch[1]);
    if (!order) return send(res, 404, { error: "返工单不存在" });
    if (order.status === "completed") return send(res, 409, { error: "返工单已完成" });
    const body = await parseBody(req).catch(() => ({}));
    order.status = "completed";
    order.completedAt = new Date().toISOString();
    order.note = body.note || order.note || "";
    await writeDb(db);
    return send(res, 200, {
      data: {
        reworkOrder: order,
        nextStep: `基于发布版 ${order.publicationId} 创建新发布版并重试派发`
      }
    });
  }

  // ---- 离线回执：两个来源按发布号合并 ----

  if (req.method === "POST" && pathname === "/receipts/offline") {
    const body = await parseBody(req);
    required(body, ["pubNo", "source", "holeCount", "offsetMm", "tapeLengthMm"]);
    const publication = findPublicationByPubNo(db, body.pubNo);
    if (!publication) return send(res, 404, { error: `发布号 ${body.pubNo} 未登记派发` });
    if (publicationStatus(publication) !== "dispatched") {
      return send(res, 409, { error: "发布版不在待回执状态，离线回执只对已派发未验收版本有效" });
    }

    const record = {
      id: makeId("offreceipt"),
      pubNo: body.pubNo,
      source: body.source,
      machineId: body.machineId || publication.dispatch.machineId,
      receipt: {
        holeCount: Number(body.holeCount),
        offsetMm: Number(body.offsetMm),
        tapeLengthMm: Number(body.tapeLengthMm)
      },
      receivedAt: new Date().toISOString()
    };
    if (Object.values(record.receipt).some((value) => !Number.isFinite(value))) {
      return send(res, 400, { error: "回执字段必须是数字" });
    }
    const existing = db.offlineReceipts.find(
      (item) => item.pubNo === record.pubNo && item.source === record.source
    );
    if (existing) {
      return send(res, 409, { error: `发布号 ${record.pubNo} 已存在来源 ${record.source} 的离线回执` });
    }
    db.offlineReceipts.push(record);
    await writeDb(db);
    const samePub = db.offlineReceipts.filter((item) => item.pubNo === record.pubNo);
    return send(res, 201, {
      data: { receipt: record, receivedCount: samePub.length, readyToMerge: samePub.length >= 2 }
    });
  }

  const offlineListMatch = pathname.match(/^\/receipts\/offline\/([^/]+)$/);
  if (offlineListMatch && req.method === "GET") {
    const pubNo = decodeURIComponent(offlineListMatch[1]);
    const receipts = db.offlineReceipts.filter((item) => item.pubNo === pubNo);
    if (!receipts.length) return send(res, 404, { error: `发布号 ${pubNo} 没有离线回执` });
    return send(res, 200, { data: receipts });
  }

  const mergeMatch = pathname.match(/^\/receipts\/merge\/([^/]+)$/);
  if (mergeMatch && req.method === "GET") {
    const pubNo = decodeURIComponent(mergeMatch[1]);
    const receipts = db.offlineReceipts.filter((item) => item.pubNo === pubNo);
    if (!receipts.length) return send(res, 404, { error: `发布号 ${pubNo} 没有离线回执` });
    if (receipts.length < 2) {
      return send(res, 409, { error: `离线回执不足两个（当前 ${receipts.length} 个），无法合并` });
    }
    const priorResolution = db.mergedReceipts.find((item) => item.pubNo === pubNo);
    const report = mergeOfflineReceipts(pubNo, receipts.slice(0, 2));
    return send(res, 200, { data: priorResolution || report });
  }

  const mergeResolveMatch = pathname.match(/^\/receipts\/merge\/([^/]+)\/resolve$/);
  if (mergeResolveMatch && req.method === "POST") {
    const pubNo = decodeURIComponent(mergeResolveMatch[1]);
    const publication = findPublicationByPubNo(db, pubNo);
    if (!publication) return send(res, 404, { error: `发布号 ${pubNo} 未登记派发` });
    if (publicationStatus(publication) !== "dispatched") {
      return send(res, 409, { error: "发布版不在待回执状态，无法定版验收" });
    }
    const receipts = db.offlineReceipts.filter((item) => item.pubNo === pubNo);
    if (receipts.length < 2) return send(res, 409, { error: "离线回执不足两个，无法合并" });
    const body = await parseBody(req);
    const report = mergeOfflineReceipts(pubNo, receipts.slice(0, 2));

    // 一致字段自动取值；冲突字段必须逐项用 resolutions.<field> 指定来源（"a"/"b" 或具体值）
    const sourceOrder = receipts.slice(0, 2);
    const finalReceipt = { ...report.mergedReceipt };
    const resolutions = {};
    for (const field of report.conflictFields) {
      const decision = body.resolutions && body.resolutions[field];
      if (decision === undefined) {
        return send(res, 409, {
          error: `字段 ${field} 两个回执不一致，必须在 resolutions.${field} 中逐项定版`,
          mergeReport: report
        });
      }
      if (decision === "a" || decision === "b") {
        const picked = sourceOrder[decision === "a" ? 0 : 1];
        finalReceipt[field] = field === "machineId" ? picked.machineId : picked.receipt[field];
        resolutions[field] = { resolvedBy: "source", source: picked.source, value: finalReceipt[field] };
      } else {
        finalReceipt[field] = field === "machineId" ? String(decision) : Number(decision);
        resolutions[field] = { resolvedBy: "manual", value: finalReceipt[field] };
      }
    }

    const mergedRecord = {
      pubNo,
      status: "resolved",
      resolvedAt: new Date().toISOString(),
      finalReceipt,
      resolutions,
      fieldReports: report.fieldReports
    };
    const existingIndex = db.mergedReceipts.findIndex((item) => item.pubNo === pubNo);
    if (existingIndex >= 0) db.mergedReceipts[existingIndex] = mergedRecord;
    else db.mergedReceipts.push(mergedRecord);

    const { holeCount, offsetMm, tapeLengthMm, machineId } = finalReceipt;
    const mismatches = evaluateReceipt(publication, { holeCount, offsetMm, tapeLengthMm });
    const outcome = recordAcceptance(db, publication, { ...finalReceipt, machineId }, mismatches, "offline-merged");
    await writeDb(db);
    return send(res, mismatches.length ? 422 : 200, {
      data: {
        merge: mergedRecord,
        publicationId: publication.id,
        status: publicationStatus(publication),
        ...outcome
      }
    });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Organ strip punch API running at http://127.0.0.1:${PORT}`);
});
