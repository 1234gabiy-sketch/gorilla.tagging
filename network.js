/* =====================================================================
   network.js – Gestão da ligação Socket.io no cliente
   Eventos emitidos para o resto da app (Net.on):
     'status'   -> true/false (ligado ou não)
     'state'    -> estado da sala (jogadores, bot, fase, tempo)
     'teleport' -> servidor reposicionou o jogador {x, y, seq}
     'feed'     -> mensagem para o registo de eventos {text, kind}
     'kicked'   -> perdeu a ligação durante uma partida
   ===================================================================== */

const Net = (() => {
  'use strict';

  let socket = null;
  let myId = null;
  let seq = 0;
  let inRoom = false;
  const handlers = {};

  function on(evt, fn) {
    if (!handlers[evt]) handlers[evt] = [];
    handlers[evt].push(fn);
  }

  function emit(evt, data) {
    const list = handlers[evt];
    if (!list) return;
    for (const fn of list) {
      try {
        fn(data);
      } catch (err) {
        console.error('[Net] erro no handler de ' + evt, err);
      }
    }
  }

  function connect() {
    if (socket) return;
    if (typeof io === 'undefined') {
      emit('status', false);
      return;
    }
    socket = io();

    socket.on('connect', () => emit('status', true));

    socket.on('disconnect', () => {
      const wasInRoom = inRoom;
      inRoom = false;
      myId = null;
      emit('status', false);
      if (wasInRoom) emit('kicked');
    });

    socket.on('state', (s) => {
      if (inRoom) emit('state', s);
    });

    socket.on('teleport', (t) => {
      seq = t.seq;
      emit('teleport', t);
    });

    socket.on('feed', (f) => {
      if (inRoom) emit('feed', f);
    });
  }

  // Pedido com resposta (ack) e limite de tempo
  function request(evt, payload) {
    return new Promise((resolve) => {
      if (!socket || !socket.connected) {
        resolve({ ok: false, error: 'Sem ligação ao servidor.' });
        return;
      }
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        resolve({ ok: false, error: 'O servidor não respondeu.' });
      }, 5000);

      const cb = (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(res || { ok: false, error: 'Resposta inválida do servidor.' });
      };

      if (payload === undefined) socket.emit(evt, cb);
      else socket.emit(evt, payload, cb);
    });
  }

  function handleJoin(res) {
    if (res && res.ok) {
      myId = res.id;
      seq = res.you.seq;
      inRoom = true;
    }
    return res;
  }

  async function listRooms() {
    return request('listRooms');
  }

  async function createRoom(opts) {
    return handleJoin(await request('createRoom', opts));
  }

  async function joinRoom(opts) {
    return handleJoin(await request('joinRoom', opts));
  }

  async function leaveRoom() {
    inRoom = false;
    myId = null;
    return request('leaveRoom');
  }

  // Envio contínuo da posição (mensagens "voláteis": podem perder-se sem problema)
  function sendMove(m) {
    if (!socket || !inRoom) return;
    socket.volatile.emit('move', m);
  }

  function sendTag() {
    if (!socket || !inRoom) return;
    socket.emit('tag');
  }

  function sendCosmetics(c) {
    if (!socket || !inRoom) return;
    socket.emit('cosmetics', c);
  }

  return {
    on,
    connect,
    listRooms,
    createRoom,
    joinRoom,
    leaveRoom,
    sendMove,
    sendTag,
    sendCosmetics,
    getId: () => myId,
    getSeq: () => seq,
    isConnected: () => !!(socket && socket.connected)
  };
})();
