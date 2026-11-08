// Silent stand-in for synthway-server, to work on the UI without the core and
// without any sound. Same routes and messages as synthway-server/src/main.py:
// keep them in sync when the server API changes.
//
// Usage: node scripts/mock-server.mjs [port]   (default 18742)
// then:  SYNTHWAY_SERVER_URL=http://127.0.0.1:18742 npm run dev
//
// The default port is the real server's (18741) + 1 on purpose: if the real
// server is running, the UI must never reach it by mistake and play sound.
//
// Every request and WebSocket message is logged, to check what the UI sends.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 18742);
const state = { running: false, enabled: true, frequency: 440, volume: 0.25, waveform: 0 };
// Kept across engine restarts, like the real server
let envelope = { attack: 0.005, decay: 0, sustain: 1, release: 0.01 };
let timbre = null; // null: the single oscillator plays
const MAX_PARTIALS = 64;

const devices = {
  playback_devices: [
    { index: 0, name: 'Mock Speakers', id: '0', is_default: true, sample_rate: 48000, channels: 2, type: 'playback' },
    { index: 1, name: 'Mock Headphones', id: '1', is_default: false, sample_rate: 48000, channels: 2, type: 'playback' },
  ],
  capture_devices: [
    { index: 0, name: 'Mock Microphone', id: '0', is_default: true, sample_rate: 48000, channels: 1, type: 'capture' },
  ],
};

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

function json(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readRaw(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function readBody(req) {
  const data = (await readRaw(req)).toString();
  return data ? JSON.parse(data) : {};
}

// ---------- Analyzer: fake analyses, no microphone opened, no file decoded ----------

let clip = null; // the "loaded file": its name and duration only
let take = null; // the microphone's last "recording": its duration only, nothing is captured
const NOTE_HZ = 196; // G3, the note of every fake file

/** A plucked string: harmonics in 1/n, the high ones dying first, plus one inharmonic partial.
    Like the core's noise gate, partials peaking below gate (dBFS) are dropped, and with none left, the note too. */
function fakeAnalysis(frequency, level, clarity, gate = -120) {
  let partials = [];
  if (frequency > 0) {
    for (let n = 1; n <= 10 && n * frequency < 20000; n += 1) {
      partials.push({ frequency: n * frequency * (1 + 0.0004 * n * n), amplitude: 1 / n });
    }
    partials.push({ frequency: 2.76 * frequency, amplitude: 0.18 });
    partials.sort((a, b) => a.frequency - b.frequency);
  }
  const spectrum_db = Array.from({ length: 256 }, (_, i) => {
    const hz = 20 * Math.pow(1000, i / 255);
    let power = Math.pow(10, (level - 70 + 6 * Math.random()) / 10);
    for (const p of partials) {
      const width = Math.max(4, p.frequency * 0.012);
      power += Math.pow(10, (level + 20 * Math.log10(p.amplitude)) / 10) * Math.exp(-(((hz - p.frequency) / width) ** 2));
    }
    return Math.round(Math.max(-120, 10 * Math.log10(power)) * 10) / 10;
  });
  if (gate > -120) {
    partials = partials.filter((p) => level + 20 * Math.log10(p.amplitude) >= gate);
    if (!partials.length) {
      frequency = 0;
      clarity = 0;
    }
  }
  return {
    sample_rate: 48000,
    frequency,
    clarity,
    level_db: level,
    partials: partials.map((p) => ({
      frequency: Math.round(p.frequency * 1000) / 1000,
      ratio: frequency > 0 ? Math.round((p.frequency / frequency) * 10000) / 10000 : 0,
      amplitude: p.amplitude,
    })),
    spectrum_min_hz: 20,
    spectrum_max_hz: 20000,
    spectrum_db,
  };
}

/** The fake file at time t: silence, a pluck at 0.2 s, its decay, and a little vibrato */
function clipMoment(t) {
  if (t < 0.2) return { frequency: 0, level: -110, clarity: 0 };
  const age = t - 0.2;
  const level = -8 - 14 * age;
  const clarity = level < -45 ? 0.3 : 0.97 - 0.05 * age;
  const frequency = level < -45 ? 0 : NOTE_HZ * Math.pow(2, (6 * Math.sin(2 * Math.PI * 5 * age) + 4) / 1200);
  return { frequency, level, clarity };
}

/** The fake microphone at time t (seconds since it opened): someone sings around A3, a little flat, with vibrato and breaths */
function singerMoment(t) {
  const breathing = t % 4 > 3.3;
  const frequency = breathing ? 0 : 220 * Math.pow(2, (-8 + 12 * Math.sin(2 * Math.PI * 0.4 * t)) / 1200);
  return { frequency, level: breathing ? -75 : -18, clarity: breathing ? 0.2 : 0.95 };
}

/** A file or a recording for display, its moments given by moment(t) */
function clipResponse(name, duration, moment = clipMoment) {
  const points = Math.min(1000, Math.ceil(duration / 0.02));
  const moments = Array.from({ length: points }, (_, i) => moment(((i + 0.5) / points) * duration));
  const overview = Array.from({ length: 1000 }, (_, i) => {
    const { level } = moment(((i + 0.5) / 1000) * duration);
    return Math.round(Math.min(1, Math.pow(10, level / 20) * 1.4 * (0.8 + 0.2 * Math.random())) * 1e4) / 1e4;
  });
  return {
    name,
    duration,
    sample_rate: 48000,
    frame_count: Math.round(duration * 48000),
    overview,
    overview_left: overview,
    overview_right: overview.map((peak) => Math.round(peak * 0.78 * 1e4) / 1e4),
    track: {
      frequency: moments.map((m) => Math.round(m.frequency * 1000) / 1000),
      clarity: moments.map((m) => Math.round(m.clarity * 1000) / 1000),
      level_db: moments.map((m) => Math.round(m.level * 10) / 10),
    },
  };
}

/** The fake sound at a frame: the note's first harmonics, at the level moment(t) says, and a faint hiss */
function fakeSample(moment, note, frame) {
  const t = frame / 48000;
  const amplitude = Math.min(1, Math.pow(10, moment(t).level / 20) * 1.4);
  let value = 0;
  for (let n = 1; n <= 4; n += 1) value += Math.sin(2 * Math.PI * n * note * t) / n;
  const hiss = ((Math.abs(Math.sin(frame * 12.9898) * 43758.5453) % 1) - 0.5) * 0.002;
  return (amplitude * value) / 1.7 + hiss;
}

/** Like the core: lowest and highest sample of each part, the right channel quieter; never more parts than frames */
function waveformResponse(res, url, duration, moment, note) {
  const total = Math.round(duration * 48000);
  const [first, frames, count] = ['first', 'frames', 'count'].map((key) => Number(url.searchParams.get(key)));
  if (!(Number.isInteger(first) && first >= 0 && frames >= 1 && count >= 1 && count <= 8192)) {
    return error(res, 422, 'Paramètres invalides');
  }
  if (first >= total) return error(res, 422, 'Au-delà de la fin du son');
  const covered = Math.min(frames, total - first);
  const parts = Math.min(count, covered);
  const round = (value) => Math.round(value * 1e5) / 1e5;
  const body = { first_frame: first, frame_count: covered, left_low: [], left_high: [], right_low: [], right_high: [] };
  for (let i = 0; i < parts; i += 1) {
    const start = first + Math.floor((covered * i) / parts);
    const end = Math.max(start + 1, first + Math.floor((covered * (i + 1)) / parts));
    let low = Infinity;
    let high = -Infinity;
    for (let frame = start; frame < end; frame += 1) {
      const value = fakeSample(moment, note, frame);
      low = Math.min(low, value);
      high = Math.max(high, value);
    }
    body.left_low.push(round(low));
    body.left_high.push(round(high));
    body.right_low.push(round(low * 0.78));
    body.right_high.push(round(high * 0.78));
  }
  return json(res, body);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
}

/** Like the core: the ratios taken to a reference note (the note heard moved to its octave when
    within 1.5 semitones of it, else the reference itself), then only the harmonics within cents,
    the strongest partial of each */
function relate(analysis, referenceHz, harmonicCents) {
  if (referenceHz > 0) {
    let folded = referenceHz;
    if (analysis.frequency > 0) {
      const octaves = Math.log2(referenceHz / analysis.frequency);
      if (Math.abs(octaves - Math.round(octaves)) * 12 <= 1.5) folded = analysis.frequency * 2 ** Math.round(octaves);
    }
    analysis.frequency = folded;
    for (const p of analysis.partials) p.ratio = Math.round((p.frequency / folded) * 10000) / 10000;
  }
  if (harmonicCents > 0 && analysis.frequency > 0) {
    const best = new Map();
    for (const p of analysis.partials) {
      const n = Math.round(p.ratio);
      if (n < 1 || Math.abs(1200 * Math.log2(p.ratio / n)) > harmonicCents) continue;
      if (!best.has(n) || p.amplitude > best.get(n).amplitude) best.set(n, p);
    }
    analysis.partials = [...best.values()].sort((a, b) => a.frequency - b.frequency);
    const strongest = Math.max(1e-9, ...analysis.partials.map((p) => p.amplitude));
    for (const p of analysis.partials) p.amplitude = Math.round((p.amplitude / strongest) * 10000) / 10000;
  }
  return analysis;
}

/** Like the server: a moment (time, through a window of window_ms), or a zone (start and end), whose
    moments' medians stand for the core's (at most 100 moments, 10 ms apart at least) */
function analysisResponse(res, url, moment) {
  const analysis = analyzeQuery(url, moment);
  return typeof analysis === 'string' ? error(res, 422, analysis) : json(res, analysis);
}

/** Like the server's /envelopes: the zone's partials, each with a plucked string's envelope
    (exponential, the higher partials dying sooner), their amplitudes being their peaks */
function envelopesResponse(res, url, moment) {
  if (!url.searchParams.has('start') || !url.searchParams.has('end')) return error(res, 422, 'Il faut start et end');
  const analysis = analyzeQuery(url, moment);
  if (typeof analysis === 'string') return error(res, 422, analysis);
  const envelopes = analysis.partials.map((p) => {
    const decay = Math.round((3 / Math.max(1, p.ratio)) * 1000) / 1000;
    return { attack: 0.008, decay, sustain: 0, release: Math.min(decay, 0.3), curve: 1 };
  });
  return json(res, { analysis, envelopes });
}

/** The analysis asked by the query, or what is wrong with it */
function analyzeQuery(url, moment) {
  const param = (key) => (url.searchParams.has(key) ? Number(url.searchParams.get(key)) : null);
  const [time, start, end] = ['time', 'start', 'end'].map(param);
  const windowMs = param('window_ms') ?? 0;
  const gate = param('noise_gate_db') ?? -120;
  const referenceHz = param('reference_hz') ?? 0;
  const harmonicCents = param('harmonic_cents') ?? 0;
  if (windowMs !== 0 && !(windowMs >= 10 && windowMs <= 500)) return 'Fenêtre de 10 à 500 ms, ou 0 pour l’habituelle';
  if (referenceHz !== 0 && !(referenceHz >= 16 && referenceHz <= 5000)) return 'Note de référence de 16 à 5000 Hz, ou 0';
  if (!(harmonicCents >= 0 && harmonicCents <= 100)) return 'Tolérance des harmoniques de 0 à 100 cents';
  if (start !== null || end !== null) {
    if (start === null || end === null || !(end > start)) return 'Une zone demande start et end, end après start';
    const count = Math.max(2, Math.min(100, Math.floor((end - start) / 0.01) + 1));
    const moments = Array.from({ length: count }, (_, i) => moment(start + ((end - start) * i) / (count - 1)));
    const notes = moments.filter((m) => m.frequency > 0);
    const frequency = notes.length * 2 >= count ? median(notes.map((m) => m.frequency)) : 0;
    const analysis = fakeAnalysis(frequency, median(moments.map((m) => m.level)), median(moments.map((m) => m.clarity)), gate);
    return relate(analysis, referenceHz, harmonicCents);
  }
  if (time === null) return 'Il faut time, ou start et end';
  const m = moment(time);
  return relate(fakeAnalysis(m.frequency, m.level, m.clarity, gate), referenceHz, harmonicCents);
}

function analyzerRoute(req, res, url, raw) {
  if (req.method === 'POST' && url.pathname === '/api/analyzer/clip') {
    // Like the core: refuses what is not WAV, FLAC or MP3
    const magic = raw.subarray(0, 4).toString('latin1');
    if (!raw.length) return error(res, 400, 'Fichier vide');
    if (!['RIFF', 'fLaC'].includes(magic) && !magic.startsWith('ID3') && raw[0] !== 0xff) {
      clip = null;
      return error(res, 415, 'Format audio non reconnu (WAV, FLAC ou MP3)');
    }
    clip = { name: url.searchParams.get('name') ?? 'son', duration: 3 };
    log(`   clip: ${clip.name}, ${raw.length} bytes (not decoded: a fake G3 pluck stands for it)`);
    return json(res, clipResponse(clip.name, clip.duration));
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/clip') {
    return json(res, clip ? clipResponse(clip.name, clip.duration) : null);
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/clip.wav') {
    if (!clip) return error(res, 404, 'Aucun fichier chargé');
    return sendWav(req, res, silentWav(clip.duration), 'inline');
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/clip/analysis') {
    if (!clip) return error(res, 404, 'Aucun fichier chargé');
    return analysisResponse(res, url, clipMoment);
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/clip/envelopes') {
    if (!clip) return error(res, 404, 'Aucun fichier chargé');
    return envelopesResponse(res, url, clipMoment);
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/clip/waveform') {
    if (!clip) return error(res, 404, 'Aucun fichier chargé');
    return waveformResponse(res, url, clip.duration, clipMoment, NOTE_HZ);
  }
  // The microphone's last recording: the fake singer, for as long as it lasted
  if (req.method === 'GET' && url.pathname === '/api/analyzer/recording') {
    return json(res, take ? clipResponse('Enregistrement', take.duration, singerMoment) : null);
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/recording/analysis') {
    if (!take) return error(res, 404, 'Aucun enregistrement');
    return analysisResponse(res, url, singerMoment);
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/recording/envelopes') {
    if (!take) return error(res, 404, 'Aucun enregistrement');
    return envelopesResponse(res, url, singerMoment);
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/recording/waveform') {
    if (!take) return error(res, 404, 'Aucun enregistrement');
    return waveformResponse(res, url, take.duration, singerMoment, 220);
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/recording.wav') {
    if (!take) return error(res, 404, 'Aucun enregistrement');
    return sendWav(req, res, silentWav(take.duration), 'attachment; filename="synthway-mock.wav"');
  }
  return false;
}

// ---------- AI-nalyzer: a fake Demucs, no model loaded, silent stems ----------

const SEPARATION_MODELS = ['htdemucs', 'htdemucs_ft', 'htdemucs_6s'];
const SEPARATION_SECONDS = 30; // every fake piece lasts 30 s
let separationSource = null; // { name, size }
let separationJob = { state: 'idle', stage: null, progress: 0, model: null, device: null, error: null };
let separationResult = null;
let separationTimer = null;

/** Peaks that look like each stem: hits for the drums, phrases for the others */
function fakeStemPeaks(name) {
  return Array.from({ length: 1000 }, (_, i) => {
    const t = (i / 1000) * SEPARATION_SECONDS;
    const beat = t % 0.5;
    switch (name) {
      case 'drums':
        return Math.round((0.15 + 0.75 * Math.exp(-beat * 18)) * 1000) / 1000;
      case 'bass':
        return Math.round((0.35 + 0.15 * Math.sin(t * 1.3)) * 1000) / 1000;
      case 'vocals':
        return t % 8 < 5 ? Math.round((0.3 + 0.2 * Math.abs(Math.sin(t * 2.1))) * 1000) / 1000 : 0.01;
      default:
        return Math.round((0.2 + 0.12 * Math.abs(Math.sin(t * 0.7 + name.length))) * 1000) / 1000;
    }
  });
}

function separationStatus() {
  return {
    available: true,
    reason: null,
    models: SEPARATION_MODELS,
    source: separationSource,
    job: separationJob,
    result: separationResult,
  };
}

/** Loading, reading, separating over about 4 s, saving: like Demucs, without Demucs */
function fakeSeparation(model) {
  const stems = model === 'htdemucs_6s'
    ? ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano']
    : ['drums', 'bass', 'other', 'vocals'];
  let step = 0;
  separationJob = { state: 'running', stage: 'starting', progress: 0, model, device: null, error: null };
  separationTimer = setInterval(() => {
    step += 1;
    if (step === 2) Object.assign(separationJob, { stage: 'loading', device: 'cuda' });
    else if (step === 5) separationJob.stage = 'reading';
    else if (step > 6 && step <= 26) Object.assign(separationJob, { stage: 'separating', progress: (step - 7) / 20 });
    else if (step === 27) separationJob.stage = 'saving';
    else if (step === 29) {
      clearInterval(separationTimer);
      separationTimer = null;
      separationJob = { ...separationJob, state: 'done', stage: null, progress: 1 };
      separationResult = {
        model,
        device: 'cuda',
        sample_rate: 44100,
        duration: SEPARATION_SECONDS,
        seconds: 5.8,
        stems: stems.map((name) => ({ name, peaks: fakeStemPeaks(name) })),
      };
      log(`   separation done: ${stems.join(', ')} (silent)`);
    }
  }, 200);
}

function separationRoute(req, res, url, raw) {
  const route = `${req.method} ${url.pathname}`;
  if (route === 'GET /api/separation') return json(res, separationStatus());
  if (route === 'POST /api/separation/source') {
    if (!raw.length) return error(res, 400, 'Fichier vide');
    if (separationJob.state === 'running') return error(res, 409, 'Une décomposition est en cours');
    separationSource = { name: url.searchParams.get('name') ?? 'morceau', size: raw.length };
    separationResult = null;
    separationJob = { state: 'idle', stage: null, progress: 0, model: null, device: null, error: null };
    log(`   piece: ${separationSource.name}, ${raw.length} bytes (not decoded)`);
    return json(res, separationStatus());
  }
  if (route === 'GET /api/separation/source') {
    if (!separationSource) return error(res, 404, 'Aucun morceau chargé');
    return sendWav(req, res, silentWav(SEPARATION_SECONDS), 'inline');
  }
  if (route === 'POST /api/separation/run') {
    const model = (raw.length ? JSON.parse(raw.toString()) : {}).model ?? 'htdemucs';
    if (!SEPARATION_MODELS.includes(model)) return error(res, 422, `Modèle inconnu : ${model}`);
    if (!separationSource) return error(res, 400, 'Aucun morceau à décomposer');
    if (separationJob.state === 'running') return error(res, 409, 'Une décomposition est déjà en cours');
    separationResult = null;
    fakeSeparation(model);
    return json(res, separationStatus());
  }
  if (route === 'POST /api/separation/cancel') {
    if (separationTimer) {
      clearInterval(separationTimer);
      separationTimer = null;
      separationJob = { state: 'idle', stage: null, progress: 0, model: separationJob.model, device: null, error: 'Décomposition annulée' };
    }
    return json(res, separationStatus());
  }
  const stem = /^\/api\/separation\/stems\/([^/]+?)(\.wav|\/analyzer)$/.exec(url.pathname);
  if (stem) {
    const name = decodeURIComponent(stem[1]);
    if (!separationResult?.stems.some((item) => item.name === name)) return error(res, 404, `Aucune piste « ${name} »`);
    if (req.method === 'GET' && stem[2] === '.wav') {
      const disposition = url.searchParams.get('download') === 'true'
        ? `attachment; filename="${name}.wav"`
        : 'inline';
      return sendWav(req, res, silentWav(SEPARATION_SECONDS), disposition);
    }
    if (req.method === 'POST' && stem[2] === '/analyzer') {
      // Becomes the Analyzer's file: the fake G3 pluck stands for it, as for any file
      clip = { name: `${separationSource.name.replace(/\.[^.]+$/, '')} · ${name}`, duration: 3 };
      log(`   stem ${name} sent to the Analyzer`);
      return json(res, clipResponse(clip.name, clip.duration));
    }
  }
  return false;
}

/** A WAV file, whole or the byte range asked, like the real server: the browser seeks in it with Range requests */
function sendWav(req, res, wav, disposition) {
  const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': 'audio/wav', 'Content-Disposition': disposition };
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (!match || (!match[1] && !match[2])) {
    res.writeHead(200, { ...headers, 'Content-Length': wav.length });
    return res.end(wav);
  }
  const [, startText, endText] = match;
  const start = startText ? Number(startText) : Math.max(0, wav.length - Number(endText));
  const end = endText && startText ? Math.min(Number(endText), wav.length - 1) : wav.length - 1;
  if (start >= wav.length || end < start) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${wav.length}` });
    return res.end();
  }
  const body = wav.subarray(start, end + 1);
  res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${wav.length}`, 'Content-Length': body.length });
  return res.end(body);
}

/** A mono 16-bit WAV file of silence: the mock captures nothing */
function silentWav(seconds) {
  const frames = Math.round(seconds * 48000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + frames * 2, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * 2, 28); // bytes per second
  header.writeUInt16LE(2, 32); // bytes per frame
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(frames * 2, 40);
  return Buffer.concat([header, Buffer.alloc(frames * 2)]);
}

function error(res, status, detail) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ detail }));
}

// Like the real server: the UI calls it directly, and only pages served by
// this machine may (CORS)
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && LOCAL_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': '*', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/analyzer/')) {
    const raw = req.method === 'POST' ? await readRaw(req) : Buffer.alloc(0);
    if (!url.pathname.endsWith('/analysis')) log('HTTP', req.method, req.url);
    if (analyzerRoute(req, res, url, raw) !== false) return;
    res.writeHead(404);
    return res.end();
  }
  if (url.pathname === '/api/separation' || url.pathname.startsWith('/api/separation/')) {
    const raw = req.method === 'POST' ? await readRaw(req) : Buffer.alloc(0);
    if (url.pathname !== '/api/separation') log('HTTP', req.method, req.url);
    if (separationRoute(req, res, url, raw) !== false) return;
    res.writeHead(404);
    return res.end();
  }

  const body = req.method === 'POST' ? await readBody(req) : undefined;
  if (req.url !== '/health') log('HTTP', req.method, req.url, body ? JSON.stringify(body) : '');

  switch (`${req.method} ${req.url}`) {
    case 'GET /health':
      return json(res, { status: 'ok', core_loaded: true, core_version: '0.1.0-mock' });
    case 'GET /api/devices':
      return json(res, devices);
    case 'GET /api/engine/status':
      return json(res, {
        is_running: state.running,
        is_tone_enabled: state.enabled,
        frequency: state.frequency,
        volume: state.volume,
        waveform: state.waveform,
        envelope,
        timbre,
        max_partials: MAX_PARTIALS,
        sample_rate: state.running ? 48000 : null,
        core_version: '0.1.0-mock',
      });
    case 'POST /api/synth/envelope':
      envelope = { ...envelope, ...body };
      return json(res, envelope);
    case 'POST /api/synth/timbre':
      if ((body.partials ?? []).length > MAX_PARTIALS) {
        res.writeHead(422);
        return res.end();
      }
      timbre = body;
      log(`   timbre: ${describeTimbre(timbre)}`);
      return json(res, timbre);
    case 'DELETE /api/synth/timbre':
      timbre = null;
      return json(res, { timbre: null });
    case 'POST /api/engine/start':
      // Like the real server: a fresh engine starts muted
      Object.assign(state, { running: true, enabled: false, frequency: 440, volume: 0.25 });
      return json(res, { running: true });
    case 'POST /api/engine/stop':
      state.running = false;
      return json(res, { running: false });
    case 'POST /api/synth/tone':
      Object.assign(state, body);
      return json(res, state);
    default:
      res.writeHead(404);
      return res.end();
  }
});

function describeTimbre(value) {
  if (!value) return 'single oscillator';
  return `${value.partials.length} partials [${value.partials
    .map((p) => `x${p.ratio}:${p.amplitude}${p.envelope?.curve === 1 ? `:exp${p.envelope.decay}s` : ''}`)
    .join(' ')}]`;
}

// Minimal WebSocket server: unfragmented text frames are enough (under 64 KB)
function sendText(socket, text) {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  socket.write(Buffer.concat([header, payload]));
}

function handleMessage(message) {
  if (message.type === 'note_on') {
    state.running = true; // the real server starts the engine first if needed
    Object.assign(state, { frequency: message.frequency, volume: message.volume, enabled: true });
  } else if (message.type === 'note_off') {
    state.enabled = false;
  } else if (message.type === 'set_param') {
    for (const key of ['frequency', 'volume', 'waveform', 'enabled']) {
      if (key in message) state[key] = message[key];
    }
    if (message.envelope) envelope = { ...envelope, ...message.envelope };
    if ('timbre' in message) timbre = message.timbre;
  }
}

/** Calls onMessage with every JSON message of the socket. Frames of several
    kilobytes (a timbre) can arrive in pieces: they are buffered. */
function readMessages(socket, onMessage) {
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const opcode = pending[0] & 0x0f;
      if (opcode === 0x8) {
        socket.end();
        return;
      }
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      }
      if (pending.length < offset + 4 + length) return;
      const mask = pending.subarray(offset, offset + 4);
      const data = Buffer.from(pending.subarray(offset + 4, offset + 4 + length).map((byte, i) => byte ^ mask[i % 4]));
      pending = pending.subarray(offset + 4 + length);
      onMessage(JSON.parse(data.toString()));
    }
  });
}

function onSynthSocket(socket) {
  readMessages(socket, (message) => {
    const { timbre: sent, ...rest } = message;
    log('WS <-', JSON.stringify(rest), 'timbre' in message ? `timbre: ${describeTimbre(sent)}` : '');
    handleMessage(message);
    sendText(socket, JSON.stringify(state));
  });
}

/** Like /ws/analyzer of the real server, with a fake microphone (singerMoment)
    and a fake recording: only its duration is kept */
function onAnalyzerSocket(socket) {
  let timer;
  let gate = -120;
  let recordStarted = null; // Date.now() when recording
  const recordingTimes = () => ({ duration: Math.round(Date.now() - recordStarted) / 1000, lost: 0 });
  // Like the core: the recording ends when asked, or when the microphone closes
  const finishRecording = () => {
    if (recordStarted === null) return null;
    const times = recordingTimes();
    take = { duration: times.duration };
    recordStarted = null;
    log(`   recording: ${times.duration} s (nothing captured)`);
    return times;
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
    const recorded = finishRecording();
    if (recorded && !socket.destroyed) sendText(socket, JSON.stringify({ type: 'recorded', ...recorded }));
  };
  readMessages(socket, (message) => {
    log('WS analyzer <-', JSON.stringify(message));
    if (message.type === 'set') {
      if ('noise_gate_db' in message) gate = message.noise_gate_db;
    } else if (message.type === 'start') {
      stop();
      gate = message.noise_gate_db ?? -120;
      const started = Date.now();
      // The system's input takes the exclusive mode, "Mock Microphone" (index 0) refuses it, to show both
      const deviceIndex = message.device_index ?? -1;
      sendText(socket, JSON.stringify({ type: 'started', device_index: deviceIndex, sample_rate: 48000, exclusive: deviceIndex !== 0 }));
      timer = setInterval(() => {
        const m = singerMoment((Date.now() - started) / 1000);
        const analysis = { type: 'analysis', analysis: fakeAnalysis(m.frequency, m.level, m.clarity, gate) };
        if (recordStarted !== null) analysis.recording = recordingTimes();
        sendText(socket, JSON.stringify(analysis));
      }, 50);
    } else if (message.type === 'record') {
      if (!timer) {
        sendText(socket, JSON.stringify({ type: 'error', error: 'Le micro n’est pas ouvert : rien à enregistrer' }));
        return;
      }
      recordStarted = Date.now();
      sendText(socket, JSON.stringify({ type: 'recording' }));
    } else if (message.type === 'stop_record') {
      const recorded = finishRecording();
      sendText(socket, JSON.stringify(recorded ? { type: 'recorded', ...recorded } : { type: 'error', error: 'Aucun enregistrement en cours' }));
    } else if (message.type === 'stop') {
      stop();
      sendText(socket, JSON.stringify({ type: 'stopped' }));
    } else {
      sendText(socket, JSON.stringify({ type: 'error', error: `Unknown message type: ${message.type}` }));
    }
  });
  socket.on('close', stop);
}

server.on('upgrade', (req, socket) => {
  const handlers = { '/ws/synth': onSynthSocket, '/ws/analyzer': onAnalyzerSocket };
  const handler = handlers[req.url];
  if (!handler) {
    socket.destroy();
    return;
  }
  // Like the real server: CORS does not cover WebSockets, so other websites are refused here
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin)) {
    log('WS refused', req.url, 'from origin', origin);
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  const accept = createHash('sha1')
    .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  log('WS open', req.url);
  handler(socket);
  socket.on('close', () => log('WS close', req.url));
  socket.on('error', () => undefined);
});

server.listen(port, '127.0.0.1', () => log(`Silent mock synthway-server on http://127.0.0.1:${port}`));
