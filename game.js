/* =====================================================================
   game.js – Motor principal do cliente
   - Projeção isométrica 2D (x, y no chão, z = altura)
   - Física estilo Gorilla Tag: impulsos, gravidade em Z, atrito
   - Colisões com árvores, pedras e troncos (que se podem escalar)
   - Desenho dos gorilas, cores, chapéus, aura do assassino e do bot
   ===================================================================== */

const Game = (() => {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');

  /* ---------- Constantes de física ---------- */
  const GRAVITY = 900;
  const IMPULSE_SPEED = 330;
  const IMPULSE_VZ = 380;
  const IMPULSE_COOLDOWN = 0.28;
  const WALK_ACCEL = 520;
  const WALK_MAX = 140;
  const GROUND_FRICTION = 7;
  const AIR_DRAG = 0.15;
  const PLAYER_R = 22;
  const STEP_UP = 8;

  /* ---------- Constantes de toque ---------- */
  const TAG_RANGE = 80;
  const TAG_DZ = 70;
  const BOT_TAG_RANGE = 85;
  const TAG_COOLDOWN = 0.4;

  /* ---------- Projeção isométrica ---------- */
  const KX = 0.8;
  const KY = 0.4;
  const KZ = 0.9;
  const SEND_INTERVAL = 0.05;

  /* ---------- Catálogo ---------- */
  const COLORS = [
    { id: 'brown', label: 'Castanho', hex: '#6b4423' },
    { id: 'black', label: 'Preto', hex: '#2a2c2f' },
    { id: 'blue', label: 'Azul', hex: '#2f6fdc' },
    { id: 'gold', label: 'Dourado', hex: '#d9a520' },
    { id: 'green', label: 'Verde', hex: '#3f9a45' },
    { id: 'purple', label: 'Roxo', hex: '#7b4bc4' },
    { id: 'pink', label: 'Rosa', hex: '#e87fb5' },
    { id: 'white', label: 'Branco', hex: '#e6e6e6' }
  ];

  const HATS = [
    { id: 'none', label: 'Sem chapéu' },
    { id: 'tophat', label: '🎩 Cartola' },
    { id: 'cap', label: '🧢 Boné' },
    { id: 'crown', label: '👑 Coroa' },
    { id: 'glasses', label: '🕶️ Óculos' }
  ];

  /* ---------- Estado ---------- */
  let running = false;
  let paused = false;
  let world = null;
  let obstacles = [];
  let myId = null;
  let state = null;
  let bot = null;
  const remotes = new Map();
  const particles = [];
  const keys = {};
  const mouse = { x: 0, y: 0, inside: false };

  const me = {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    grounded: true, face: 1, anim: 0,
    name: '', color: 'brown', hat: 'none',
    role: 'runner', alive: true, inRound: false, score: 0
  };

  let impulseCd = 0;
  let tagCd = 0;
  let camX = 0;
  let camY = 0;
  let zoom = 1;
  let W = 0;
  let H = 0;
  let dpr = 1;
  let lastTime = 0;
  let sendAcc = 0;
  let shake = 0;
  let clock = 0;
  let flowers = [];

  /* ---------- Utilitários de cor ---------- */
  function colorHex(id) {
    if (id === 'bot') return '#141414';
    const c = COLORS.find((x) => x.id === id);
    return c ? c.hex : '#6b4423';
  }

  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }

  function shade(hex, amt) {
    const [r, g, b] = hexToRgb(hex);
    const t = amt < 0 ? 0 : 255;
    const k = Math.abs(amt);
    return rgbToHex(r + (t - r) * k, g + (t - g) * k, b + (t - b) * k);
  }

  function mix(a, b, t) {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
  }

  function ell(c, x, y, rx, ry, fill) {
    c.beginPath();
    c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
  }

  /* ---------- Projeção ---------- */
  function proj(x, y, z) {
    const dx = x - camX;
    const dy = y - camY;
    return {
      x: W / 2 + (dx - dy) * KX * zoom,
      y: H / 2 + 40 * zoom + (dx + dy) * KY * zoom - z * KZ * zoom
    };
  }

  function screenDirToWorld(sx, sy) {
    const a = sx / KX;
    const b = sy / KY;
    const wx = (a + b) / 2;
    const wy = (b - a) / 2;
    const l = Math.hypot(wx, wy) || 1;
    return { x: wx / l, y: wy / l };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    zoom = Math.max(0.7, Math.min(1.3, Math.min(W, H) / 800));
  }

  /* =====================================================================
     DESENHO DO GORILA
     (x, y) = pés no ecrã; s = escala
     ===================================================================== */
  function drawGorilla(c, x, y, s, colorId, hat, o) {
    o = o || {};
    const base = colorHex(colorId);
    const dark = shade(base, -0.3);
    const mid = shade(base, 0.12);
    const skin = colorId === 'black' || colorId === 'bot' ? '#5a5048' : mix(base, '#d8b48c', 0.6);
    const t = o.anim || 0;
    const face = o.face === -1 ? -1 : 1;
    const moving = !!o.moving;
    const air = !!o.air;
    const swing = moving && !air ? Math.sin(t * 11) * 7 : 0;

    c.save();
    c.translate(x, y);
    c.scale(s, s);
    if (o.alpha != null) c.globalAlpha = o.alpha;

    // aura vermelha (assassino / bot)
    if (o.aura) {
      const pulse = 0.8 + 0.2 * Math.sin(t * 6 + 1);
      const g = c.createRadialGradient(0, -34, 6, 0, -34, 66 * pulse);
      g.addColorStop(0, 'rgba(255,40,40,0.6)');
      g.addColorStop(1, 'rgba(255,40,40,0)');
      c.fillStyle = g;
      c.beginPath();
      c.arc(0, -34, 66 * pulse, 0, Math.PI * 2);
      c.fill();
    }

    // pernas
    const lift = air ? 4 : 0;
    ell(c, -9, -7 - lift - Math.max(0, swing * 0.6), 8, 8, dark);
    ell(c, 9, -7 - lift - Math.max(0, -swing * 0.6), 8, 8, dark);

    // tronco
    ell(c, 0, -30, 21, 22, base);
    ell(c, 0, -44, 23, 10, base);
    ell(c, face, -27, 12, 14, mid);

    // braços
    c.lineCap = 'round';
    c.strokeStyle = base;
    c.lineWidth = 11;
    const hyL = air ? -72 : -9 + swing;
    const hyR = air ? -72 : -9 - swing;
    const hxL = air ? -31 : -28;
    const hxR = air ? 31 : 28;
    c.beginPath();
    c.moveTo(-19, -44);
    c.lineTo(hxL, hyL);
    c.moveTo(19, -44);
    c.lineTo(hxR, hyR);
    c.stroke();
    ell(c, hxL, hyL, 6.5, 6.5, dark);
    ell(c, hxR, hyR, 6.5, 6.5, dark);

    // cabeça
    ell(c, 0, -56, 13, 12, base);
    ell(c, 0, -66, 8, 5, dark);
    ell(c, face * 2, -54, 9, 8, skin);

    // olhos
    const ex = face * 2;
    ell(c, ex - 4.5, -55, 2.7, 2.7, '#fff');
    ell(c, ex + 4.5, -55, 2.7, 2.7, '#fff');
    const pupil = o.aura ? '#ff2020' : '#111';
    ell(c, ex - 4.5 + face * 0.9, -55, 1.5, 1.5, pupil);
    ell(c, ex + 4.5 + face * 0.9, -55, 1.5, 1.5, pupil);

    // sobrancelhas
    c.strokeStyle = dark;
    c.lineWidth = 2.6;
    c.beginPath();
    if (o.aura) {
      c.moveTo(ex - 8, -61);
      c.lineTo(ex - 1, -58);
      c.moveTo(ex + 1, -58);
      c.lineTo(ex + 8, -61);
    } else {
      c.moveTo(ex - 8, -59);
      c.lineTo(ex + 8, -59);
    }
    c.stroke();

    // boca
    c.strokeStyle = '#2a1a10';
    c.lineWidth = 1.6;
    c.beginPath();
    if (o.stunned) {
      c.arc(ex, -48, 2.2, 0, Math.PI * 2);
    } else {
      c.moveTo(ex - 3, -49);
      c.lineTo(ex + 3, -49);
    }
    c.stroke();

    // chapéus e acessórios
    if (hat === 'tophat') {
      ell(c, 0, -66, 16, 4.5, '#111');
      c.fillStyle = '#1a1a1a';
      c.fillRect(-9.5, -92, 19, 26);
      c.fillStyle = '#a32d2d';
      c.fillRect(-9.5, -73, 19, 5);
      ell(c, 0, -92, 9.5, 3.2, '#2b2b2b');
    } else if (hat === 'cap') {
      c.fillStyle = '#2f6fdc';
      c.beginPath();
      c.arc(0, -64, 13, Math.PI, Math.PI * 2);
      c.closePath();
      c.fill();
      ell(c, face * 11, -63, 10, 3, '#1d4a99');
      ell(c, 0, -77, 2.2, 2.2, '#fff');
    } else if (hat === 'crown') {
      c.beginPath();
      c.moveTo(-11, -65);
      c.lineTo(-11, -81);
      c.lineTo(-5.5, -73);
      c.lineTo(0, -85);
      c.lineTo(5.5, -73);
      c.lineTo(11, -81);
      c.lineTo(11, -65);
      c.closePath();
      c.fillStyle = '#f2c230';
      c.fill();
      c.strokeStyle = '#b88a00';
      c.lineWidth = 1.4;
      c.stroke();
      ell(c, 0, -69, 2, 2, '#e23b3b');
      ell(c, -6, -68, 1.5, 1.5, '#3b8be2');
      ell(c, 6, -68, 1.5, 1.5, '#3be26b');
    } else if (hat === 'glasses') {
      c.strokeStyle = '#0a0a0a';
      c.lineWidth = 1.8;
      c.fillStyle = 'rgba(20,20,30,0.85)';
      c.beginPath();
      c.arc(ex - 4.8, -55, 4.8, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.beginPath();
      c.arc(ex + 4.8, -55, 4.8, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.beginPath();
      c.moveTo(ex - 0.2, -55);
      c.lineTo(ex + 0.2, -55);
      c.stroke();
    }

    // estrelas de atordoamento
    if (o.stunned) {
      for (let i = 0; i < 3; i++) {
        const a = t * 4 + (i * Math.PI * 2) / 3;
        ell(c, Math.cos(a) * 14, -78 + Math.sin(a) * 4, 3, 3, '#ffe36a');
      }
    }
    c.restore();

    // nome
    if (o.name) {
      c.save();
      if (o.alpha != null) c.globalAlpha = Math.max(o.alpha, 0.5);
      c.font = 'bold 12px system-ui, sans-serif';
      c.textAlign = 'center';
      const ny = y - (hat === 'tophat' ? 102 : 90) * s;
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(0,0,0,0.65)';
      c.strokeText(o.name, x, ny);
      c.fillStyle = o.nameColor || '#fff';
      c.fillText(o.name, x, ny);
      c.restore();
    }
  }

  /* =====================================================================
     COLISÕES E ALTURAS
     ===================================================================== */
  function inside(o, x, y, m) {
    if (o.t === 'log') return Math.abs(x - o.x) <= o.hw + m && Math.abs(y - o.y) <= o.hd + m;
    return Math.hypot(x - o.x, y - o.y) <= o.r + m;
  }

  // Altura do chão (0 ou topo de pedra/tronco) para uma posição
  function floorAt(x, y, z) {
    let f = 0;
    for (const o of obstacles) {
      if (o.h > z + STEP_UP) continue;
      if (o.h > f && inside(o, x, y, PLAYER_R * 0.5)) f = o.h;
    }
    return f;
  }

  function supportDepth(p) {
    if (p.z <= 0.5) return -Infinity;
    for (const o of obstacles) {
      if (o.h < 900 && o.h <= p.z + STEP_UP && inside(o, p.x, p.y, PLAYER_R * 0.5)) return o.x + o.y + 1;
    }
    return -Infinity;
  }

  function collide(z) {
    for (const o of obstacles) {
      if (z >= o.h - STEP_UP) continue; // por cima: passa
      let nx;
      let ny;
      let pen;
      if (o.t === 'log') {
        const cx = Math.max(o.x - o.hw, Math.min(me.x, o.x + o.hw));
        const cy = Math.max(o.y - o.hd, Math.min(me.y, o.y + o.hd));
        const dx = me.x - cx;
        const dy = me.y - cy;
        const d = Math.hypot(dx, dy);
        if (d >= PLAYER_R) continue;
        if (d > 0.001) {
          nx = dx / d;
          ny = dy / d;
          pen = PLAYER_R - d;
        } else {
          // centro dentro da caixa: sai pelo eixo de menor penetração
          const px = o.hw - Math.abs(me.x - o.x);
          const py = o.hd - Math.abs(me.y - o.y);
          if (px < py) {
            nx = me.x >= o.x ? 1 : -1;
            ny = 0;
            pen = px + PLAYER_R;
          } else {
            nx = 0;
            ny = me.y >= o.y ? 1 : -1;
            pen = py + PLAYER_R;
          }
        }
      } else {
        const dx = me.x - o.x;
        const dy = me.y - o.y;
        const d = Math.hypot(dx, dy);
        const min = o.r + PLAYER_R;
        if (d >= min) continue;
        nx = d > 0.001 ? dx / d : 1;
        ny = d > 0.001 ? dy / d : 0;
        pen = min - d;
      }
      me.x += nx * pen;
      me.y += ny * pen;
      const vn = me.vx * nx + me.vy * ny;
      if (vn < 0) {
        me.vx -= 1.3 * vn * nx;
        me.vy -= 1.3 * vn * ny;
      }
    }
  }

  /* =====================================================================
     ENTRADA
     ===================================================================== */
  function walkVector() {
    const sx = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0);
    const sy = (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);
    if (!sx && !sy) return null;
    return screenDirToWorld(sx, sy);
  }

  function getAim() {
    const w = walkVector();
    if (w) return w;
    if (mouse.inside) {
      const pp = proj(me.x, me.y, 0);
      const dx = mouse.x - pp.x;
      const dy = mouse.y - pp.y;
      if (Math.hypot(dx, dy) > 8) return screenDirToWorld(dx, dy);
    }
    return screenDirToWorld(me.face, -0.4);
  }

  function burst(x, y, z, n, color) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 40 + Math.random() * 120;
      particles.push({
        x, y, z: z + 8,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: 80 + Math.random() * 160,
        life: 0.5 + Math.random() * 0.3, max: 0.8, col: color, size: 2 + Math.random() * 3
      });
    }
  }

  function tryImpulse(dir) {
    if (impulseCd > 0 || !me.grounded) return false;
    me.vx = dir.x * IMPULSE_SPEED;
    me.vy = dir.y * IMPULSE_SPEED;
    me.vz = IMPULSE_VZ;
    me.grounded = false;
    impulseCd = IMPULSE_COOLDOWN;
    burst(me.x, me.y, me.z, 6, '#d8cfae');
    return true;
  }

  function findLocalTarget() {
    if (!state || state.phase !== 'playing' || !me.alive || !me.inRound) return null;
    if (state.mode === 'assassin') {
      if (me.role !== 'assassin') return null;
      for (const r of remotes.values()) {
        if (!r.alive || !r.inRound || r.role !== 'runner') continue;
        if (Math.hypot(r.x - me.x, r.y - me.y) < TAG_RANGE && Math.abs(r.z - me.z) < TAG_DZ) return r;
      }
      return null;
    }
    if (bot && !bot.stunned && Math.hypot(bot.x - me.x, bot.y - me.y) < BOT_TAG_RANGE && me.z < 80) return bot;
    return null;
  }

  function tryTag() {
    if (tagCd > 0) return false;
    const target = findLocalTarget();
    if (!target) return false;
    tagCd = TAG_COOLDOWN;
    Net.sendTag();
    burst(target.x, target.y, target.z || 0, 12, '#ffe36a');
    return true;
  }

  function typingInField(e) {
    const tag = e.target && e.target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA';
  }

  function onKeyDown(e) {
    if (!running || paused || typingInField(e)) return;
    keys[e.code] = true;
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.code === 'KeyE' && !e.repeat) tryTag();
  }

  function onKeyUp(e) {
    keys[e.code] = false;
  }

  function onPointerMove(e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.inside = true;
  }

  function onPointerDown(e) {
    if (!running || paused) return;
    mouse.x = e.clientX;
    mouse.y = e.clientY;
    mouse.inside = true;
    if (e.button === 2) {
      tryTag();
    } else if (e.button === 0) {
      if (!tryTag()) tryImpulse(getAim());
    }
  }

  /* =====================================================================
     ATUALIZAÇÃO
     ===================================================================== */
  function stepPlayer(dt) {
    const prevZ = me.z;
    const f0 = floorAt(me.x, me.y, prevZ);
    const onGround = prevZ <= f0 + 0.5 && me.vz <= 0;

    if (onGround) {
      me.z = f0;
      me.vz = 0;
      const fr = Math.exp(-GROUND_FRICTION * dt);
      me.vx *= fr;
      me.vy *= fr;
      const w = walkVector();
      if (w) {
        const before = Math.hypot(me.vx, me.vy);
        me.vx += w.x * WALK_ACCEL * dt;
        me.vy += w.y * WALK_ACCEL * dt;
        const cap = Math.max(WALK_MAX, before);
        const now = Math.hypot(me.vx, me.vy);
        if (now > cap) {
          me.vx *= cap / now;
          me.vy *= cap / now;
        }
      }
    } else {
      me.vz -= GRAVITY * dt;
      const d = Math.exp(-AIR_DRAG * dt);
      me.vx *= d;
      me.vy *= d;
    }

    me.x += me.vx * dt;
    me.y += me.vy * dt;
    collide(prevZ);
    me.x = Math.max(PLAYER_R, Math.min(world.size - PLAYER_R, me.x));
    me.y = Math.max(PLAYER_R, Math.min(world.size - PLAYER_R, me.y));

    me.z += me.vz * dt;
    const f1 = floorAt(me.x, me.y, Math.max(prevZ, me.z));
    if (me.z <= f1 && me.vz <= 0) {
      if (!onGround && me.vz < -120) burst(me.x, me.y, f1, 5, '#cfc59a');
      me.z = f1;
      me.vz = 0;
    }
    me.grounded = me.z <= f1 + 0.5 && me.vz <= 0;

    const sv = me.vx - me.vy;
    if (Math.abs(sv) > 10) me.face = sv > 0 ? 1 : -1;
  }

  function update(dt) {
    clock += dt;
    if (impulseCd > 0) impulseCd -= dt;
    if (tagCd > 0) tagCd -= dt;
    if (shake > 0) shake = Math.max(0, shake - dt * 2);

    if (!paused && keys.Space) tryImpulse(getAim());
    stepPlayer(dt);
    me.anim += dt * (Math.hypot(me.vx, me.vy) > 25 ? 1 : 0.3);

    // enviar posição
    sendAcc += dt;
    if (sendAcc >= SEND_INTERVAL) {
      sendAcc = 0;
      Net.sendMove({ x: me.x, y: me.y, z: me.z, vx: me.vx, vy: me.vy, seq: Net.getSeq() });
    }

    // suavização dos outros jogadores
    const k = 1 - Math.exp(-dt * 14);
    remotes.forEach((r) => {
      r.x += (r.tx - r.x) * k;
      r.y += (r.ty - r.y) * k;
      r.z += (r.tz - r.z) * k;
      const sv = r.vx - r.vy;
      if (Math.abs(sv) > 10) r.face = sv > 0 ? 1 : -1;
      r.anim += dt * (Math.hypot(r.vx, r.vy) > 25 ? 1 : 0.3);
    });
    if (bot) {
      const kb = 1 - Math.exp(-dt * 12);
      bot.x += (bot.tx - bot.x) * kb;
      bot.y += (bot.ty - bot.y) * kb;
      bot.anim += dt * (bot.stunned ? 0.2 : 1);
    }

    // partículas
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.vz -= 600 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z = Math.max(0, p.z + p.vz * dt);
    }

    // câmara
    const kc = 1 - Math.exp(-dt * 10);
    camX += (me.x - camX) * kc;
    camY += (me.y - camY) * kc;
  }

  /* =====================================================================
     DESENHO DO MUNDO
     ===================================================================== */
  function drawShadow(x, y, rx, ry, alpha) {
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(2, rx), Math.max(1, ry), 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,' + (alpha == null ? 0.28 : alpha) + ')';
    ctx.fill();
  }

  function footprintEllipse(r) {
    return { rx: r * KX * Math.SQRT2 * zoom, ry: r * KY * Math.SQRT2 * zoom };
  }

  function poly(points, fill) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  }

  function drawGround() {
    const size = world.size;
    const T = 200;
    const n = size / T;

    // falésia (lado da frente)
    poly([
      proj(size, 0, 0), proj(size, size, 0), proj(0, size, 0),
      proj(0, size, -50), proj(size, size, -50), proj(size, 0, -50)
    ], '#5b3d22');
    poly([proj(size, 0, 0), proj(size, size, 0), proj(size, size, -50), proj(size, 0, -50)], '#4a301b');

    // relva em quadrados alternados
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = proj(i * T, j * T, 0);
        const b = proj((i + 1) * T, j * T, 0);
        const c = proj((i + 1) * T, (j + 1) * T, 0);
        const d = proj(i * T, (j + 1) * T, 0);
        const minX = Math.min(a.x, b.x, c.x, d.x);
        const maxX = Math.max(a.x, b.x, c.x, d.x);
        const minY = Math.min(a.y, b.y, c.y, d.y);
        const maxY = Math.max(a.y, b.y, c.y, d.y);
        if (maxX < -20 || minX > W + 20 || maxY < -20 || minY > H + 20) continue;
        poly([a, b, c, d], (i + j) % 2 ? '#4c9a48' : '#56a652');
      }
    }

    // flores decorativas
    for (const f of flowers) {
      const p = proj(f.x, f.y, 0);
      if (p.x < -10 || p.x > W + 10 || p.y < -10 || p.y > H + 10) continue;
      ell(ctx, p.x, p.y, 2.6 * zoom, 1.4 * zoom, f.c);
    }

    // contorno do mapa
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const p0 = proj(0, 0, 0);
    ctx.moveTo(p0.x, p0.y);
    [proj(size, 0, 0), proj(size, size, 0), proj(0, size, 0), proj(0, 0, 0)].forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.stroke();
  }

  function drawTree(o) {
    const base = proj(o.x, o.y, 0);
    const z = zoom;
    const sway = Math.sin(clock * 1.5 + o.id) * 2 * z;
    drawShadow(base.x, base.y, 36 * z, 15 * z, 0.25);
    const top = proj(o.x, o.y, 100);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#6b4a2b';
    ctx.lineWidth = 18 * z;
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(top.x, top.y);
    ctx.stroke();
    ctx.strokeStyle = '#52371f';
    ctx.lineWidth = 6 * z;
    ctx.beginPath();
    ctx.moveTo(base.x + 5 * z, base.y);
    ctx.lineTo(top.x + 5 * z, top.y);
    ctx.stroke();
    const c1 = proj(o.x, o.y, 125);
    const c2 = proj(o.x, o.y, 165);
    const c3 = proj(o.x, o.y, 200);
    ell(ctx, c1.x + sway * 0.4, c1.y, 58 * z, 36 * z, '#2d7a3a');
    ell(ctx, c2.x + sway * 0.7, c2.y, 47 * z, 30 * z, '#389148');
    ell(ctx, c3.x + sway, c3.y, 34 * z, 23 * z, '#47a857');
    ell(ctx, c3.x + sway - 8 * z, c3.y - 5 * z, 12 * z, 7 * z, 'rgba(255,255,255,0.15)');
  }

  function drawRock(o) {
    const z = zoom;
    const base = proj(o.x, o.y, 0);
    const top = proj(o.x, o.y, o.h);
    const fp = footprintEllipse(o.r);
    drawShadow(base.x, base.y, fp.rx * 1.15, fp.ry * 1.2, 0.22);
    ell(ctx, base.x, base.y, fp.rx, fp.ry, '#5c6168');
    ctx.fillStyle = '#7b8189';
    ctx.fillRect(base.x - fp.rx, top.y, fp.rx * 2, base.y - top.y);
    ell(ctx, base.x, top.y, fp.rx, fp.ry, '#a3a9b1');
    ell(ctx, base.x - fp.rx * 0.2, top.y - fp.ry * 0.15, fp.rx * 0.55, fp.ry * 0.5, '#b9bfc6');
    ell(ctx, base.x + fp.rx * 0.3, top.y + fp.ry * 0.1, 3 * z, 2 * z, '#8d939b');
  }

  function drawLog(o) {
    const h = o.h;
    const A = proj(o.x - o.hw, o.y - o.hd, h);
    const B = proj(o.x + o.hw, o.y - o.hd, h);
    const C = proj(o.x + o.hw, o.y + o.hd, h);
    const D = proj(o.x - o.hw, o.y + o.hd, h);
    const B0 = proj(o.x + o.hw, o.y - o.hd, 0);
    const C0 = proj(o.x + o.hw, o.y + o.hd, 0);
    const D0 = proj(o.x - o.hw, o.y + o.hd, 0);
    // sombra
    poly([
      proj(o.x - o.hw - 6, o.y - o.hd - 6, 0), proj(o.x + o.hw + 8, o.y - o.hd - 6, 0),
      proj(o.x + o.hw + 8, o.y + o.hd + 8, 0), proj(o.x - o.hw - 6, o.y + o.hd + 8, 0)
    ], 'rgba(0,0,0,0.2)');
    poly([B, C, C0, B0], '#6e4523');
    poly([D, C, C0, D0], '#85562c');
    poly([A, B, C, D], '#a8743f');
    // veios da madeira
    ctx.strokeStyle = 'rgba(70,40,15,0.45)';
    ctx.lineWidth = 1.5 * zoom;
    const alongX = o.hw > o.hd;
    for (let i = -1; i <= 1; i += 2) {
      const p1 = alongX ? proj(o.x - o.hw * 0.9, o.y + i * o.hd * 0.45, h) : proj(o.x + i * o.hw * 0.45, o.y - o.hd * 0.9, h);
      const p2 = alongX ? proj(o.x + o.hw * 0.9, o.y + i * o.hd * 0.45, h) : proj(o.x + i * o.hw * 0.45, o.y + o.hd * 0.9, h);
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
      ctx.stroke();
    }
  }

  function drawPlayerEntity(p, isMe) {
    const floorZ = floorAt(p.x, p.y, p.z);
    const air = p.z > floorZ + 3;
    const sh = proj(p.x, p.y, floorZ);
    const fade = 1 - Math.min(0.5, (p.z - floorZ) / 300);
    const ghost = !p.alive;
    const assassin = p.role === 'assassin' && p.alive;
    drawShadow(sh.x, sh.y, 20 * zoom * fade, 8 * zoom * fade, ghost ? 0.1 : 0.3);
    if (assassin) {
      ctx.strokeStyle = 'rgba(255,60,60,' + (0.55 + 0.25 * Math.sin(clock * 6)) + ')';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(sh.x, sh.y, 30 * zoom, 12 * zoom, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const pos = proj(p.x, p.y, p.z);
    drawGorilla(ctx, pos.x, pos.y, zoom * 0.95, p.color, p.hat, {
      face: p.face,
      anim: p.anim,
      air,
      moving: Math.hypot(p.vx, p.vy) > 25,
      aura: assassin,
      alpha: ghost ? 0.35 : 1,
      name: p.name + (isMe ? ' (tu)' : ''),
      nameColor: assassin ? '#ff7070' : isMe ? '#ffe36a' : '#ffffff'
    });
  }

  function drawBot() {
    const sh = proj(bot.x, bot.y, 0);
    drawShadow(sh.x, sh.y, 28 * zoom, 11 * zoom, 0.35);
    ctx.strokeStyle = 'rgba(255,60,60,' + (0.55 + 0.25 * Math.sin(clock * 6)) + ')';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(sh.x, sh.y, 38 * zoom, 15 * zoom, 0, 0, Math.PI * 2);
    ctx.stroke();
    drawGorilla(ctx, sh.x, sh.y, zoom * 1.2, 'bot', 'none', {
      face: bot.face,
      anim: bot.anim,
      moving: !bot.stunned,
      aura: !bot.stunned,
      stunned: bot.stunned,
      alpha: bot.stunned ? 0.7 : 1,
      name: 'BOT ASSASSINO',
      nameColor: '#ff5050'
    });
  }

  function drawAim() {
    if (!me.alive) return;
    const dir = getAim();
    const len = 110;
    const a = proj(me.x, me.y, 0);
    const b = proj(me.x + dir.x * len, me.y + dir.y * len, 0);
    const ready = me.grounded && impulseCd <= 0;
    ctx.save();
    ctx.strokeStyle = ready ? 'rgba(120,255,140,0.85)' : 'rgba(255,255,255,0.3)';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - Math.cos(ang - 0.45) * 14, b.y - Math.sin(ang - 0.45) * 14);
    ctx.lineTo(b.x - Math.cos(ang + 0.45) * 14, b.y - Math.sin(ang + 0.45) * 14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawMinimap() {
    const size = world.size;
    const mw = 150;
    const m = mw / (2 * size * KX);
    const x0 = 14 + mw / 2;
    const y0 = H - 14 - mw * (KY / KX) - 4;
    const mp = (x, y) => ({ x: x0 + (x - y) * KX * m, y: y0 + (x + y) * KY * m });

    ctx.save();
    ctx.globalAlpha = 0.85;
    const pts = [mp(0, 0), mp(size, 0), mp(size, size), mp(0, size)];
    poly(pts, 'rgba(10,25,15,0.7)');
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();

    for (const o of obstacles) {
      const p = mp(o.x, o.y);
      ctx.fillStyle = o.t === 'tree' ? '#3fa050' : o.t === 'rock' ? '#9aa0a8' : '#b07a3e';
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    remotes.forEach((r) => {
      const p = mp(r.x, r.y);
      ctx.fillStyle = !r.alive ? '#666' : r.role === 'assassin' ? '#ff3b3b' : colorHex(r.color);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
    });
    if (bot) {
      const p = mp(bot.x, bot.y);
      ctx.fillStyle = '#ff2020';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    const pm = mp(me.x, me.y);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pm.x, pm.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0e2a3a');
    g.addColorStop(1, '#10331f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    if (!world) return;

    ctx.save();
    if (shake > 0) ctx.translate((Math.random() - 0.5) * 12 * shake, (Math.random() - 0.5) * 12 * shake);

    drawGround();

    const items = [];
    for (const o of obstacles) {
      const c = proj(o.x, o.y, 0);
      if (c.x < -320 || c.x > W + 320 || c.y < -320 || c.y > H + 320) continue;
      items.push({ d: o.x + o.y, k: 0, o });
    }
    remotes.forEach((r) => items.push({ d: Math.max(r.x + r.y, supportDepth(r)), k: 1, o: r }));
    if (bot) items.push({ d: bot.x + bot.y, k: 2, o: bot });
    items.push({ d: Math.max(me.x + me.y, supportDepth(me)), k: 3, o: me });
    items.sort((a, b) => a.d - b.d);

    for (const it of items) {
      if (it.k === 0) {
        if (it.o.t === 'tree') drawTree(it.o);
        else if (it.o.t === 'rock') drawRock(it.o);
        else drawLog(it.o);
      } else if (it.k === 1) {
        drawPlayerEntity(it.o, false);
      } else if (it.k === 2) {
        drawBot();
      } else {
        drawPlayerEntity(me, true);
      }
    }

    for (const p of particles) {
      const s = proj(p.x, p.y, p.z);
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.col;
      ctx.beginPath();
      ctx.arc(s.x, s.y, p.size * zoom, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    drawAim();
    ctx.restore();
    drawMinimap();
  }

  /* =====================================================================
     REDE → ESTADO
     ===================================================================== */
  function applyState(s) {
    if (!running) return;
    state = s;
    const seen = new Set();

    for (const p of s.players) {
      if (p.id === myId) {
        if (me.alive && !p.alive) {
          burst(me.x, me.y, me.z, 18, '#ff4a4a');
          shake = 0.5;
        }
        me.role = p.role;
        me.alive = p.alive;
        me.inRound = p.inRound;
        me.score = p.score;
        continue;
      }
      seen.add(p.id);
      let r = remotes.get(p.id);
      if (!r) {
        r = {
          x: p.x, y: p.y, z: p.z, tx: p.x, ty: p.y, tz: p.z, vx: 0, vy: 0,
          anim: Math.random() * 6, face: 1, alive: p.alive
        };
        remotes.set(p.id, r);
      }
      if (r.alive && !p.alive) burst(r.x, r.y, r.z, 18, '#ff4a4a');
      r.tx = p.x;
      r.ty = p.y;
      r.tz = p.z;
      r.vx = p.vx;
      r.vy = p.vy;
      r.name = p.name;
      r.color = p.color;
      r.hat = p.hat;
      r.role = p.role;
      r.alive = p.alive;
      r.inRound = p.inRound;
    }
    for (const id of Array.from(remotes.keys())) {
      if (!seen.has(id)) remotes.delete(id);
    }

    if (s.bot) {
      if (!bot) bot = { x: s.bot.x, y: s.bot.y, tx: s.bot.x, ty: s.bot.y, face: 1, anim: 0, stunned: false };
      bot.tx = s.bot.x;
      bot.ty = s.bot.y;
      bot.face = s.bot.face;
      bot.stunned = s.bot.stunned;
    } else {
      bot = null;
    }
  }

  function onTeleport(t) {
    if (!running) return;
    me.x = t.x;
    me.y = t.y;
    me.z = 0;
    me.vx = 0;
    me.vy = 0;
    me.vz = 0;
    camX = me.x;
    camY = me.y;
    burst(me.x, me.y, 0, 10, '#ffffff');
  }

  /* =====================================================================
     CICLO PRINCIPAL
     ===================================================================== */
  function frame(ts) {
    if (!running) return;
    const dt = Math.min(0.05, (ts - lastTime) / 1000 || 0.016);
    lastTime = ts;
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  function makeFlowers(seed) {
    let a = seed | 0;
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const cols = ['#ffe36a', '#ffffff', '#ff9ac8', '#b38cff'];
    const list = [];
    for (let i = 0; i < 120; i++) {
      list.push({ x: rnd() * world.size, y: rnd() * world.size, c: cols[Math.floor(rnd() * cols.length)] });
    }
    return list;
  }

  function start(info) {
    world = info.map;
    obstacles = info.map.obstacles;
    myId = info.id;
    flowers = makeFlowers(world.seed);

    me.x = info.you.x;
    me.y = info.you.y;
    me.z = 0;
    me.vx = me.vy = me.vz = 0;
    me.grounded = true;
    me.alive = info.you.alive;
    me.inRound = false;
    me.role = 'runner';
    me.score = 0;
    me.name = info.profile.name;
    me.color = info.profile.color;
    me.hat = info.profile.hat;
    camX = me.x;
    camY = me.y;

    remotes.clear();
    particles.length = 0;
    bot = null;
    state = null;
    Object.keys(keys).forEach((k) => { keys[k] = false; });
    impulseCd = 0;
    tagCd = 0;
    paused = false;
    resize();
    running = true;
    lastTime = performance.now();
    requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    state = null;
    bot = null;
    remotes.clear();
    particles.length = 0;
    world = null;
    obstacles = [];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
  }

  function setPaused(flag) {
    paused = !!flag;
    if (paused) Object.keys(keys).forEach((k) => { keys[k] = false; });
  }

  /* ---------- Inicialização ---------- */
  window.addEventListener('resize', resize);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => Object.keys(keys).forEach((k) => { keys[k] = false; }));
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerleave', () => { mouse.inside = false; });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  Net.on('state', applyState);
  Net.on('teleport', onTeleport);
  resize();

  return {
    COLORS,
    HATS,
    colorHex,
    drawGorilla,
    start,
    stop,
    setPaused,
    isRunning: () => running
  };
})();
