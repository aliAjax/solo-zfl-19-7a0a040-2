#!/usr/bin/env node
/**
 * 冲孔发布闭环端到端验证（真实 HTTP 接口）。
 * 自动启动/重启 server.js，使用独立临时数据文件，不影响 data/db.json。
 * 覆盖：建版 → 冲突派发 → 差异比较 → 坏回执 → 返工重发 → 双回执合并 → 重启持久化 → 旧接口回归。
 */
const { spawn } = require("child_process");
const { mkdtempSync, rmSync } = require("fs");
const os = require("os");
const path = require("path");

const PORT = process.env.TEST_PORT || 3919;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), "organ-e2e-"));
const DB_FILE = path.join(TMP_DIR, "db.json");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

async function api(method, url, body, expectedStatus = 200) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (res.status !== expectedStatus) {
    throw new Error(
      `${method} ${url} 期望状态 ${expectedStatus}，实际 ${res.status}：${JSON.stringify(json)}`
    );
  }
  return json;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, PORT: String(PORT), DB_FILE },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("running")) resolve(child);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    setTimeout(() => reject(new Error("服务启动超时")), 5000);
  });
}

async function stopServer(child) {
  await new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
  });
}

async function waitHealthy() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("服务重启后健康检查失败");
}

(async () => {
  let server = await startServer();
  try {
    console.log("\n=== 1. 旧接口回归（建版前）===");
    const health = await api("GET", "/health");
    check("GET /health", health.ok === true);
    check("路由清单包含发布闭环", health.routes.includes("POST /publications/:id/dispatch"));

    const tunes = await api("GET", "/tunes");
    check("GET /tunes 返回演示曲目", tunes.data[0].id === "tune_demo");
    check("进度聚合正常", tunes.data[0].progress.totalSections === 2);

    const sections = await api("GET", "/tunes/tune_demo/sections");
    check("GET 区间", sections.data.length === 2);
    const unchecked = await api("GET", "/tunes/tune_demo/unchecked-sections");
    check("GET 未检查区间", unchecked.data.length === 1 && unchecked.data[0].id === "section_demo_2");
    const progress = await api("GET", "/tunes/tune_demo/progress");
    check("GET 进度", progress.data.checkedSections === 1 && progress.data.openIssues === 1);

    console.log("\n=== 2. 建版：只能基于已检查区间 ===");
    const badHole = await api(
      "POST",
      "/tunes/tune_demo/publications",
      { holes: [{ beat: 40, lane: 5 }] }, // 第40拍在未检查区间
      400
    );
    check("孔位落在未检查区间拒绝建版", /已检查区间/.test(badHole.error), badHole.error);

    const badLane = await api(
      "POST",
      "/tunes/tune_demo/publications",
      { holes: [{ beat: 10, lane: 99 }] }, // 超出 1-10 轨
      400
    );
    check("孔位超出轨位范围拒绝建版", /轨位范围/.test(badLane.error), badLane.error);

    const v1 = await api(
      "POST",
      "/tunes/tune_demo/publications",
      { holes: [{ beat: 5, lane: 3 }, { beat: 12, lane: 7 }, { beat: 20, lane: 1 }] },
      201
    );
    const pub1 = v1.data;
    check("v1 建版成功", pub1.version === 1 && pub1.holes.length === 3);
    check(
      "发布版不可变快照冻结期望孔数/纸带长度",
      pub1.expected.holeCount === 3 && pub1.expected.tapeLengthMm === 800
    );
    check("冻结问题处理状态（issue_demo 仍 open）", pub1.issueSnapshot[0].status === "open");
    check("状态为 built", pub1.status === "built");

    const duplicateBuild = await api(
      "POST",
      "/tunes/tune_demo/publications",
      { holes: [{ beat: 1, lane: 1 }] },
      409
    );
    check("未派发版本不允许空转建新 版", /未派发/.test(duplicateBuild.error), duplicateBuild.error);

    console.log("\n=== 3. 派发：登记纸型/机台/操作员，发布号唯一 ===");
    const dispatch1 = await api(
      "POST",
      `/publications/${pub1.id}/dispatch`,
      { pubNo: "PUB-E2E-1", paperType: "半透明纸带", machineId: "M-01", operator: "阿珍" },
      201
    );
    check("v1 派发成功", dispatch1.data.status === "dispatched");
    check("派发表登记纸型机台操作员", dispatch1.data.dispatch.paperType === "半透明纸带");

    // 发布号唯一性用独立的冲突曲目验证，避免污染主版本序列
    const conflictTune = await api(
      "POST",
      "/tunes",
      { title: "冲突测试曲", stripSpec: { widthMm: 70, scale: "20音", tempoBpm: 90, paperType: "纸带" } },
      201
    );
    await api(
      "POST",
      `/tunes/${conflictTune.data.id}/sections`,
      { startBeat: 1, endBeat: 8, laneRange: "1-5", checked: true },
      201
    );
    const conflictPubA = await api(
      "POST",
      `/tunes/${conflictTune.data.id}/publications`,
      { holes: [{ beat: 1, lane: 1 }] },
      201
    );
    await api(
      "POST",
      `/publications/${conflictPubA.data.id}/dispatch`,
      { pubNo: "PUB-E2E-OTHER", paperType: "纸带", machineId: "M-09", operator: "路人甲" },
      201
    );
    const conflictPubB = await api(
      "POST",
      `/tunes/${conflictTune.data.id}/publications`,
      { holes: [{ beat: 2, lane: 2 }] },
      201
    );
    const conflictDispatch = await api(
      "POST",
      `/publications/${conflictPubB.data.id}/dispatch`,
      { pubNo: "PUB-E2E-1", paperType: "牛皮纸带", machineId: "M-02", operator: "阿强" },
      409
    );
    check(
      "同一发布号二次派发被拒绝",
      /只能派发一次/.test(conflictDispatch.error) &&
        conflictDispatch.existingDispatch.publicationId === pub1.id,
      conflictDispatch.error
    );

    console.log("\n=== 4. 版本并存与差异比较（孔位/节拍/问题处理）===");
    // 校对推进：检查副歌区间 + 解决旧问题，v2 正式基于 v1
    await api("PATCH", "/sections/section_demo_2/check", { checked: true, note: "副歌校对完成" }, 200);
    await api("PATCH", "/issues/issue_demo/status", { status: "resolved" }, 200);

    const v2 = await api(
      "POST",
      "/tunes/tune_demo/publications",
      {
        holes: [
          { beat: 5, lane: 3 },
          { beat: 12, lane: 7 },
          { beat: 20, lane: 1 },
          { beat: 41, lane: 12 } // 修复漏孔后补孔
        ],
        tempoBpm: 88,
        paperType: "加厚纸带",
        supersedesId: pub1.id
      },
      201
    );
    const pub2 = v2.data;
    check("v2 与 v1 并存（版本号递增）", pub2.version === 2 && pub2.supersedes === pub1.id);
    check("v2 纳入新检查区间", pub2.sectionSnapshot.length === 2);
    check("v2 冻结的问题状态为 resolved", pub2.issueSnapshot[0].status === "resolved");

    const dispatch2 = await api(
      "POST",
      `/publications/${pub2.id}/dispatch`,
      { pubNo: "PUB-E2E-2", paperType: "加厚纸带", machineId: "M-02", operator: "阿强" },
      201
    );
    check("v2 用新发布号派发成功", dispatch2.data.dispatch.pubNo === "PUB-E2E-2");

    const diff = await api("GET", `/publications/diff?from=${pub1.id}&to=${pub2.id}`);
    const d = diff.data;
    check("孔位差异：新增第41拍第12轨", d.holes.added.some((h) => h.beat === 41 && h.lane === 12));
    check("孔位差异：孔数增量 +1", d.holes.holeCountDelta === 1 && d.holes.removed.length === 0);
    check("节拍差异：82→88", d.tempo.changed && d.tempo.deltaBpm === 6);
    check("纸型差异识别", d.paperType.changed && d.paperType.to === "加厚纸带");
    check(
      "问题处理差异：issue_demo open→resolved",
      d.issueHandling.resolved.some((i) => i.id === "issue_demo")
    );
    check("区间差异：新增副歌区间", d.sections.added.some((s) => s.id === "section_demo_2"));

    console.log("\n=== 5. 坏回执：与发布版不一致 → 422 + 返工单 + 责任区间 ===");
    const badReceipt = await api(
      "POST",
      `/publications/${pub1.id}/receipts`,
      { holeCount: 2, offsetMm: 12, tapeLengthMm: 780 }, // 孔数错、偏移超差、长度超差
      422
    );
    check("验收结论 rejected", badReceipt.data.result === "rejected");
    const fields = badReceipt.data.mismatches.map((m) => m.field).sort();
    check(
      "三项字段全部标失配",
      JSON.stringify(fields) === JSON.stringify(["holeCount", "offsetMm", "tapeLengthMm"]),
      JSON.stringify(fields)
    );
    const rework = badReceipt.data.reworkOrder;
    check(
      "返工单标出责任区间（开头+结尾；孔数错覆盖全部）",
      rework.responsibleSectionIds.includes("section_demo_1")
    );
    check("返工单状态 open", rework.status === "open");

    const rejectAgain = await api(
      "POST",
      `/publications/${pub1.id}/receipts`,
      { holeCount: 3, offsetMm: 0, tapeLengthMm: 800 },
      409
    );
    check("旧版冻结，不能对 rejected 版本再次提交回执", /冻结/.test(rejectAgain.error), rejectAgain.error);

    console.log("\n=== 6. 返工后用新发布版重试 ===");
    const blockedBuild = await api(
      "POST",
      "/tunes/tune_demo/publications",
      { holes: [{ beat: 1, lane: 1 }], supersedesId: pub1.id },
      409
    );
    check("返工未完成时阻塞后继建版", /返工单/.test(blockedBuild.error), blockedBuild.error);

    await api("POST", `/reworks/${rework.id}/complete`, { note: "重新校准打孔针与走纸" }, 200);
    const v3 = await api(
      "POST",
      "/tunes/tune_demo/publications",
      {
        holes: pub2.holes, // 返工重发覆盖全部已检查区间（含已修复的第41拍）
        supersedesId: pub1.id
      },
      201
    );
    const pub3 = v3.data;
    check("返工完成后 v3 基于旧版重建", pub3.version === 3 && pub3.supersedes === pub1.id);
    const pub1Fresh = (await api("GET", `/publications/${pub1.id}`)).data;
    check("旧版血缘回填 supersededBy（supersedes 边保留完整图谱）", pub1Fresh.supersededBy === pub3.id && pub2.supersedes === pub1.id);

    const dispatch3 = await api(
      "POST",
      `/publications/${pub3.id}/dispatch`,
      { pubNo: "PUB-E2E-3", paperType: "半透明纸带", machineId: "M-01", operator: "阿珍" },
      201
    );
    check("v3 派发", dispatch3.data.status === "dispatched");

    const goodReceipt = await api(
      "POST",
      `/publications/${pub3.id}/receipts`,
      { holeCount: 4, offsetMm: 0.4, tapeLengthMm: 1602 }, // 在容差内
      200
    );
    check("合格回执验收通过", goodReceipt.data.result === "accepted");

    const afterAccepted = await api(
      "POST",
      `/publications/${pub3.id}/receipts`,
      { holeCount: 3, offsetMm: 0, tapeLengthMm: 800 },
      409
    );
    check("已验收版本只读", /只读/.test(afterAccepted.error), afterAccepted.error);

    console.log("\n=== 7. 两个离线回执按发布号合并（v2）===");
    await api(
      "POST",
      "/receipts/offline",
      { pubNo: "PUB-E2E-2", source: "machine-log", machineId: "M-02", holeCount: 4, offsetMm: 0.5, tapeLengthMm: 1100 },
      201
    );
    const secondOffline = await api(
      "POST",
      "/receipts/offline",
      { pubNo: "PUB-E2E-2", source: "operator-card", machineId: "M-02", holeCount: 4, offsetMm: 0.5, tapeLengthMm: 1050 },
      201
    );
    check("两个离线回执收齐", secondOffline.data.receivedCount === 2 && secondOffline.data.readyToMerge);

    const dupOffline = await api(
      "POST",
      "/receipts/offline",
      { pubNo: "PUB-E2E-2", source: "machine-log", holeCount: 4, offsetMm: 0.5, tapeLengthMm: 1100 },
      409
    );
    check("同源回执幂等拒绝", /已存在/.test(dupOffline.error), dupOffline.error);

    const mergeReport = await api("GET", "/receipts/merge/PUB-E2E-2");
    check("合并报告标记冲突字段", JSON.stringify(mergeReport.data.conflictFields) === JSON.stringify(["tapeLengthMm"]));
    check("一致字段自动取值（holeCount=4）", mergeReport.data.mergedReceipt.holeCount === 4);

    const resolveMissing = await api(
      "POST",
      "/receipts/merge/PUB-E2E-2/resolve",
      { resolutions: {} },
      409
    );
    check("冲突字段未逐项定版拒绝验收", /tapeLengthMm/.test(resolveMissing.error), resolveMissing.error);

    // v2 期望长度 41*25=1025；采用机台日志 1100 → 超差 → 合并后验收失败
    const resolveBad = await api(
      "POST",
      "/receipts/merge/PUB-E2E-2/resolve",
      { resolutions: { tapeLengthMm: "a" } },
      422
    );
    check("按来源定版后执行验收：1100 超差判退", resolveBad.data.result === "rejected");
    check("合并失配落在纸带长度", resolveBad.data.mismatches.some((m) => m.field === "tapeLengthMm"));
    check(
      "长度责任区间为尾部副歌段",
      resolveBad.data.reworkOrder.responsibleSectionIds.includes("section_demo_2")
    );

    console.log("\n=== 8. 刷新重启后状态保持 ===");
    await stopServer(server);
    server = await startServer();
    await waitHealthy();
    console.log("  (服务已重启)");

    const pubsAfter = await api("GET", "/tunes/tune_demo/publications");
    const statuses = Object.fromEntries(pubsAfter.data.map((p) => [p.version, p.status]));
    check("派发/验收状态跨重启保持", statuses[1] === "rejected" && statuses[2] === "rejected" && statuses[3] === "accepted", JSON.stringify(statuses));
    const pub1After = pubsAfter.data.find((p) => p.version === 1);
    check(
      "版本血缘跨重启保持（v1→v3）",
      pub1After.supersededBy && pub1After.dispatch.pubNo === "PUB-E2E-1"
    );
    const reworksAfter = await api("GET", "/reworks?status=completed");
    check("返工单完成状态跨重启保持", reworksAfter.data.some((r) => r.pubNo === "PUB-E2E-1"));
    const mergeAfter = await api("GET", "/receipts/merge/PUB-E2E-2");
    check("双回执合并结论跨重启保持", mergeAfter.data.status === "resolved" && mergeAfter.data.finalReceipt.tapeLengthMm === 1100);
    const dispatchesAfter = await api("GET", "/tunes/tune_demo/publications");
    check("三个发布号均已登记", dispatchesAfter.data.every((p) => p.dispatch));

    console.log("\n=== 9. 旧接口回归（重启后）===");
    const sectionsAfter = await api("GET", "/tunes/tune_demo/sections");
    check("区间校对状态保持", sectionsAfter.data.every((s) => s.checked === true));
    const issuesAfter = await api("GET", "/issues?tuneId=tune_demo&status=resolved");
    check("问题筛选接口正常", issuesAfter.data.length === 1 && issuesAfter.data[0].resolvedAt);
    const createdIssue = await api(
      "POST",
      "/issues",
      { tuneId: "tune_demo", sectionId: "section_demo_1", type: "错孔", beat: 5, lane: 3, description: "回归测试问题" },
      201
    );
    check("POST /issues 正常", createdIssue.data.status === "open");
    await api("PATCH", `/issues/${createdIssue.data.id}/status`, { status: "resolved" }, 200);
    const newTune = await api(
      "POST",
      "/tunes",
      { title: "回归小曲", stripSpec: { widthMm: 70, scale: "20音", tempoBpm: 100, paperType: "纸带" } },
      201
    );
    check("POST /tunes 正常", newTune.data.id.startsWith("tune_"));
    const newSection = await api(
      "POST",
      `/tunes/${newTune.data.id}/sections`,
      { startBeat: 1, endBeat: 8, laneRange: "1-5" },
      201
    );
    check("POST 区间正常", newSection.data.checked === false);
    const noChecked = await api(
      "POST",
      `/tunes/${newTune.data.id}/publications`,
      { holes: [{ beat: 1, lane: 1 }] },
      400
    );
    check("无已检查区间拒绝建版", /已检查区间/.test(noChecked.error), noChecked.error);
  } catch (error) {
    console.error("\n测试异常中断：", error.message);
    failed += 1;
    failures.push("脚本异常");
  } finally {
    await stopServer(server);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) {
    console.log("失败项：", failures.join("; "));
    process.exit(1);
  }
  console.log("全部通过。");
})();
