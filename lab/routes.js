'use strict';

// ===============================
// LAB ROUTES — /desk/lab/*
//
// Read-only, every one behind the v2 signature. Query parameters are
// enums checked against a list: anything else is a 400 with the
// reason, never a silent default.
// ===============================

function parseEnum(value, allowed, fallback) {
  if (value === undefined) return { ok: true, value: fallback };
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return { ok: false, error: `Expected one of ${allowed.join(', ')}` };
  }
  return { ok: true, value };
}

function mountLabRoutes(app, { guard, lab }) {
  app.get('/desk/lab/status', guard(async (req, res) => {
    res.json(lab.status());
  }));

  app.get('/desk/lab/state', guard(async (req, res) => {
    const model = parseEnum(req.query.model, ['hex'], 'hex');
    if (!model.ok) return res.status(400).json({ ok: false, error: `model: ${model.error}` });
    res.json(lab.state());
  }));

  app.get('/desk/lab/report', guard(async (req, res) => {
    const model = parseEnum(req.query.model, ['hex', 'linear'], 'hex');
    if (!model.ok) return res.status(400).json({ ok: false, error: `model: ${model.error}` });
    res.json(lab.report(model.value));
  }));
}

module.exports = { mountLabRoutes, parseEnum };
