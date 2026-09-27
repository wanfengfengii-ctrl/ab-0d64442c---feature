import './style.css';

const MIN_TRACES = 5;
const MAX_TRACES = 10;

const tbody = document.querySelector('#trace-tbody');
const addBtn = document.querySelector('#add-trace');
const removeBtn = document.querySelector('#remove-trace');
const restoreBtn = document.querySelector('#restore');
const sampleBtn = document.querySelector('#fill-sample');
const clearBtn = document.querySelector('#clear-all');
const tolInput = document.querySelector('#tolerance');
const isoCheckbox = document.querySelector('#isolation-review');
const errList = document.querySelector('#input-errors');
const resultPanel = document.querySelector('#result-panel');
const failurePanel = document.querySelector('#failure-panel');
const resultTitle = document.querySelector('#result-title');
const failureTitle = document.querySelector('#failure-title');
const resultStats = document.querySelector('#result-stats');
const resultTbody = document.querySelector('#result-tbody');
const failureBody = document.querySelector('#failure-body');

function renderRows(count) {
  const had = tbody.querySelectorAll('tr').length;
  if (count > had) {
    for (let i = had; i < count; i++) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="pos">${i + 1}</td>
        <td><input class="x-input" inputmode="numeric" placeholder="整数" /></td>
        <td><input class="g-input" inputmode="numeric" placeholder="0–100" /></td>`;
      tbody.appendChild(tr);
    }
  } else if (count < had) {
    for (let i = had; i > count; i--) tbody.lastElementChild.remove();
  }
  updateButtons();
}

function updateButtons() {
  const n = tbody.querySelectorAll('tr').length;
  addBtn.disabled = n >= MAX_TRACES;
  removeBtn.disabled = n <= MIN_TRACES;
}

function collectPayload() {
  const rows = [...tbody.querySelectorAll('tr')];
  const x = [];
  const maxGaps = [];
  const errors = [];
  rows.forEach((tr, i) => {
    const xv = tr.querySelector('.x-input').value.trim();
    if (xv === '') {
      errors.push(`第 ${i + 1} 条残迹横坐标为空`);
      return;
    }
    const xi = Number(xv);
    if (!Number.isInteger(xi)) {
      errors.push(`第 ${i + 1} 条残迹横坐标必须是整数`);
      return;
    }
    x.push(xi);
    if (i < rows.length - 1) {
      const gv = tr.querySelector('.g-input').value.trim();
      if (gv === '') {
        errors.push(`第 ${i}→${i + 1} 条残迹之间的缺线上限为空`);
        return;
      }
      const gi = Number(gv);
      if (!Number.isInteger(gi) || gi < 0 || gi > 100) {
        errors.push(`第 ${i}→${i + 1} 条残迹之间的缺线上限必须是 0–100 的整数`);
        return;
      }
      maxGaps.push(gi);
    }
  });
  if (x.length === rows.length) {
    for (let i = 1; i < x.length; i++) {
      if (x[i] <= x[i - 1]) {
        errors.push('横坐标必须严格递增（残迹按从左到右录入）');
        break;
      }
    }
  }
  const tolerance = Number(tolInput.value);
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    errors.push('允许定位误差必须是非负数值');
  }
  const payload = { x, maxGaps, tolerance };
  // 仅在勾选时携带隔离复核开关，未启用时请求与既有录入完全一致。
  if (isoCheckbox.checked) payload.isolationReview = true;
  return { payload, errors };
}

function fmt(v, digits = 4) {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(digits)));
}

function showErrors(errors) {
  errList.replaceChildren();
  for (const e of errors) {
    const li = document.createElement('li');
    li.textContent = e;
    errList.appendChild(li);
  }
}

function showResult(r) {
  failurePanel.classList.add('hidden');
  resultPanel.classList.remove('hidden');
  resultTitle.textContent = r.isolation ? '复原结果（隔离复核）' : '复原结果';
  // Isolation banner: the distrusted trace and the evidence that it exceeds
  // the tolerance on the restored grid.
  let banner = resultPanel.querySelector('.isolation-banner');
  if (r.isolation) {
    const iso = r.isolation;
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'isolation-banner';
      resultPanel.insertBefore(banner, resultStats);
    }
    const evidence =
      iso.reachableIndexRange === null
        ? `<dt>超出容差的证据</dt><dd>可达序号区间为空：该残迹在共同网格上不存在任何可落入的序号位置，必然超出容差 ${fmt(iso.tolerance, 6)}</dd>`
        : `<dt>可达序号区间</dt><dd>${iso.reachableIndexRange[0]} – ${iso.reachableIndexRange[1]}</dd>
           <dt>最近拟合位置</dt><dd>${fmt(iso.nearestFitted, 6)}（序号 ${iso.nearestIndex}）</dd>
           <dt>超出容差的证据</dt><dd>最小偏差 ${fmt(iso.minDeviation, 6)} &gt; 容差 ${fmt(iso.tolerance, 6)}（超出 ${fmt(iso.exceedsToleranceBy, 6)}）</dd>`;
    banner.innerHTML = `
      <p><strong>暂不采信第 ${iso.position} 条残迹</strong>（录入横坐标 ${iso.x}），其余残迹共享同一经线网。</p>
      <dl class="diag">${evidence}</dl>`;
  } else if (banner) {
    banner.remove();
  }
  resultStats.innerHTML = `
    <div><dt>共同网距</dt><dd>${fmt(r.spacing, 6)}</dd></div>
    <div><dt>起始位置（序号 1）</dt><dd>${fmt(r.start, 6)}</dd></div>
    <div><dt>最大偏差</dt><dd>${fmt(r.maxDeviation, 6)}</dd></div>
    <div><dt>偏差平方和</dt><dd>${fmt(r.squaredDeviations, 6)}</dd></div>`;
  resultTbody.replaceChildren();
  r.items.forEach((it) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${it.position}</td>
      <td>${it.x}</td>
      <td>${it.index}</td>
      <td>${fmt(it.fitted, 6)}</td>
      <td class="${Math.abs(it.deviation) > 1e-9 ? 'dev' : 'zero'}">${fmt(it.deviation, 6)}</td>`;
    resultTbody.appendChild(tr);
  });
  // Render the per-gap fill counts as an annotated row beneath the table.
  const pos = r.items.map((it) => it.position);
  const gaps = r.gapsFilled.map((g, j) => `${pos[j]}→${pos[j + 1]}: ${g}`).join('　');
  let note = resultPanel.querySelector('.gaps-note');
  if (!note) {
    note = document.createElement('p');
    note.className = 'note gaps-note';
    resultPanel.appendChild(note);
  }
  note.textContent = `两残迹间补出的缺线数（按相邻残迹对）：${gaps}`;
}

function showFailure(r) {
  resultPanel.classList.add('hidden');
  failurePanel.classList.remove('hidden');
  if (r.code === 'ISOLATION_IMPOSSIBLE') {
    failureTitle.textContent = '隔离复核无法成立';
    const b = r.firstBasis;
    let detail;
    if (b.reason === 'REMAINDER_INFEASIBLE') {
      const d = b.diagnosis;
      detail = `
        <dt>不能隔离的首项依据</dt>
        <dd>隔离第 ${b.position} 条残迹后，其余残迹仍不存在满足误差约束的共同网距</dd>
        <dt>其中首个无法纳入同一经线网的残迹</dt>
        <dd>第 ${d.firstFailingTrace} 条（按录入顺序）</dd>
        <dt>相邻已定序号区间（前一条残迹可能的经线序号）</dt>
        <dd>${d.previousIndexRange[0]} – ${d.previousIndexRange[1]}</dd>
        <dt>该残迹依缺线上限可落入的序号区间</dt>
        <dd>${d.allowedIndexRange[0]} – ${d.allowedIndexRange[1]}</dd>
        <dt>理论可达的最小最大偏差</dt>
        <dd>${fmt(d.minAchievableMaxDeviation, 6)}（超过限值）</dd>`;
    } else {
      const e = b.evidence;
      detail = `
        <dt>不能隔离的首项依据</dt>
        <dd>隔离第 ${b.position} 条残迹（录入横坐标 ${e.x}）后，其与网格可达序号位置的最小偏差未超过容差，无法证明其不属于该网格</dd>
        <dt>可达序号区间</dt>
        <dd>${e.reachableIndexRange[0]} – ${e.reachableIndexRange[1]}</dd>
        <dt>最近拟合位置</dt>
        <dd>${fmt(e.nearestFitted, 6)}（序号 ${e.nearestIndex}）</dd>
        <dt>最小偏差 / 容差</dt>
        <dd>${fmt(e.minDeviation, 6)} ≤ ${fmt(e.tolerance, 6)}</dd>`;
    }
    failureBody.innerHTML = `<p class="failure-msg">${r.message}</p><dl class="diag">${detail}</dl>`;
    return;
  }
  failureTitle.textContent = '无法复原';
  const [a, b] = r.previousIndexRange;
  const [c, d] = r.allowedIndexRange;
  failureBody.innerHTML = `
    <p class="failure-msg">${r.message}</p>
    <dl class="diag">
      <dt>首个无法满足误差约束的残迹</dt>
      <dd>第 ${r.firstFailingTrace} 条（按录入顺序）</dd>
      <dt>相邻已定序号区间（前一条残迹可能的经线序号）</dt>
      <dd>${a} – ${b}</dd>
      <dt>该残迹依缺线上限可落入的序号区间</dt>
      <dd>${c} – ${d}</dd>
      <dt>理论可达的最小最大偏差</dt>
      <dd>${fmt(r.minAchievableMaxDeviation, 6)}（超过限值，故不存在共同网距）</dd>
    </dl>`;
}

async function restore() {
  showErrors([]);
  resultPanel.classList.add('hidden');
  failurePanel.classList.add('hidden');
  const { payload, errors } = collectPayload();
  if (errors.length) {
    showErrors(errors);
    return;
  }
  restoreBtn.disabled = true;
  restoreBtn.textContent = '复原中…';
  try {
    const resp = await fetch('/api/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const r = await resp.json();
    if (resp.ok && r.ok) showResult(r);
    else if (resp.status === 422) showFailure(r);
    else if (r.errors) showErrors(r.errors);
    else showErrors([r.message || '复原失败']);
  } catch (e) {
    showErrors([`API 请求失败：${e.message}`]);
  } finally {
    restoreBtn.disabled = false;
    restoreBtn.textContent = '复原';
  }
}

addBtn.addEventListener('click', () => renderRows(tbody.querySelectorAll('tr').length + 1));
removeBtn.addEventListener('click', () => renderRows(tbody.querySelectorAll('tr').length - 1));
restoreBtn.addEventListener('click', restore);
clearBtn.addEventListener('click', () => {
  tbody.querySelectorAll('input').forEach((i) => (i.value = ''));
  tolInput.value = '2';
  isoCheckbox.checked = false;
  showErrors([]);
  resultPanel.classList.add('hidden');
  failurePanel.classList.add('hidden');
});
sampleBtn.addEventListener('click', () => {
  const x = [6, 45, 59, 110, 124, 188, 306, 331, 411, 476];
  const maxGaps = Array(9).fill(20);
  renderRows(x.length);
  [...tbody.querySelectorAll('tr')].forEach((tr, i) => {
    tr.querySelector('.x-input').value = x[i];
    if (i < x.length - 1) tr.querySelector('.g-input').value = maxGaps[i];
  });
  tolInput.value = '2';
});

renderRows(MIN_TRACES);
