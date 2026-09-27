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
const errList = document.querySelector('#input-errors');
const resultPanel = document.querySelector('#result-panel');
const failurePanel = document.querySelector('#failure-panel');
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
  return { payload: { x, maxGaps, tolerance }, errors };
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
  const gaps = r.gapsFilled.map((g, j) => `${j + 1}→${j + 2}: ${g}`).join('　');
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
