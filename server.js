'use strict';

/* =====================================================================
   Gorilla Tag ISO – Servidor
   Salas, estados dos jogadores, cosméticos, rondas e os dois modos:
     - normal  : PvE, 1 Bot Assassino controlado pelo servidor
     - assassin: PvP, 1 jogador aleatório é o Assassino
   ===================================================================== */

const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

/* ---------- Configuração ---------- */
const PORT = process.env.PORT || 3000;
const TICK_MS = 50;              // 20 atualizações por segundo
const WORLD = 2400;              // lado do mapa (unidades)
const MAX_PLAYERS = 8;
const MAX_ROOMS = 60;

const COUNTDOWN_TIME = 5;        // segundos antes da ronda
const ROUND_TIME = 120;          // duração da ronda
const RESULTS_TIME = 7;          // ecrã de resultados
const GRACE_MS = 3000;           // tempo de avanço dos fugitivos

const TAG_RANGE = 80;            // alcance do toque (assassino)
const TAG_DZ = 70;               // diferença máxima de altura
const TAG_COOLDOWN_MS = 350;

const BOT_RADIUS = 24;
const BOT_SPEED = 215;
const BOT_LUNGE_SPEED = 400;
const BOT_CATCH_RANGE = 44;
const BOT_STUN_RANGE = 85;
const BOT_STUN_MS = 2500;
const BOT_IMMUNE_MS = 2500;

const VALID_COLORS = ['brown', 'black', 'blue', 'gold', 'green', 'purple', 'pink', 'white'];
const VALID_HATS = ['none', 'tophat', 'cap', 'crown', 'glasses'];
const MODES = ['normal', 'assassin'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------- Express + Socket.io ---------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const CLIENT_FILES = ['index.html', 'style.css', 'game.js', 'network.js', 'ui.js'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
CLIENT_FILES.forEach((file) => {
  app.get('/' + file, (req, res) => res.sendFile(path.join(__dirname, file)));
});

/* ---------- Utilitários ---------- */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function r1(n) {
  return Math.round(n * 10) / 10;
}

function num(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeText(v, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}

function sanitizeProfile(d) {
  d = d || {};
  const name = sanitizeText(d.name, 14) || 'Gorila' + (100 + Math.floor(Math.random() * 900));
  const color = VALID_COLORS.includes(d.color) ? d.color : 'brown';
  const hat = VALID_HATS.includes(d.hat) ? d.hat : 'none';
  return { name, color, hat };
}

function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

/* ---------- Mapa ---------- */
function generateMap(seed) {
  const rnd = mulberry32(seed);
  const obstacles = [];
  const centre = WORLD / 2;
  const margin = 110;
  let nextId = 1;

  function footprint(o) {
    return o.t === 'log' ? Math.hypot(o.hw, o.hd) : o.r;
  }

  function fits(x, y, rad) {
    if (Math.hypot(x - centre, y - centre) < 190 + rad) return false;
    for (const o of obstacles) {
      if (Math.hypot(x - o.x, y - o.y) < footprint(o) + rad + 70) return false;
    }
    return true;
  }

  const specs = [
    { t: 'tree', count: 30 },
    { t: 'rock', count: 20 },
    { t: 'log', count: 12 }
  ];

  for (const spec of specs) {
    let placed = 0;
    let attempts = 0;
    while (placed < spec.count && attempts < 600) {
      attempts++;
      const x = margin + rnd() * (WORLD - 2 * margin);
      const y = margin + rnd() * (WORLD - 2 * margin);
      let o;
      if (spec.t === 'tree') {
        o = { t: 'tree', r: 26, h: 999 };
      } else if (spec.t === 'rock') {
        o = { t: 'rock', r: Math.round(20 + rnd() * 8), h: 28 };
      } else {
        const long = Math.round(70 + rnd() * 40);
        const short = Math.round(20 + rnd() * 6);
        const alongX = rnd() < 0.5;
        o = { t: 'log', hw: alongX ? long : short, hd: alongX ? short : long, h: 52 };
      }
      o.x = Math.round(x);
      o.y = Math.round(y);
      o.id = nextId++;
      if (fits(o.x, o.y, footprint(o))) {
        obstacles.push(o);
        placed++;
      }
    }
  }
  return obstacles;
}

function blockedAt(obstacles, x, y, r) {
  if (x < r || y < r || x > WORLD - r || y > WORLD - r) return true;
  for (const o of obstacles) {
    if (o.t === 'log') {
      const cx = Math.max(o.x - o.hw, Math.min(x, o.x + o.hw));
      const cy = Math.max(o.y - o.hd, Math.min(y, o.y + o.hd));
      if (Math.hypot(x - cx, y - cy) < r) return true;
    } else if (Math.hypot(x - o.x, y - o.y) < o.r + r) {
      return true;
    }
  }
  return false;
}

function findSpawn(room, minR, maxR) {
  const c = WORLD / 2;
  for (let i = 0; i < 80; i++) {
    const ang = Math.random() * Math.PI * 2;
    const rad = minR + Math.random() * (maxR - minR);
    const x = c + Math.cos(ang) * rad;
    const y = c + Math.sin(ang) * rad;
    if (!blockedAt(room.map, x, y, 40)) return { x, y };
  }
  return { x: c + 100, y: c }; // zona central está sempre livre
}

/* ---------- Salas ---------- */
const rooms = new Map();

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function makeRoom(code, name, mode, isPrivate) {
  const seed = Math.floor(Math.random() * 1e9);
  return {
    code,
    name,
    mode,
    isPrivate,
    seed,
    map: generateMap(seed),
    players: new Map(),
    bot: null,
    assassinId: null,
    phase: 'waiting',   // waiting | countdown | playing | results
    timer: 0,
    round: 0,
    msg: '',
    graceUntil: 0,
    lastTick: Date.now()
  };
}

function publicInfo(room) {
  return {
    code: room.code,
    name: room.name,
    mode: room.mode,
    players: room.players.size,
    max: MAX_PLAYERS,
    phase: room.phase
  };
}

function feed(room, text, kind) {
  io.to(room.code).emit('feed', { text, kind: kind || 'info' });
}

function teleport(room, p, pos) {
  p.x = pos.x;
  p.y = pos.y;
  p.z = 0;
  p.vx = 0;
  p.vy = 0;
  p.seq += 1;
  io.to(p.id).emit('teleport', { x: p.x, y: p.y, seq: p.seq });
}

function joinInto(socket, room, profile, ack) {
  if (room.players.size >= MAX_PLAYERS) {
    reply(ack, { ok: false, error: 'A sala está cheia (máximo ' + MAX_PLAYERS + ' jogadores).' });
    return;
  }
  socket.join(room.code);
  socket.data.roomCode = room.code;

  const late = room.phase === 'playing';
  const spawn = findSpawn(room, 350, 1000);
  const p = {
    id: socket.id,
    name: profile.name,
    color: profile.color,
    hat: profile.hat,
    x: spawn.x,
    y: spawn.y,
    z: 0,
    vx: 0,
    vy: 0,
    role: 'runner',
    alive: !late,
    inRound: false,
    score: 0,
    seq: 1,
    lastTag: 0
  };
  room.players.set(socket.id, p);

  reply(ack, {
    ok: true,
    id: socket.id,
    room: { code: room.code, name: room.name, mode: room.mode, isPrivate: room.isPrivate },
    map: { size: WORLD, seed: room.seed, obstacles: room.map },
    you: { x: p.x, y: p.y, seq: p.seq, alive: p.alive }
  });
  feed(room, p.name + ' entrou na sala', 'info');
}

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;
  socket.data.roomCode = null;
  socket.leave(code);
  const room = rooms.get(code);
  if (!room) return;
  const p = room.players.get(socket.id);
  room.players.delete(socket.id);
  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }
  if (p) feed(room, p.name + ' saiu da sala', 'info');
}

/* ---------- Rondas ---------- */
function startRound(room, now) {
  room.round += 1;
  room.phase = 'playing';
  room.timer = ROUND_TIME;
  room.msg = '';
  room.graceUntil = now + GRACE_MS;
  room.bot = null;
  room.assassinId = null;

  const list = Array.from(room.players.values());
  for (const p of list) {
    p.inRound = true;
    p.alive = true;
    p.role = 'runner';
    teleport(room, p, findSpawn(room, 350, 1000));
  }

  if (room.mode === 'assassin') {
    const a = list[Math.floor(Math.random() * list.length)];
    a.role = 'assassin';
    room.assassinId = a.id;
    teleport(room, a, { x: WORLD / 2 + (Math.random() * 80 - 40), y: WORLD / 2 + (Math.random() * 80 - 40) });
    feed(room, a.name + ' é o ASSASSINO! Fujam!', 'danger');
  } else {
    room.bot = {
      x: WORLD / 2,
      y: WORLD / 2,
      face: 1,
      side: 1,
      stunUntil: 0,
      immuneUntil: 0,
      lungeUntil: 0,
      nextLunge: now + GRACE_MS + 3000,
      detourUntil: 0,
      cx: WORLD / 2,
      cy: WORLD / 2,
      checkAt: now + GRACE_MS + 1200
    };
    feed(room, 'O Bot Assassino foi libertado! Fujam!', 'danger');
  }
}

function endRound(room, text) {
  room.phase = 'results';
  room.timer = RESULTS_TIME;
  room.msg = text;
  feed(room, text, 'win');
}

function resetToWaiting(room) {
  room.phase = 'waiting';
  room.timer = 0;
  room.bot = null;
  room.assassinId = null;
  room.msg = '';
  for (const p of room.players.values()) {
    p.alive = true;
    p.role = 'runner';
    p.inRound = false;
  }
}

function checkRoundEnd(room) {
  const all = Array.from(room.players.values()).filter((p) => p.inRound);

  if (room.mode === 'assassin') {
    const a = room.players.get(room.assassinId);
    if (!a) {
      endRound(room, 'O assassino saiu da sala. Ronda cancelada.');
      return;
    }
    const runners = all.filter((p) => p.role === 'runner');
    if (runners.length === 0) {
      endRound(room, 'Os fugitivos saíram. Ronda terminada.');
      return;
    }
    const alive = runners.filter((p) => p.alive);
    if (alive.length === 0) {
      a.score += 2;
      endRound(room, a.name + ' apanhou todos! O Assassino venceu!');
      return;
    }
    if (room.timer <= 0) {
      alive.forEach((p) => { p.score += 1; });
      endRound(room, 'O tempo acabou! ' + alive.length + ' sobrevivente(s) venceram.');
    }
  } else {
    if (all.length === 0) {
      endRound(room, 'Todos saíram. Ronda terminada.');
      return;
    }
    const alive = all.filter((p) => p.alive);
    if (alive.length === 0) {
      endRound(room, 'O Bot Assassino apanhou todos!');
      return;
    }
    if (room.timer <= 0) {
      alive.forEach((p) => { p.score += 1; });
      endRound(room, 'O tempo acabou! ' + alive.length + ' jogador(es) escaparam ao Bot.');
    }
  }
}

/* ---------- Bot Assassino (IA básica) ---------- */
function updateBot(room, dt, now) {
  const b = room.bot;
  if (!b) return;

  if (now < room.graceUntil || now < b.stunUntil) {
    b.cx = b.x;
    b.cy = b.y;
    b.checkAt = now + 1200;
    return;
  }

  // alvo: jogador vivo mais próximo
  let target = null;
  let best = Infinity;
  for (const p of room.players.values()) {
    if (!p.alive || !p.inRound) continue;
    const d = Math.hypot(p.x - b.x, p.y - b.y);
    if (d < best) {
      best = d;
      target = p;
    }
  }
  if (!target) return;

  // investida ocasional
  let speed = BOT_SPEED;
  if (now < b.lungeUntil) {
    speed = BOT_LUNGE_SPEED;
  } else if (now >= b.nextLunge && best < 420) {
    b.lungeUntil = now + 600;
    b.nextLunge = now + 6000 + Math.random() * 3000;
  }

  // deteção de bloqueio: se andou pouco, tenta contornar para o outro lado
  if (now >= b.checkAt) {
    const moved = Math.hypot(b.x - b.cx, b.y - b.cy);
    if (moved < BOT_SPEED * 1.2 * 0.35) {
      b.side = -b.side;
      b.detourUntil = now + 800;
    }
    b.cx = b.x;
    b.cy = b.y;
    b.checkAt = now + 1200;
  }

  let ang = Math.atan2(target.y - b.y, target.x - b.x);
  if (now < b.detourUntil) ang += 1.3 * b.side;

  const step = speed * dt;
  const offsets = [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, 2.4, -2.4];
  let moved = false;
  for (const off of offsets) {
    const a = ang + off * b.side;
    const nx = b.x + Math.cos(a) * step;
    const ny = b.y + Math.sin(a) * step;
    if (!blockedAt(room.map, nx, ny, BOT_RADIUS)) {
      b.x = nx;
      b.y = ny;
      b.face = Math.cos(a) - Math.sin(a) >= 0 ? 1 : -1;
      moved = true;
      break;
    }
  }
  if (!moved) b.side = -b.side;

  // apanhar jogadores
  for (const p of room.players.values()) {
    if (!p.alive || !p.inRound) continue;
    if (Math.hypot(p.x - b.x, p.y - b.y) < BOT_CATCH_RANGE && Math.abs(p.z) < 70) {
      p.alive = false;
      feed(room, p.name + ' foi apanhado pelo Bot Assassino!', 'danger');
    }
  }
}

/* ---------- Loop do servidor ---------- */
function broadcast(room, now) {
  const players = [];
  for (const p of room.players.values()) {
    players.push({
      id: p.id,
      name: p.name,
      x: r1(p.x),
      y: r1(p.y),
      z: r1(p.z),
      vx: Math.round(p.vx),
      vy: Math.round(p.vy),
      color: p.color,
      hat: p.hat,
      role: p.role,
      alive: p.alive,
      inRound: p.inRound,
      score: p.score
    });
  }
  io.to(room.code).emit('state', {
    code: room.code,
    phase: room.phase,
    mode: room.mode,
    round: room.round,
    timer: Math.max(0, Math.round(room.timer * 10) / 10),
    msg: room.msg,
    players,
    bot: room.bot
      ? { x: r1(room.bot.x), y: r1(room.bot.y), face: room.bot.face, stunned: now < room.bot.stunUntil }
      : null
  });
}

function updateRoom(room, now) {
  const dt = Math.min(0.2, (now - room.lastTick) / 1000);
  room.lastTick = now;
  const n = room.players.size;
  const need = room.mode === 'assassin' ? 2 : 1;

  switch (room.phase) {
    case 'waiting':
      if (n >= need) {
        room.phase = 'countdown';
        room.timer = COUNTDOWN_TIME;
      }
      break;
    case 'countdown':
      if (n < need) {
        room.phase = 'waiting';
        room.timer = 0;
      } else {
        room.timer -= dt;
        if (room.timer <= 0) startRound(room, now);
      }
      break;
    case 'playing':
      room.timer -= dt;
      updateBot(room, dt, now);
      checkRoundEnd(room);
      break;
    case 'results':
      room.timer -= dt;
      if (room.timer <= 0) resetToWaiting(room);
      break;
    default:
      break;
  }
  broadcast(room, now);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) updateRoom(room, now);
}, TICK_MS);

/* ---------- Ligações dos clientes ---------- */
io.on('connection', (socket) => {
  socket.data.roomCode = null;

  // Procurar sala: lista as salas públicas
  socket.on('listRooms', (ack) => {
    const list = Array.from(rooms.values())
      .filter((r) => !r.isPrivate)
      .map(publicInfo)
      .sort((a, b) => b.players - a.players);
    reply(ack, { ok: true, rooms: list });
  });

  // Criar sala (automática ou com código personalizado)
  socket.on('createRoom', (data, ack) => {
    data = data || {};
    leaveCurrentRoom(socket);

    if (rooms.size >= MAX_ROOMS) {
      reply(ack, { ok: false, error: 'O servidor tem demasiadas salas. Tenta mais tarde.' });
      return;
    }

    const mode = MODES.includes(data.mode) ? data.mode : 'normal';
    const profile = sanitizeProfile(data.player);
    let isPrivate = !!data.private;
    let code;

    const wanted = data.code === undefined || data.code === null ? '' : String(data.code).trim();
    if (wanted !== '') {
      code = wanted.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length < 3 || code.length > 8) {
        reply(ack, { ok: false, error: 'O código deve ter entre 3 e 8 letras ou números.' });
        return;
      }
      if (rooms.has(code)) {
        reply(ack, { ok: false, error: 'Esse código já está em uso. Escolhe outro ou entra nessa sala.' });
        return;
      }
      isPrivate = true;
    } else {
      code = generateCode();
    }

    const roomName = sanitizeText(data.name, 24) || 'Sala de ' + profile.name;
    const room = makeRoom(code, roomName, mode, isPrivate);
    rooms.set(code, room);
    joinInto(socket, room, profile, ack);
  });

  // Entrar numa sala (por código ou pela lista)
  socket.on('joinRoom', (data, ack) => {
    data = data || {};
    const code = String(data.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(code);
    if (!room) {
      reply(ack, { ok: false, error: 'Não existe nenhuma sala com esse código.' });
      return;
    }
    if (socket.data.roomCode === code) {
      reply(ack, { ok: false, error: 'Já estás nessa sala.' });
      return;
    }
    leaveCurrentRoom(socket);
    joinInto(socket, room, sanitizeProfile(data.player), ack);
  });

  socket.on('leaveRoom', (ack) => {
    leaveCurrentRoom(socket);
    reply(ack, { ok: true });
  });

  // Movimento: o cliente simula a sua física, o servidor valida limites
  socket.on('move', (d) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !d) return;
    const p = room.players.get(socket.id);
    if (!p || d.seq !== p.seq) return;
    p.x = num(d.x, 0, WORLD, p.x);
    p.y = num(d.y, 0, WORLD, p.y);
    p.z = num(d.z, 0, 400, p.z);
    p.vx = num(d.vx, -900, 900, 0);
    p.vy = num(d.vy, -900, 900, 0);
  });

  // Cosméticos
  socket.on('cosmetics', (d) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !d) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    if (VALID_COLORS.includes(d.color)) p.color = d.color;
    if (VALID_HATS.includes(d.hat)) p.hat = d.hat;
  });

  // Toque (tag): o servidor decide quem foi tocado
  socket.on('tag', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    const p = room.players.get(socket.id);
    const now = Date.now();
    if (!p || room.phase !== 'playing' || !p.alive || !p.inRound) return;
    if (now - p.lastTag < TAG_COOLDOWN_MS) return;
    p.lastTag = now;
    if (now < room.graceUntil) return;

    if (room.mode === 'assassin') {
      if (p.role !== 'assassin') return;
      let victim = null;
      let bestD = TAG_RANGE;
      for (const q of room.players.values()) {
        if (q === p || !q.alive || !q.inRound || q.role !== 'runner') continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bestD && Math.abs(q.z - p.z) < TAG_DZ) {
          bestD = d;
          victim = q;
        }
      }
      if (victim) {
        victim.alive = false;
        p.score += 1;
        feed(room, p.name + ' apanhou ' + victim.name + '!', 'danger');
      }
    } else {
      const b = room.bot;
      if (!b || now < b.stunUntil || now < b.immuneUntil) return;
      if (Math.hypot(b.x - p.x, b.y - p.y) < BOT_STUN_RANGE && p.z < 80) {
        b.stunUntil = now + BOT_STUN_MS;
        b.immuneUntil = now + BOT_STUN_MS + BOT_IMMUNE_MS;
        feed(room, p.name + ' atordoou o Bot Assassino!', 'win');
      }
    }
  });

  socket.on('disconnect', () => {
    leaveCurrentRoom(socket);
  });
});

/* ---------- Arranque ---------- */
server.listen(PORT, '0.0.0.0', () => {
  console.log('Gorilla Tag ISO a correr!');
  console.log('  Local:  http://localhost:' + PORT);
  const nets = os.networkInterfaces();
  Object.keys(nets).forEach((name) => {
    (nets[name] || []).forEach((n) => {
      if (n.family === 'IPv4' && !n.internal) {
        console.log('  Rede:   http://' + n.address + ':' + PORT + '  (' + name + ')');
      }
    });
  });
});
