const express = require('express');
const { spawn } = require('child_process');
const https = require('https');
const http  = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || '';

// ── CORS ──────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json());

// ── PING / HEALTH ─────────────────────────────────────────────────────
app.get('/ping',   (_, res) => res.json({ status: 'ok', ts: Date.now() }));
app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── PROBE ─────────────────────────────────────────────────────────────
app.get('/probe', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ status: 'error', error: 'Falta url' });
  try {
    const info = await ffprobe(url);
    res.json({ status: 'ok', data: info });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message });
  }
});

// ── STREAM ────────────────────────────────────────────────────────────
app.get('/stream', (req, res) => {
  const url    = req.query.url;
  const audio  = parseInt(req.query.audio || '0', 10);
  const sub    = parseInt(req.query.sub   || '-1', 10);
  const seek   = parseFloat(req.query.seek || '0');
  const vcodec = req.query.vcodec || 'copy';

  if (!url) return res.status(400).json({ error: 'Falta url' });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  const args = [
    // ── Buffer generoso para streams HTTP remotos ──
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-http_persistent', '0',
    // Buffer de lectura: 32MB para evitar stalls en picos de red
    '-buffer_size', '32768k',
    // Análisis rápido — ya hicimos probe antes
    '-probesize', '1000000',
    '-analyzeduration', '1000000',
    '-loglevel', 'warning',
  ];

  // Seek keyframe antes del input (más rápido)
  if (seek > 0) args.push('-ss', String(seek));

  args.push('-i', url);

  // Mapeo de streams
  args.push('-map', '0:v:0');
  args.push('-map', audio >= 0 ? `0:a:${audio}` : '0:a:0');
  if (sub >= 0) {
    args.push('-map', `0:s:${sub}`);
    args.push('-c:s', 'mov_text');
  }

  // Video: copiar sin recodificar (cero CPU, cero latencia)
  args.push('-c:v', vcodec === 'h264' ? 'libx264' : 'copy');

  // Audio: AAC stereo compatible con todos los browsers
  // -af aresample: normaliza muestras rotas de AC3/DTS/Atmos
  args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  args.push('-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0');

  // MP4 fragmentado streameable (el cliente empieza a reproducir apenas llegan los primeros fragments)
  args.push(
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '2000000',   // fragmento cada 2 seg
    '-min_frag_duration', '1000000',
    '-f', 'mp4',
    'pipe:1'
  );

  console.log('[stream] ffmpeg', args.filter(a => a !== url).join(' '));

  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Backpressure: si el cliente es lento, pausar ffmpeg stdout
  ff.stdout.pipe(res, { end: true });

  ff.stderr.on('data', d => {
    const msg = d.toString();
    // Solo loguear errores reales, no warnings de codec
    if (msg.includes('Error') || msg.includes('error') || msg.includes('Invalid')) {
      process.stderr.write('[ffmpeg] ' + msg);
    }
  });

  ff.on('error', err => {
    console.error('[stream] spawn error:', err.message);
    if (!res.headersSent) res.status(500).end();
  });

  ff.on('close', code => {
    if (code && code !== 0 && code !== 255) {
      console.warn(`[stream] ffmpeg salió con código ${code}`);
    }
    if (!res.writableEnded) res.end();
  });

  // Cliente se desconectó — matar ffmpeg inmediatamente
  req.on('close', () => {
    ff.kill('SIGKILL');
  });
});

// ── SUBTITLE ─────────────────────────────────────────────────────────
app.get('/subtitle', (req, res) => {
  const url = req.query.url;
  const idx = parseInt(req.query.index || '0', 10);
  if (!url) return res.status(400).json({ error: 'Falta url' });

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');

  const args = [
    '-loglevel', 'error',
    '-probesize', '2000000',
    '-i', url,
    '-map', `0:s:${idx}`,
    '-c:s', 'webvtt',
    '-f', 'webvtt',
    'pipe:1'
  ];

  const ff = spawn('ffmpeg', args);
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => process.stderr.write(d));
  ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  ff.on('close', () => { if (!res.writableEnded) res.end(); });
  req.on('close', () => ff.kill('SIGKILL'));
});

// ── FFPROBE ───────────────────────────────────────────────────────────
function ffprobe(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      // Solo leer los primeros 5MB — suficiente para detectar todas las pistas
      '-probesize', '5000000',
      '-analyzeduration', '3000000',
      url
    ];

    const ff = spawn('ffprobe', args);
    let out = '';
    let err = '';

    ff.stdout.on('data', d => out += d);
    ff.stderr.on('data', d => err += d);

    ff.on('close', code => {
      if (code !== 0) return reject(new Error(err || `ffprobe exit ${code}`));
      try {
        const json = JSON.parse(out);
        const streams = json.streams || [];

        const audio = streams
          .filter(s => s.codec_type === 'audio')
          .map((s, i) => ({
            index: i,
            codec: s.codec_name,
            language: s.tags?.language || s.tags?.LANGUAGE || '',
            title: s.tags?.title || s.tags?.TITLE || '',
            channels: s.channels || 2,
            label: buildAudioLabel(s, i)
          }));

        const subtitles = streams
          .filter(s => s.codec_type === 'subtitle')
          .map((s, i) => ({
            index: i,
            codec: s.codec_name,
            language: s.tags?.language || s.tags?.LANGUAGE || '',
            title: s.tags?.title || s.tags?.TITLE || '',
            label: buildSubLabel(s, i)
          }));

        const duration = parseFloat(json.format?.duration || 0);
        resolve({ audio, subtitles, duration, format: json.format });
      } catch (e) {
        reject(new Error('No se pudo parsear ffprobe: ' + e.message));
      }
    });

    ff.on('error', reject);
  });
}

function buildAudioLabel(s, i) {
  const lang  = (s.tags?.language || s.tags?.LANGUAGE || '').toUpperCase();
  const title = s.tags?.title || s.tags?.TITLE || '';
  const codec = (s.codec_name || '').toUpperCase();
  const ch    = s.channels === 6 ? '5.1' : s.channels === 2 ? 'Stereo' : (s.channels + 'ch');
  const parts = [];
  if (lang && lang !== 'UND') parts.push(lang);
  if (title) parts.push(title);
  parts.push(codec, ch);
  return parts.join(' · ') || `Pista ${i + 1}`;
}

function buildSubLabel(s, i) {
  const lang  = (s.tags?.language || s.tags?.LANGUAGE || '').toUpperCase();
  const title = s.tags?.title || s.tags?.TITLE || '';
  const parts = [];
  if (lang && lang !== 'UND') parts.push(lang);
  if (title) parts.push(title);
  return parts.join(' · ') || `Sub ${i + 1}`;
}

// ── SELF-PING keep-alive ──────────────────────────────────────────────
function selfPing() {
  if (!RENDER_URL) return;
  const url = `${RENDER_URL}/ping`;
  const mod = url.startsWith('https') ? https : http;
  mod.get(url, res => {
    console.log(`[keep-alive] ping → ${res.statusCode}`);
  }).on('error', err => {
    console.warn('[keep-alive] error:', err.message);
  });
}
setTimeout(() => {
  selfPing();
  setInterval(selfPing, 10 * 60 * 1000);
}, 5 * 60 * 1000);

// ── START ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`StreamBox Transcoder en puerto ${PORT}`);
  console.log(`URL: ${RENDER_URL || '(local)'}`);
});
