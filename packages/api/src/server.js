import express from 'express';
import { solve, solveWithIsolation, LIMITS, ValidationError, SearchBudgetError } from '@chart/solver';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '32kb' }));

  // The SPA is served same-origin (nginx proxies /api), but allow direct
  // cross-origin calls for local tooling.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/api/schema', (req, res) => {
    res.json({
      traces: { min: LIMITS.minTraces, max: LIMITS.maxTraces },
      maxAbsX: LIMITS.maxAbsX,
      maxMissingPerGap: LIMITS.maxGap,
      maxTolerance: LIMITS.maxTolerance,
    });
  });

  app.post('/api/restore', (req, res) => {
    try {
      const body = req.body;
      // Isolation review is opt-in: requests without the isolationReview key
      // take the exact pre-existing code path and verdicts.
      const review =
        body && typeof body === 'object' && !Array.isArray(body) && 'isolationReview' in body;
      const result = review ? solveWithIsolation(body) : solve(body);
      if (result.ok) return res.json(result);
      // 422 covers both NO_COMMON_SPACING (no common grid satisfies the
      // tolerance) and ISOLATION_IMPOSSIBLE (no single provably foreign
      // trace): the payload carries the diagnosis either way.
      return res.status(422).json(result);
    } catch (err) {
      if (err instanceof ValidationError) {
        return res.status(400).json({ ok: false, code: err.code, errors: err.errors });
      }
      if (err instanceof SearchBudgetError) {
        return res.status(500).json({ ok: false, code: err.code, message: err.message });
      }
      throw err;
    }
  });

  // JSON parse failures and unknown routes
  app.use((req, res) => {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '接口不存在' });
  });
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res.status(400).json({ ok: false, code: 'BAD_JSON', errors: ['请求体不是合法 JSON'] });
    }
    console.error(err);
    res.status(500).json({ ok: false, code: 'INTERNAL', message: '服务内部错误' });
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`meridian restore API listening on :${port}`);
  });
}
