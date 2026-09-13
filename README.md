# 手摇风琴纸带打孔API

纯后端零依赖Node服务，使用 `data/db.json` 持久化曲目、纸带区间、试奏问题以及冲孔发布闭环数据（发布版、派发、返工单、离线回执合并）。

## 启动

```bash
PORT=3019 node server.js
```

可用 `DB_FILE=/path/to/db.json` 指定独立数据文件（测试用）。

## 校对接口（旧）

- `GET /health`
- `GET /tunes`
- `POST /tunes`
- `GET /tunes/:id/progress`
- `GET /tunes/:id/sections`
- `POST /tunes/:id/sections`
- `GET /tunes/:id/unchecked-sections`
- `PATCH /sections/:id/check`
- `GET /issues?tuneId=&status=`
- `POST /issues`
- `PATCH /issues/:id/status`

## 冲孔发布闭环接口

曲目按**已检查区间**生成不可变发布版，登记纸型、机台、操作员后派发；机器回执验收，不合格走返工单，返工后用新版本重试；两个离线回执按发布号合并。

### 发布版

- `GET /tunes/:id/publications` / `GET /publications?tuneId=` 列出发布版（含实时状态 `built|dispatched|accepted|rejected`）
- `POST /tunes/:id/publications` 建版。请求体：
  ```json
  {
    "holes": [{"beat": 5, "lane": 3}],
    "supersedesId": "可选，显式接续的旧版ID",
    "tempoBpm": 82, "paperType": "半透明纸带",
    "mmPerBeat": 25, "tapeLengthMm": 800
  }
  ```
  - 每个孔必须落在**已检查区间**的拍数与轨位范围内，重复孔/非法孔拒绝建版；
  - 发布版冻结孔位、期望孔数、偏移(0)、纸带长度、容差、节拍、纸型、区间快照、问题处理状态快照；
  - 最新版未派发时不允许空转建新 版；旧版有未完成返工单时阻塞后继建版。
- `GET /publications/:id` 详情（含返工单）
- `GET /publications/diff?from=<pubId>&to=<pubId>` 比较同曲两版：孔位增减与孔数差、节拍/纸型变化、区间变化、问题处理（新增/解决/重开/移除）。

### 派发（同一发布号只能派发一次）

- `POST /publications/:id/dispatch`
  ```json
  {"pubNo": "PUB-2026-001", "paperType": "半透明纸带", "machineId": "M-01", "operator": "阿珍"}
  ```
  - `pubNo` 全局唯一，重复派发返回 409 并回送已存在的派发记录；省略时自动生成；
  - 变更类请求在服务端串行化（读—校验—写同一临界区 + 临时文件原子落盘），**同发布号并发派发时恰好一个成功，其余 409 且不改动任何状态**；
  - 派发/验收后的版本只读。

### 回执与验收

- `POST /publications/:id/receipts` 在线回执：
  ```json
  {"holeCount": 3, "offsetMm": 0.4, "tapeLengthMm": 802}
  ```
  - 与发布版期望一致（孔数精确、偏移/长度在容差内）→ 200 `accepted`；
  - 不一致 → 422 `rejected`，自动生成返工单，按失配字段标出**责任区间**（孔数错覆盖全部区间、偏移标开头、长度标结尾）；
  - rejected 版本冻结，只能完成返工后建新发布版重试。
- `GET /reworks?status=open|completed&tuneId=`
- `POST /reworks/:id/complete` 完成返工（之后才能基于旧版建后继版本）。

### 双离线回执合并

- `POST /receipts/offline` 提交一个来源的离线回执：
  ```json
  {"pubNo": "PUB-2026-001", "source": "machine-log", "holeCount": 3, "offsetMm": 0.5, "tapeLengthMm": 800}
  ```
  同一发布号需两个不同 `source`；同源重复提交 409。
- `GET /receipts/offline/:pubNo` 查看原始回执。
- `GET /receipts/merge/:pubNo` 合并视图：逐字段给出 `agree` 与冲突清单（`conflictFields`）。
- `POST /receipts/merge/:pubNo/resolve` 逐项定版后验收：
  ```json
  {"resolutions": {"tapeLengthMm": "a", "offsetMm": 1.2}}
  ```
  - 一致字段自动取值；冲突字段必须逐项指定 `"a"`/`"b"`（按来源）或具体数值，缺一项返回 409；
  - 裁决值必须是有限数字（孔数为整数）：文本、空白、`null`、布尔、`Infinity`/`NaN` 一律拒绝（400/409），**不写入合并结果也不触碰发布版**，不会出现空值被验收合格；
  - 定版后按发布版期望执行验收（200 合格 / 422 返工）。

派发、验收、返工与版本血缘（`supersedes`/`supersededBy`）均持久化到 `db.json`，刷新重启后保持；旧版始终只读，不同版本可并存并随时比较。

## 端到端验证

```bash
node e2e-test.js          # 完整闭环 + 重启持久化 + 旧接口回归（57 项）
node e2e-concurrency.js   # 同号并发派发、非法裁决值、合法裁决（26 项）
```

均使用独立临时库与真实 HTTP 接口；并发用例自动重启服务验证唯一派发落盘。

## 旧闭环示例

```bash
curl http://127.0.0.1:3019/tunes/tune_demo/progress
curl -X POST http://127.0.0.1:3019/issues \
  -H 'Content-Type: application/json' \
  -d '{"tuneId":"tune_demo","sectionId":"section_demo_2","type":"错孔","beat":45,"lane":9,"description":"第45拍第9轨多打孔"}'
```
