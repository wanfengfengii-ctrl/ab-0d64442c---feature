# 海图经线网复原（Chart Meridian Restorer）

海图修复师扫描受潮航海图后，把按从左到右录入的 5–10 条经线残迹还原为同一套经线网。
系统对全部残迹做**全局裁决**（而非逐条按最近刻度解释、亦非逐段就近取整），联合确定：

- 严格递增的整数**经线序号**（首条残迹序号为 1）；
- 正的共同**网距** `spacing` 与**起始位置** `start`（序号 1 的拟合横坐标）；

使每条残迹偏差 `|x_i − fitted_i| ≤ tolerance`，并依次使：

1. **最大偏差最小**（minimax）；
2. **偏差平方和最小**（在前一级最优解集内）；
3. **相邻缺线数序列字典序最小**（在前两级最优解集内）。

若不存在满足误差约束的共同网距，页面与接口返回**首个无法满足误差约束的残迹**及其
**相邻已定序号区间**（前一条残迹在全体可行前缀拟合中可能的经线序号范围），以及该残迹
依缺线上限可落入的序号区间和理论可达的最小最大偏差。

## 目录结构

```
├── docker-compose.yml          # api / web / verify 编排（健康检查、可配置宿主机端口）
├── .env.example                # WEB_PORT / API_PORT 默认值
├── package.json                # npm workspaces 根
├── packages/
│   ├── solver/                 # 核心求解器（纯 ESM，无依赖，精确分数裁决）
│   │   ├── index.js            #   全局枚举 + 剪枝 DFS + 分数 LP/凸优化
│   │   ├── fraction.js         #   bigint 分数运算（三级裁决全部精确比较）
│   │   └── test/               #   node:test 单元测试（含独立参考实现交叉验证）
│   ├── api/                    # Express 业务 API
│   │   ├── src/server.js       #   POST /api/restore、GET /api/health、GET /api/schema
│   │   └── Dockerfile
│   └── web/                    # Vite + 原生 JS 单页应用
│       ├── index.html / src/   #   录入表单、结果表、缺线数与失败诊断展示
│       ├── nginx.conf          #   静态托管 + /api 反代
│       └── Dockerfile          #   多阶段：vite build → nginx
├── scripts/smoke.mjs           # verify 服务入口：测试 + 前端构建 + API 冒烟
└── verify/Dockerfile           # 一次性验证镜像
```

## 快速开始（Docker Compose）

```bash
docker compose up --build            # 启动 api + web（verify 为一次性服务，随启动跑一次）
# 打开 http://localhost:8080
```

宿主机端口可通过环境变量或 `.env`（见 `.env.example`）配置：

```bash
WEB_PORT=9000 API_PORT=3100 docker compose up --build
```

## 一键验证（verify 一次性服务）

`verify` 在 `api`、`web` 健康检查后启动，依次执行：求解器单元测试 → 前端构建 →
复原 API 冒烟（精确网格 / 全局裁决 / 不可行诊断 / 参数校验 / Web 反代链路），
并以**退出码**报告结果：

```bash
docker compose up --build --exit-code-from=verify verify
echo $?        # 0 = 全部通过，非 0 = 有步骤失败
docker compose down
```

## 本地开发

```bash
npm install
npm test                 # 求解器单元测试（node:test）
npm run build            # 前端构建（vite build）
npm run dev -w @chart/web   # 前端开发服务器（/api 代理到 localhost:3000）
npm start -w @chart/api     # 或 PORT=3000 node packages/api/src/server.js
npm run smoke            # 对本地运行的 API 执行与 verify 相同的冒烟
```

## API

### `POST /api/restore`

请求：

```json
{
  "x": [10, 30, 50, 80, 100],
  "maxGaps": [3, 3, 3, 3],
  "tolerance": 0
}
```

- `x`：5–10 个严格递增的整数横坐标（±1e6 内）；
- `maxGaps`：长度 = 残迹数 − 1，每段相邻残迹间可能缺失的经线数上限（0–100 整数）；
- `tolerance`：允许定位误差（0–1e6 数值）。

成功 `200`：

```json
{
  "ok": true,
  "spacing": 10,
  "start": 10,
  "maxDeviation": 0,
  "squaredDeviations": 0,
  "indices": [1, 3, 5, 8, 10],
  "items": [
    { "position": 1, "x": 10, "index": 1, "fitted": 10, "deviation": 0 }
  ],
  "gapsFilled": [1, 1, 2, 1]
}
```

- `items[].index`：该残迹的经线序号；`fitted`：拟合位置；`deviation = x − fitted`；
- `gapsFilled[j]`：第 j 与 j+1 条残迹之间补出的缺线数。

不存在共同网距 `422`：

```json
{
  "ok": false,
  "code": "NO_COMMON_SPACING",
  "message": "不存在满足误差约束的共同网距：第 3 条残迹无法纳入同一经线网",
  "minAchievableMaxDeviation": 2.8333,
  "firstFailingTrace": 3,
  "previousIndexRange": [2, 2],
  "allowedIndexRange": [3, 3]
}
```

参数非法 `400`（`errors` 列出全部问题）；搜索空间超限 `500`（`SEARCH_BUDGET`）。

其他：`GET /api/health`（健康检查）、`GET /api/schema`（输入约束）。

## 求解方法（为什么不是逐段就近取整）

对候选整数步长向量 `g`（`g_j = 缺线数 + 1`，序号前缀和 `P`），拟合 `x_i ≈ s + d·P_i`：

1. **可行性判定**：残差上限 `R` 可行 ⟺ 所有点对约束 `|(x_t−x_i) − d(P_t−P_i)| ≤ 2R`
   存在共同 `d > 0`（区间交判定）。DFS 从左到右指派步长并维护 `d` 的可行区间交，
   剪枝后枚举量在实际输入下接近线性。
2. **最小最大偏差 `R*`**：固定 `g` 时，散布函数是关于 `d` 的凸分段线性函数，
   最小值必在直线的同号或异号（等幅振荡）交点处；候选点有限，用 **bigint 分数**
   精确求值。二分 + 近最优层枚举确定全局 `R*`。
3. **偏差平方和**：在 `R*` 可行层内，SSE 是关于 `d` 的凸分段二次函数，候选点
   （无约束驻点、边界驻点、拐点、可行区间端点）有限，分数精确比较。
4. **字典序**：DFS 按步长字典序枚举，前两级并列时保留首个（缺线数序列字典序最小）。

三级裁决全部使用分数精确比较，不存在浮点并列误判。单元测试包含与独立参考实现
（黄金分割凸搜索 + 暴力枚举）的随机交叉验证。
