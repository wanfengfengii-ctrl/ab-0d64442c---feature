import { spawnSync } from 'node:child_process';

// One-shot verification: solver unit tests, frontend build, restore-API smoke.
// Exit code 0 iff every step passes.

const API = (process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const WEB = (process.env.WEB_BASE_URL || '').replace(/\/+$/, '');

let failures = 0;

function pass(name) {
  console.log(`\x1b[32m✔ ${name}\x1b[0m`);
}
function fail(name, detail = '') {
  failures++;
  console.error(`\x1b[31m✘ ${name}${detail ? ` — ${detail}` : ''}\x1b[0m`);
}

function runStep(name, cmd, args) {
  console.log(`\n=== ${name} ===`);
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status === 0) pass(name);
  else fail(name, `exit code ${r.status}`);
}

async function check(name, fn) {
  console.log(`\n=== ${name} ===`);
  try {
    await fn();
    pass(name);
  } catch (err) {
    fail(name, err.message);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function postJSON(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, body: await resp.json() };
}

async function waitForHealth(url, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`等待健康检查超时：${url}`);
}

// 1. solver unit tests
runStep('代码测试（求解器单元测试）', 'npm', ['test']);

// 2. frontend build
runStep('前端构建（vite build）', 'npm', ['run', 'build']);

// 3. API smoke
await check('API 健康检查', () => waitForHealth(`${API}/api/health`));

await check('复原 API 冒烟：精确网格', async () => {
  const { status, body } = await postJSON(`${API}/api/restore`, {
    x: [10, 30, 50, 80, 100],
    maxGaps: [3, 3, 3, 3],
    tolerance: 0,
  });
  assert(status === 200, `HTTP ${status}`);
  assert(body.ok === true, 'body.ok !== true');
  assert(Math.abs(body.spacing - 10) < 1e-9, `spacing=${body.spacing}`);
  assert(Math.abs(body.start - 10) < 1e-9, `start=${body.start}`);
  assert(body.maxDeviation < 1e-9, `maxDeviation=${body.maxDeviation}`);
  assert(
    JSON.stringify(body.indices) === JSON.stringify([1, 3, 5, 8, 10]),
    `indices=${JSON.stringify(body.indices)}`,
  );
  assert(
    JSON.stringify(body.gapsFilled) === JSON.stringify([1, 1, 2, 1]),
    `gapsFilled=${JSON.stringify(body.gapsFilled)}`,
  );
  assert(body.items.length === 5 && body.items[2].index === 5, 'items 内容不符');
});

await check('复原 API 冒烟：全局裁决（非逐段取整）', async () => {
  const { status, body } = await postJSON(`${API}/api/restore`, {
    x: [0, 9, 21, 30, 40],
    maxGaps: [1, 1, 1, 1],
    tolerance: 1,
  });
  assert(status === 200, `HTTP ${status}`);
  assert(body.ok === true, 'body.ok !== true');
  assert(
    JSON.stringify(body.indices) === JSON.stringify([1, 2, 3, 4, 5]),
    `indices=${JSON.stringify(body.indices)}`,
  );
  assert(Math.abs(body.spacing - 31 / 3) < 1e-6, `spacing=${body.spacing}`);
  assert(Math.abs(body.maxDeviation - 5 / 6) < 1e-6, `maxDeviation=${body.maxDeviation}`);
  assert(body.maxDeviation <= 1, 'maxDeviation 超过限值');
});

await check('复原 API 冒烟：不可行诊断', async () => {
  const { status, body } = await postJSON(`${API}/api/restore`, {
    x: [0, 10, 11, 20, 30],
    maxGaps: [0, 0, 0, 0],
    tolerance: 0.4,
  });
  assert(status === 422, `HTTP ${status}`);
  assert(body.ok === false && body.code === 'NO_COMMON_SPACING', `code=${body.code}`);
  assert(body.firstFailingTrace === 3, `firstFailingTrace=${body.firstFailingTrace}`);
  assert(
    JSON.stringify(body.previousIndexRange) === JSON.stringify([2, 2]),
    `previousIndexRange=${JSON.stringify(body.previousIndexRange)}`,
  );
  assert(
    JSON.stringify(body.allowedIndexRange) === JSON.stringify([3, 3]),
    `allowedIndexRange=${JSON.stringify(body.allowedIndexRange)}`,
  );
});

await check('复原 API 冒烟：参数校验', async () => {
  const { status, body } = await postJSON(`${API}/api/restore`, {
    x: [1, 2, 3],
    maxGaps: [0, 0],
    tolerance: 1,
  });
  assert(status === 400, `HTTP ${status}`);
  assert(body.ok === false && Array.isArray(body.errors) && body.errors.length > 0, '缺少 errors');
});

if (WEB) {
  await check('Web 页面可访问', async () => {
    const resp = await fetch(`${WEB}/`);
    assert(resp.status === 200, `HTTP ${resp.status}`);
    const html = await resp.text();
    assert(html.includes('海图经线网复原'), '页面标题缺失');
  });

  await check('经 Web 反代调用复原 API', async () => {
    const { status, body } = await postJSON(`${WEB}/api/restore`, {
      x: [10, 30, 50, 80, 100],
      maxGaps: [3, 3, 3, 3],
      tolerance: 0,
    });
    assert(status === 200 && body.ok === true, `HTTP ${status}`);
    assert(Math.abs(body.spacing - 10) < 1e-9, `spacing=${body.spacing}`);
  });
}

console.log('');
if (failures > 0) {
  console.error(`\x1b[31m验证失败：${failures} 个步骤未通过\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32m全部验证通过\x1b[0m');
process.exit(0);
