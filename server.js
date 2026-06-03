const express = require('express');
const { spawn } = require('child_process');
const https = require('https');
const http = require('http');

const app = express();
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
// Endpoint que StreamBox llama para verificar si el servidor está despierto
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ── PROBE — analiza pistas de audio/subtítulos/duración ───────────────
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

// ── STREAM — remuxea/transcodea el video en tiempo real ──────────────
app.get('/stream', (req, res) => {
  const url   = req.query.url;
  const audio = parseInt(req.query.audio  || '0', 10);
  const sub   = parseInt(req.query.sub    || '-1', 10);
  const seek  = parseFloat(req.query.seek || '0');
  const vcodec = req.query.vcodec || 'copy'; // 'copy' = sin recodificar video

  if (!url) return res.status(400).json({ error: 'Falta url' });

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Transfer-Encoding', 'chunked');

  const args = [
    '-loglevel', 'error',
  ];

  // Seek antes del input es más rápido (seek por keyframe)
  if (seek > 0) args.push('-ss', String(seek));

  args.push('-i', url);

  // Selección de pista de audio
  args.push('-map', '0:v:0');
  if (audio >= 0) {
    args.push('-map', `0:a:${audio}`);
  } else {
    args.push('-map', '0:a:0');
  }

  // Subtítulos embebidos si se piden
  if (sub >= 0) {
    args.push('-map', `0:s:${sub}`);
    args.push('-c:s', 'mov_text');
  }

  // Video: copiar sin recodificar (instantáneo)
  args.push('-c:v', vcodec === 'h264' ? 'libx264' : 'copy');

  // Audio: convertir a AAC (compatible con todos los browsers)
  args.push('-c:a', 'aac');
  args.push('-b:a', '192k');
  args.push('-ac', '2'); // stereo (mezcla Dolby/5.1 a stereo)

  // Formato MP4 streameable
  args.push('-movflags', 'frag_keyframe+empty_moov+faststart');
  args.push('-f', 'mp4');
  args.push('pipe:1'); // output a stdout

  console.log('[stream] ffmpeg args:', args.join(' '));

  const ff = spawn('ffmpeg', args);

  ff.stdout.pipe(res);

  ff.stderr.on('data', d => process.stderr.write(d));

  ff.on('error', err => {
    console.error('[stream] ffmpeg error:', err.message);
    if (!res.headersSent) res.status(500).end();
  });

  ff.on('close', code => {
    console.log(`[stream] ffmpeg exit code: ${code}`);
    res.end();
  });

  req.on('close', () => {
    console.log('[stream] Cliente desconectó — matando ffmpeg');
    ff.kill('SIGKILL');
  });
});

// ── SUBTITLE — extrae subtítulo como WebVTT ───────────────────────────
app.get('/subtitle', async (req, res) => {
  const url = req.query.url;
  const idx = parseInt(req.query.index || '0', 10);
  if (!url) return res.status(400).json({ error: 'Falta url' });

  res.setHeader('Content-Type', 'text/vtt; charset=utf-8');

  const args = [
    '-loglevel', 'error',
    '-i', url,
    '-map', `0:s:${idx}`,
    '-c:s', 'webvtt',
    '-f', 'webvtt',
    'pipe:1'
  ];

  const ff = spawn('ffmpeg', args);
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => process.stderr.write(d));
  ff.on('error', () => res.status(500).end());
  ff.on('close', () => res.end());
  req.on('close', () => ff.kill('SIGKILL'));
});

// ── ffprobe helper ────────────────────────────────────────────────────
function ffprobe(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
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
  const lang = (s.tags?.language || s.tags?.LANGUAGE || '').toUpperCase();
  const title = s.tags?.title || s.tags?.TITLE || '';
  const codec = (s.codec_name || '').toUpperCase();
  const ch = s.channels === 6 ? '5.1' : s.channels === 2 ? 'Stereo' : (s.channels + 'ch');
  const parts = [];
  if (lang && lang !== 'UND') parts.push(lang);
  if (title) parts.push(title);
  parts.push(codec, ch);
  return parts.join(' · ') || `Pista ${i + 1}`;
}

function buildSubLabel(s, i) {
  const lang = (s.tags?.language || s.tags?.LANGUAGE || '').toUpperCase();
  const title = s.tags?.title || s.tags?.TITLE || '';
  const parts = [];
  if (lang && lang !== 'UND') parts.push(lang);
  if (title) parts.push(title);
  return parts.join(' · ') || `Sub ${i + 1}`;
}

// ── SELF-PING keep-alive (evita el sleep de Render free tier) ─────────
// El servidor se pinga a sí mismo cada 10 minutos para no dormirse
// Combinado con UptimeRobot cada 5 min = cobertura total
function selfPing() {
  if (!RENDER_URL) return; // Solo en producción (Render setea esta var)
  const url = `${RENDER_URL}/ping`;
  const mod = url.startsWith('https') ? https : http;
  mod.get(url, res => {
    console.log(`[keep-alive] Self-ping ${url} → ${res.statusCode}`);
  }).on('error', err => {
    console.warn('[keep-alive] Self-ping error:', err.message);
  });
}

// Primer ping a los 5 min, luego cada 10 min
setTimeout(() => {
  selfPing();
  setInterval(selfPing, 10 * 60 * 1000);
}, 5 * 60 * 1000);

// ── START ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`StreamBox Transcoder corriendo en puerto ${PORT}`);
  console.log(`RENDER_EXTERNAL_URL: ${RENDER_URL || '(local)'}`);
});
