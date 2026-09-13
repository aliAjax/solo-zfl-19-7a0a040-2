#!/usr/bin/env node
/**
 * 并发派发与非法裁决值验证（真实 HTTP 接口，独立临时库，自动重启验证落盘）。
 */
const { spawn } = require("child_process");
const { mkdtempSync, rmSync } = require("fs");
const os = require("os");
const path = require("path");

const PORT = process.env.TEST_PORT || 3921;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), "organ-conc-"));
const DB_FILE = path.join(TMP_DIR, "db.json");

let passed = 0;
let failed = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`); }
}

async function rawFetch(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function api(method, url, body, expectedStatus) {
  const { status, json } = await rawFetch(method, url, body);
  const ok = expectedStatus === undefined ? status < 300 : status === expectedStatus;
  if (!ok) {
    throw new Error(`${method} ${url} 期望 ${expectedStatus || "2xx"}，实际 ${status}：${JSON.stringify(json)}`);
  }
  return json;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, PORT: String(PORT), DB_FILE },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (c) => { if (String(c).includes("running")) resolve(child); });
    child.stderr.on("data", (c) => process.stderr.write(c));
    setTimeout(() => reject(new Error("启动超时")), 5000);
  });
}
async function stopServer(child) {
  await new Promise((resolve) => {
    child.on("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000);
  });
}
async function waitHealthy() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("重启后健康检查失败");
}

async function setupTune(title) {
  const tune = (await api("POST", "/tunes", { title, stripSpec: { widthMm: 70, scale: "20音", tempoBpm: 90, paperType: "纸带" } }, 201)).data;
  await api("POST", `/tunes/${tune.id}/sections`, { startBeat: 1, endBeat: 8, laneRange: "1-5", checked: true }, 201);
  return tune.id;
}

(async () => {
  let server = await startServer();
  try {
    console.log("\n=== A. 同发布号并发派发到两个不同发布版 ===");
    const tuneA = await setupTune("并发曲A");
    const pubA1 = (await api("POST", `/tunes/${tuneA}/publications`, { holes: [{ beat: 1, lane: 1 }] })).data;
    const pubA2 = (await api("POST", `/tunes/${tuneA}/publications`, { holes: [{ beat: 2, lane: 2 }], supersedesId: pubA1.id })).data;
    check("存在两个待派发版本", pubA1.status === "built" && pubA2.status === "built");

    const [r1, r2] = await Promise.all([
      rawFetch("POST", `/publications/${pubA1.id}/dispatch`, { pubNo: "PUB-RACE", paperType: "纸带", machineId: "M-1", operator: "甲" }),
      // 第二个请求几乎同时进入服务器，读—校验—写在锁内串行
      new Promise((resolve) => setTimeout(() =>
        resolve(rawFetch("POST", `/publications/${pubA2.id}/dispatch`, { pubNo: "PUB-RACE", paperType: "纸带", machineId: "M-2", operator: "乙" })), 5))
    ]);
    const codes = [r1.status, r2.status].sort((a, b) => a - b);
    check("恰一个成功一个冲突 (201/409)", JSON.stringify(codes) === JSON.stringify([201, 409]), JSON.stringify(codes));

    const winner = r1.status === 201 ? pubA1 : pubA2;
    const loser = r1.status === 201 ? pubA2 : pubA1;
    const winnerAfter = (await api("GET", `/publications/${winner.id}`)).data;
    const loserAfter = (await api("GET", `/publications/${loser.id}`)).data;
    check("获胜版本已派发", winnerAfter.status === "dispatched" && winnerAfter.dispatch.pubNo === "PUB-RACE");
    check("失败版本状态未被改动（仍 built、无派发）", loserAfter.status === "built" && loserAfter.dispatch === null, JSON.stringify(loserAfter.dispatch));

    const pubs = (await api("GET", `/tunes/${tuneA}/publications`)).data;
    const raced = pubs.filter((p) => p.dispatch && p.dispatch.pubNo === "PUB-RACE");
    check("当前内存中 PUB-RACE 只有一条派发", raced.length === 1, `实际 ${raced.length} 条`);

    console.log("\n=== B. 同一发布版自身并发派发（同号同体）===");
    const tuneB = await setupTune("并发曲B");
    const pubB = (await api("POST", `/tunes/${tuneB}/publications`, { holes: [{ beat: 1, lane: 1 }] })).data;
    const [b1, b2] = await Promise.all([
      rawFetch("POST", `/publications/${pubB.id}/dispatch`, { pubNo: "PUB-RACE-2", paperType: "纸带", machineId: "M-3", operator: "丙" }),
      new Promise((resolve) => setTimeout(() =>
        resolve(rawFetch("POST", `/publications/${pubB.id}/dispatch`, { pubNo: "PUB-RACE-2", paperType: "纸带", machineId: "M-3", operator: "丙" })), 5))
    ]);
    const codesB = [b1.status, b2.status].sort((a, b) => a - b);
    check("同体并发也恰一个 201 一个 409", JSON.stringify(codesB) === JSON.stringify([201, 409]), JSON.stringify(codesB));
    check("败者报只读/冲突而非重复成功", [b1, b2].some((r) => r.status === 409 && /只读|只能派发一次/.test(r.json.error)));

    console.log("\n=== C. 并发结果重启后仍只有一条 ===");
    await stopServer(server);
    server = await startServer();
    await waitHealthy();
    const pubsA2 = (await api("GET", `/tunes/${tuneA}/publications`)).data;
    const racedAfter = pubsA2.filter((p) => p.dispatch && p.dispatch.pubNo === "PUB-RACE");
    check("重启后 PUB-RACE 仍只有一条派发", racedAfter.length === 1, `实际 ${racedAfter.length} 条`);
    const pubsB2 = (await api("GET", `/tunes/${tuneB}/publications`)).data;
    const racedB2 = pubsB2.filter((p) => p.dispatch && p.dispatch.pubNo === "PUB-RACE-2");
    check("重启后 PUB-RACE-2 仍只有一条派发", racedB2.length === 1, `实际 ${racedB2.length} 条`);

    console.log("\n=== D. 离线合并裁决：非法数值必须 400 且零写入 ===");
    const tuneD = await setupTune("裁决曲");
    const pubD = (await api("POST", `/tunes/${tuneD}/publications`, { holes: [{ beat: 1, lane: 1 }] })).data;
    await api("POST", `/publications/${pubD.id}/dispatch`, { pubNo: "PUB-JUDGE", paperType: "纸带", machineId: "M-4", operator: "丁" });
    // 期望：holeCount=1, offset=0, tapeLength=8*25=200；两来源仅长度冲突
    await api("POST", "/receipts/offline", { pubNo: "PUB-JUDGE", source: "machine-log", machineId: "M-4", holeCount: 1, offsetMm: 0, tapeLengthMm: 200 });
    await api("POST", "/receipts/offline", { pubNo: "PUB-JUDGE", source: "operator-card", machineId: "M-4", holeCount: 1, offsetMm: 0, tapeLengthMm: 190 });

    for (const bad of ["abc", "   ", true, "1e999", {}]) {
      const { status, json } = await rawFetch("POST", "/receipts/merge/PUB-JUDGE/resolve", { resolutions: { tapeLengthMm: bad } });
      check(`非法裁决值 ${JSON.stringify(bad)} → 400`, status === 400 && /有限数字/.test(json.error), `status=${status} ${JSON.stringify(json)}`);
    }
    // null 等价于“未给裁决”，409 要求逐项定版；同样不得验收/写入
    const nullDecision = await rawFetch("POST", "/receipts/merge/PUB-JUDGE/resolve", { resolutions: { tapeLengthMm: null } });
    check("null 裁决被拒绝（409 需逐项定版）", nullDecision.status === 409 && /逐项定版/.test(nullDecision.json.error));

    const mergeView = (await api("GET", "/receipts/merge/PUB-JUDGE")).data;
    check("非法裁决未写入合并结果（仍为 conflict）", mergeView.status === "conflict" && mergeView.resolution === null, mergeView.status);
    const pubDAfter = (await api("GET", `/publications/${pubD.id}`)).data;
    check("非法裁决未改动发布版（仍 dispatched、无验收）", pubDAfter.status === "dispatched" && pubDAfter.acceptance === null, pubDAfter.status);
    check("非法裁决未产生返工单", (pubDAfter.reworkOrders || []).length === 0);

    console.log("\n=== E. 合法裁决正常验收 ===");
    const good = await api("POST", "/receipts/merge/PUB-JUDGE/resolve", { resolutions: { tapeLengthMm: "a" } }, 200);
    check("按来源 a 定版验收合格", good.data.result === "accepted" && good.data.merge.finalReceipt.tapeLengthMm === 200);
    const pubDAccepted = (await api("GET", `/publications/${pubD.id}`)).data;
    check("发布版状态 accepted", pubDAccepted.status === "accepted");

    // 另起一个冲突号，用手动数字裁决验证数值字符串可接受
    const tuneE = await setupTune("裁决曲2");
    const pubE = (await api("POST", `/tunes/${tuneE}/publications`, { holes: [{ beat: 1, lane: 1 }] })).data;
    await api("POST", `/publications/${pubE.id}/dispatch`, { pubNo: "PUB-JUDGE-2", paperType: "纸带", machineId: "M-5", operator: "戊" });
    await api("POST", "/receipts/offline", { pubNo: "PUB-JUDGE-2", source: "machine-log", machineId: "M-5", holeCount: 1, offsetMm: 0, tapeLengthMm: 205 });
    await api("POST", "/receipts/offline", { pubNo: "PUB-JUDGE-2", source: "operator-card", machineId: "M-5", holeCount: 1, offsetMm: 0, tapeLengthMm: 180 });
    const manual = await api("POST", "/receipts/merge/PUB-JUDGE-2/resolve", { resolutions: { tapeLengthMm: "200" } }, 200);
    check("数字字符串 \"200\" 合法且验收合格", manual.data.result === "accepted");
    const holeBad = await rawFetch("POST", "/receipts/merge/PUB-JUDGE-2/resolve", { resolutions: {} });
    check("已验收版本再裁决返回冲突状态", holeBad.status === 409);

    console.log("\n=== F. 在线/离线回执入口非法数值 ===");
    const tuneF = await setupTune("入口校验曲");
    const pubF = (await api("POST", `/tunes/${tuneF}/publications`, { holes: [{ beat: 1, lane: 1 }] })).data;
    await api("POST", `/publications/${pubF.id}/dispatch`, { pubNo: "PUB-ENTRY", paperType: "纸带", machineId: "M-6", operator: "己" });
    const onlineBad = await rawFetch("POST", `/publications/${pubF.id}/receipts`, { holeCount: "x", offsetMm: 0, tapeLengthMm: 200 });
    check("在线回执文本孔数 → 400", onlineBad.status === 400 && /整数/.test(onlineBad.json.error));
    const pubFAfter = (await api("GET", `/publications/${pubF.id}`)).data;
    check("非法在线回执未改状态", pubFAfter.status === "dispatched" && pubFAfter.acceptance === null);
    const offlineBad = await rawFetch("POST", "/receipts/offline", { pubNo: "PUB-ENTRY", source: "machine-log", machineId: "M-6", holeCount: 1, offsetMm: "NaN", tapeLengthMm: 200 });
    check("离线回执 NaN 文本 → 400", offlineBad.status === 400 && /有限数字/.test(offlineBad.json.error));
    const offlineList = await rawFetch("GET", "/receipts/offline/PUB-ENTRY");
    check("非法离线回执未存储（查无记录）", offlineList.status === 404, `status=${offlineList.status}`);
  } catch (error) {
    console.error("\n测试异常中断：", error.message);
    failed++; failures.push("脚本异常");
  } finally {
    await stopServer(server);
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  if (failed) { console.log("失败项：", failures.join("; ")); process.exit(1); }
  console.log("全部通过。");
})();
