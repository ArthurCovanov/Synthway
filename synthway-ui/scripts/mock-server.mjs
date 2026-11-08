// Silent stand-in for synthway-server, to work on the UI without the core and
// without any sound. Same routes and messages as synthway-server/src/main.py:
// keep them in sync when the server API changes.
//
// Usage: node scripts/mock-server.mjs [port]   (default 18742)
// then:  SYNTHWAY_SERVER_URL=http://localhost:18742 npm run dev
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

function clipResponse() {
  const points = Math.min(1000, Math.ceil(clip.duration / 0.02));
  const moments = Array.from({ length: points }, (_, i) => clipMoment(((i + 0.5) / points) * clip.duration));
  return {
    name: clip.name,
    duration: clip.duration,
    sample_rate: 48000,
    frame_count: Math.round(clip.duration * 48000),
    overview: Array.from({ length: 1000 }, (_, i) => {
      const { level } = clipMoment(((i + 0.5) / 1000) * clip.duration);
      return Math.round(Math.min(1, Math.pow(10, level / 20) * 1.4 * (0.8 + 0.2 * Math.random())) * 1e4) / 1e4;
    }),
    track: {
      frequency: moments.map((m) => Math.round(m.frequency * 1000) / 1000),
      clarity: moments.map((m) => Math.round(m.clarity * 1000) / 1000),
      level_db: moments.map((m) => Math.round(m.level * 10) / 10),
    },
  };
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
    return json(res, clipResponse());
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/clip') {
    return json(res, clip ? clipResponse() : null);
  }
  if (req.method === 'GET' && url.pathname === '/api/analyzer/clip/analysis') {
    if (!clip) return error(res, 404, 'Aucun fichier chargé');
    const m = clipMoment(Number(url.searchParams.get('time') ?? 0));
    return json(res, fakeAnalysis(m.frequency, m.level, m.clarity, Number(url.searchParams.get('noise_gate_db') ?? -120)));
  }
  return false;
}

function error(res, status, detail) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ detail }));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/analyzer/')) {
    const raw = req.method === 'POST' ? await readRaw(req) : Buffer.alloc(0);
    if (url.pathname !== '/api/analyzer/clip/analysis') log('HTTP', req.method, req.url);
    if (analyzerRoute(req, res, url, raw) !== false) return;
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
  return `${value.partials.length} partials [${value.partials.map((p) => `x${p.ratio}:${p.amplitude}`).join(' ')}]`;
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

/** Like /ws/analyzer of the real server, with a fake microphone: someone sings
    around A3, a little flat, with vibrato and breaths */
function onAnalyzerSocket(socket) {
  let timer;
  let gate = -120;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
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
        const t = (Date.now() - started) / 1000;
        const breathing = t % 4 > 3.3;
        const frequency = breathing ? 0 : 220 * Math.pow(2, (-8 + 12 * Math.sin(2 * Math.PI * 0.4 * t)) / 1200);
        sendText(socket, JSON.stringify({ type: 'analysis', analysis: fakeAnalysis(frequency, breathing ? -75 : -18, breathing ? 0.2 : 0.95, gate) }));
      }, 50);
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

server.listen(port, '127.0.0.1', () => log(`Silent mock synthway-server on http://localhost:${port}`));
