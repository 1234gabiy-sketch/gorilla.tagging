/* =====================================================================
   ui.js – Navegação entre menus, catálogo, salas e HUD
   ===================================================================== */

const UI = (() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'gtiso_profile';

  const profile = { name: '', color: 'brown', hat: 'none', mode: 'normal' };

  let inGame = false;
  let isPaused = false;
  let previewRaf = 0;
  let previewT = 0;
  let toastTimer = 0;
  let lastListUpdate = 0;
  let currentRoom = null;

  /* ---------- Perfil (guardado no browser) ---------- */
  function loadProfile() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) Object.assign(profile, JSON.parse(raw));
    } catch (err) {
      /* sem armazenamento: usa valores por defeito */
    }
    if (!Game.COLORS.some((c) => c.id === profile.color)) profile.color = 'brown';
    if (!Game.HATS.some((h) => h.id === profile.hat)) profile.hat = 'none';
    if (profile.mode !== 'normal' && profile.mode !== 'assassin') profile.mode = 'normal';
    if (typeof profile.name !== 'string') profile.name = '';
  }

  function saveProfile() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
    } catch (err) {
      /* ignora */
    }
  }

  function playerData() {
    return { name: profile.name, color: profile.color, hat: profile.hat };
  }

  /* ---------- Navegação ---------- */
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    if (id === 'screen-catalog') startPreview();
    else stopPreview();
    if (id === 'screen-rooms') {
      $('rooms-mode-note').textContent =
        'Modo escolhido: ' + (profile.mode === 'assassin' ? '🗡️ Assassino' : '🤖 Normal') +
        ' (aplica-se às salas que criares; ao entrar numa sala existente, vale o modo dessa sala).';
      clearError();
    }
    if (id === 'screen-play') {
      $('player-name').value = profile.name;
      highlightMode();
    }
  }

  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  /* ---------- Catálogo ---------- */
  function buildCatalog() {
    const colorList = $('color-list');
    colorList.innerHTML = '';
    Game.COLORS.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c.hex;
      b.title = c.label;
      b.setAttribute('aria-label', c.label);
      b.dataset.color = c.id;
      b.addEventListener('click', () => {
        profile.color = c.id;
        saveProfile();
        highlightCatalog();
        Net.sendCosmetics({ color: profile.color, hat: profile.hat });
      });
      colorList.appendChild(b);
    });

    const hatList = $('hat-list');
    hatList.innerHTML = '';
    Game.HATS.forEach((h) => {
      const b = document.createElement('button');
      b.className = 'hat-btn';
      b.textContent = h.label;
      b.dataset.hat = h.id;
      b.addEventListener('click', () => {
        profile.hat = h.id;
        saveProfile();
        highlightCatalog();
        Net.sendCosmetics({ color: profile.color, hat: profile.hat });
      });
      hatList.appendChild(b);
    });
    highlightCatalog();
  }

  function highlightCatalog() {
    document.querySelectorAll('.swatch').forEach((el) => el.classList.toggle('selected', el.dataset.color === profile.color));
    document.querySelectorAll('.hat-btn').forEach((el) => el.classList.toggle('selected', el.dataset.hat === profile.hat));
  }

  function drawPreview() {
    const cv = $('preview');
    const c = cv.getContext('2d');
    c.clearRect(0, 0, cv.width, cv.height);
    previewT += 0.03;
    // sombra no chão
    c.beginPath();
    c.ellipse(140, 282, 70, 20, 0, 0, Math.PI * 2);
    c.fillStyle = 'rgba(0,0,0,0.3)';
    c.fill();
    const bob = Math.sin(previewT * 2) * 3;
    Game.drawGorilla(c, 140, 282 + bob, 3.1, profile.color, profile.hat, {
      anim: previewT,
      face: Math.sin(previewT * 0.7) > 0 ? 1 : -1,
      moving: false
    });
  }

  function startPreview() {
    stopPreview();
    const loop = () => {
      drawPreview();
      previewRaf = requestAnimationFrame(loop);
    };
    loop();
  }

  function stopPreview() {
    if (previewRaf) cancelAnimationFrame(previewRaf);
    previewRaf = 0;
  }

  /* ---------- Jogar: nome e modo ---------- */
  function highlightMode() {
    document.querySelectorAll('.mode-card').forEach((el) => el.classList.toggle('selected', el.dataset.mode === profile.mode));
  }

  function commitName() {
    const typed = $('player-name').value.replace(/[<>]/g, '').trim().slice(0, 14);
    profile.name = typed || profile.name || 'Gorila' + (100 + Math.floor(Math.random() * 900));
    saveProfile();
  }

  /* ---------- Salas ---------- */
  function showError(msg) {
    const el = $('rooms-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function clearError() {
    $('rooms-error').classList.add('hidden');
  }

  function setBusy(flag) {
    document.querySelectorAll('.rooms-action').forEach((b) => { b.disabled = flag; });
  }

  function switchTab(id) {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === id));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === id));
    clearError();
    if (id === 'tab-browse') refreshRooms();
  }

  async function refreshRooms() {
    const list = $('room-list');
    list.innerHTML = '';
    const loading = document.createElement('li');
    loading.className = 'empty';
    loading.textContent = 'A procurar salas…';
    list.appendChild(loading);

    const res = await Net.listRooms();
    list.innerHTML = '';
    if (!res.ok) {
      showError(res.error || 'Não foi possível obter a lista de salas.');
      return;
    }
    if (res.rooms.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Ainda não há salas públicas. Cria a primeira!';
      list.appendChild(li);
      return;
    }

    res.rooms.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'room-item';

      const info = document.createElement('div');
      info.className = 'room-info';
      const title = document.createElement('strong');
      title.textContent = r.name;
      const badge = document.createElement('span');
      badge.className = 'badge' + (r.mode === 'assassin' ? ' assassin' : '');
      badge.textContent = r.mode === 'assassin' ? 'Assassino' : 'Normal';
      title.appendChild(badge);
      const sub = document.createElement('small');
      sub.textContent = 'Código ' + r.code + ' · ' + r.players + '/' + r.max + ' jogadores';
      info.appendChild(title);
      info.appendChild(sub);

      const btn = document.createElement('button');
      btn.className = 'btn small primary rooms-action';
      btn.textContent = r.players >= r.max ? 'Cheia' : 'Entrar';
      btn.disabled = r.players >= r.max;
      btn.addEventListener('click', () => enterRoom(Net.joinRoom({ code: r.code, player: playerData() })));

      li.appendChild(info);
      li.appendChild(btn);
      list.appendChild(li);
    });
  }

  async function enterRoom(promise) {
    clearError();
    setBusy(true);
    const res = await promise;
    setBusy(false);
    if (!res.ok) {
      showError(res.error || 'Erro desconhecido.');
      return;
    }
    startGame(res);
  }

  function cleanCode(v) {
    return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  }

  /* ---------- Entrar / sair da partida ---------- */
  function startGame(res) {
    currentRoom = res.room;
    inGame = true;
    isPaused = false;
    $('menu-layer').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('pause').classList.add('hidden');
    $('hud-feed').innerHTML = '';
    $('player-list').innerHTML = '';
    $('hud-banner').textContent = '';
    $('hud-room').textContent = '🔑 ' + res.room.code + ' · ' + res.room.name;
    $('hud-mode').textContent = res.room.mode === 'assassin' ? '🗡 Modo Assassino' : '🤖 Modo Normal';
    $('hud-timer').textContent = '--:--';
    Game.start({ id: res.id, you: res.you, map: res.map, profile: playerData() });
  }

  async function leaveGame(message) {
    if (!inGame) return;
    inGame = false;
    isPaused = false;
    Game.stop();
    await Net.leaveRoom();
    currentRoom = null;
    $('hud').classList.add('hidden');
    $('pause').classList.add('hidden');
    $('menu-layer').classList.remove('hidden');
    showScreen('screen-main');
    if (message) toast(message);
  }

  function togglePause() {
    if (!inGame) return;
    isPaused = !isPaused;
    Game.setPaused(isPaused);
    $('pause').classList.toggle('hidden', !isPaused);
  }

  /* ---------- HUD ---------- */
  function formatTime(sec) {
    const s = Math.max(0, Math.ceil(sec));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function bannerFor(s, me) {
    if (s.phase === 'waiting') {
      return { text: s.mode === 'assassin' ? 'À espera de mais jogadores (mínimo 2)…' : 'À espera de jogadores…', cls: 'info' };
    }
    if (s.phase === 'countdown') {
      return { text: 'A ronda começa em ' + Math.ceil(s.timer) + '…', cls: 'info' };
    }
    if (s.phase === 'results') {
      return { text: s.msg || 'Fim da ronda', cls: 'safe' };
    }
    if (!me) return { text: '', cls: 'info' };
    if (!me.inRound) return { text: 'Estás a espectar: entras na próxima ronda.', cls: 'info' };
    if (!me.alive) return { text: 'Foste apanhado! Espectador até ao fim da ronda.', cls: 'danger' };
    if (me.role === 'assassin') return { text: '🗡 ÉS O ASSASSINO! Aproxima-te e clica para apanhar.', cls: 'danger' };
    if (s.mode === 'assassin') return { text: '🏃 FOGE do Assassino até o tempo acabar!', cls: 'safe' };
    return { text: '🏃 FOGE do Bot Assassino! Podes atordoá-lo ao tocar-lhe.', cls: 'safe' };
  }

  function updatePlayerList(s, myId) {
    const list = $('player-list');
    list.innerHTML = '';
    const sorted = s.players.slice().sort((a, b) => b.score - a.score);
    sorted.forEach((p) => {
      const li = document.createElement('li');
      if (p.id === myId) li.classList.add('me');
      if (!p.alive) li.classList.add('out');
      const n = document.createElement('span');
      n.className = 'pname';
      n.textContent = (p.role === 'assassin' && p.alive ? '🗡 ' : '') + p.name;
      const sc = document.createElement('span');
      sc.textContent = String(p.score);
      li.appendChild(n);
      li.appendChild(sc);
      list.appendChild(li);
    });
  }

  function updateHud(s) {
    if (!inGame) return;
    const myId = Net.getId();
    const me = s.players.find((p) => p.id === myId);

    $('hud-mode').textContent = s.mode === 'assassin' ? '🗡 Modo Assassino' : '🤖 Modo Normal';
    $('hud-timer').textContent = s.phase === 'playing' || s.phase === 'countdown' ? formatTime(s.timer) : '--:--';

    const b = bannerFor(s, me);
    const banner = $('hud-banner');
    banner.textContent = b.text;
    banner.className = b.cls;

    const now = performance.now();
    if (now - lastListUpdate > 400) {
      lastListUpdate = now;
      updatePlayerList(s, myId);
    }
  }

  function addFeed(f) {
    if (!inGame) return;
    const box = $('hud-feed');
    const item = document.createElement('div');
    item.className = 'feed-item ' + (f.kind || 'info');
    item.textContent = f.text;
    box.appendChild(item);
    while (box.children.length > 6) box.removeChild(box.firstChild);
    setTimeout(() => item.classList.add('fade'), 5500);
    setTimeout(() => { if (item.parentNode) item.parentNode.removeChild(item); }, 6200);
  }

  /* ---------- Inicialização ---------- */
  function init() {
    loadProfile();
    buildCatalog();

    // botões de navegação genéricos
    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => showScreen(btn.dataset.goto));
    });

    // seleção de modo
    document.querySelectorAll('.mode-card').forEach((card) => {
      card.addEventListener('click', () => {
        profile.mode = card.dataset.mode;
        saveProfile();
        highlightMode();
      });
    });

    $('play-next').addEventListener('click', () => {
      commitName();
      showScreen('screen-rooms');
      switchTab('tab-create');
    });

    // separadores das salas
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', () => switchTab(t.dataset.tab));
    });

    // criar sala
    $('btn-create-room').addEventListener('click', () => {
      enterRoom(Net.createRoom({
        name: $('room-name').value,
        mode: profile.mode,
        private: $('room-private').checked,
        player: playerData()
      }));
    });

    // procurar sala
    $('btn-refresh').addEventListener('click', refreshRooms);

    // código da sala
    $('code-input').addEventListener('input', (e) => { e.target.value = cleanCode(e.target.value); });
    $('btn-join-code').addEventListener('click', () => {
      const code = cleanCode($('code-input').value);
      if (code.length < 3) {
        showError('Escreve um código com pelo menos 3 letras ou números.');
        return;
      }
      enterRoom(Net.joinRoom({ code, player: playerData() }));
    });
    $('btn-create-code').addEventListener('click', () => {
      const code = cleanCode($('code-input').value);
      if (code.length < 3) {
        showError('Escolhe um código com pelo menos 3 letras ou números.');
        return;
      }
      enterRoom(Net.createRoom({
        code,
        name: $('room-name').value,
        mode: profile.mode,
        player: playerData()
      }));
    });

    // copiar código da sala (HUD)
    $('hud-room').addEventListener('click', () => {
      if (!currentRoom) return;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(currentRoom.code).then(
          () => toast('Código ' + currentRoom.code + ' copiado!'),
          () => toast('Código da sala: ' + currentRoom.code)
        );
      } else {
        toast('Código da sala: ' + currentRoom.code);
      }
    });

    // pausa
    $('btn-resume').addEventListener('click', togglePause);
    $('btn-leave').addEventListener('click', () => leaveGame());
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && inGame) {
        e.preventDefault();
        togglePause();
      }
    });

    // eventos de rede
    Net.on('state', updateHud);
    Net.on('feed', addFeed);
    Net.on('status', (online) => {
      const el = $('conn-status');
      el.innerHTML = '';
      const dot = document.createElement('span');
      dot.className = 'dot ' + (online ? 'on' : 'off');
      el.appendChild(dot);
      el.appendChild(document.createTextNode(online ? 'Ligado ao servidor' : 'Sem ligação ao servidor'));
    });
    Net.on('kicked', () => leaveGame('Perdeste a ligação ao servidor.'));

    Net.connect();
    showScreen('screen-main');
  }

  init();

  return { profile, showScreen, toast };
})();
