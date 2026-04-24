'use strict';
const express = require('express');
const multer  = require('multer');
const { PDFDocument } = require('pdf-lib');
const { randomBytes } = require('crypto');
const { join } = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// sessions: token → { images, sseRes, pdfBuffer, createdAt }
const sessions = new Map();

// Clean expired sessions every 30 min
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [token, s] of sessions)
    if (s.createdAt < cutoff) sessions.delete(token);
}, 30 * 60 * 1000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }
});

app.use(express.static(__dirname));

// ── Create session ────────────────────────────────────────────────────────────
app.get('/api/session', (req, res) => {
  const token = randomBytes(16).toString('hex');
  sessions.set(token, { images: [], sseRes: null, pdfBuffer: null, createdAt: Date.now() });
  res.json({ token });
});

// ── Check session ─────────────────────────────────────────────────────────────
app.get('/api/session/:token', (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s) return res.status(404).json({ error: 'Sesion no encontrada' });
  res.json({ count: s.images.length, pdfReady: !!s.pdfBuffer });
});

// ── SSE — computer listens here for real-time updates ────────────────────────
app.get('/api/events/:token', (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  s.sseRes = res;

  const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 25000);
  req.on('close', () => {
    clearInterval(ping);
    const session = sessions.get(req.params.token);
    if (session) session.sseRes = null;
  });
});

function notify(token, data) {
  const s = sessions.get(token);
  if (s && s.sseRes) {
    try { s.sseRes.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  }
}

// ── Upload image from phone ───────────────────────────────────────────────────
app.post('/api/upload/:token', upload.single('photo'), (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s)         return res.status(404).json({ error: 'Sesion invalida' });
  if (!req.file)  return res.status(400).json({ error: 'Sin imagen' });

  s.images.push({ buffer: req.file.buffer, mimetype: req.file.mimetype });
  notify(req.params.token, { type: 'count', count: s.images.length });
  res.json({ ok: true, count: s.images.length });
});

// ── Delete last image ─────────────────────────────────────────────────────────
app.delete('/api/upload/:token/last', (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s || s.images.length === 0) return res.status(404).json({ error: 'Sin imagenes' });

  s.images.pop();
  notify(req.params.token, { type: 'count', count: s.images.length });
  res.json({ ok: true, count: s.images.length });
});

// ── Generate PDF ──────────────────────────────────────────────────────────────
app.post('/api/pdf/:token', async (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s)                   return res.status(404).json({ error: 'Sesion invalida' });
  if (!s.images.length)     return res.status(400).json({ error: 'No hay imagenes' });

  try {
    const pdf = await PDFDocument.create();

    for (const { buffer, mimetype } of s.images) {
      const img  = mimetype === 'image/png'
        ? await pdf.embedPng(buffer)
        : await pdf.embedJpg(buffer);
      const page = pdf.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }

    const pages = s.images.length;
    s.pdfBuffer = Buffer.from(await pdf.save());
    s.images    = [];

    notify(req.params.token, { type: 'pdf_ready', token: req.params.token, pages });
    res.json({ ok: true, pages });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generando PDF' });
  }
});

// ── Download PDF — triggered automatically by the computer browser ────────────
app.get('/api/download/:token', (req, res) => {
  const s = sessions.get(req.params.token);
  if (!s || !s.pdfBuffer) return res.status(404).json({ error: 'PDF no disponible' });

  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="documento_${date}.pdf"`);
  res.send(s.pdfBuffer);
  sessions.delete(req.params.token);
});

// ── Pages ─────────────────────────────────────────────────────────────────────
app.get('/scan', (req, res) => res.sendFile(join(__dirname, 'scan.html')));
app.get('/',     (req, res) => res.sendFile(join(__dirname, 'index.html')));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`DocScan corriendo en http://localhost:${PORT}`)
);
