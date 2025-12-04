const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 5e6,
  pingTimeout: 60000,
  pingInterval: 25000
});

// ================== SECURITY ==================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:"],
      mediaSrc: ["'self'", "blob:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500
}));

app.use(express.static('public'));

// ================== DATA STORES ==================
const rooms = new Map();
const messageStore = new Map();
const activeCalls = new Map();

// ================== HELPERS ==================
function getUsers(room) {
  if (!rooms.has(room)) return [];
  return Array.from(rooms.get(room).entries()).map(([id, data]) => ({
    socketId: id,
    username: data.username
  }));
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim();
}

function generateId() {
  return Date.now() + '-' + Math.random().toString(36).substr(2, 9);
}

function getTimestamp() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ================== SOCKET HANDLER ==================
io.on('connection', (socket) => {
  console.log('✅ Connected:', socket.id);
  socket.emit('yourSocketId', socket.id);

  // ============ JOIN ROOM ============
  socket.on('join', ({ username, roomCode }) => {
    try {
      if (!username || !roomCode) {
        return socket.emit('error', 'Username and room code required');
      }

      const name = sanitize(username).slice(0, 20);
      const room = sanitize(roomCode).toLowerCase().slice(0, 30);

      if (!name || !room) {
        return socket.emit('error', 'Invalid username or room code');
      }

      if (!rooms.has(room)) {
        rooms.set(room, new Map());
        messageStore.set(room, []);
      }

      const roomUsers = rooms.get(room);

      for (let [, u] of roomUsers) {
        if (u.username.toLowerCase() === name.toLowerCase()) {
          return socket.emit('error', 'Username already taken');
        }
      }

      socket.username = name;
      socket.roomCode = room;
      socket.join(room);
      roomUsers.set(socket.id, { username: name, joinedAt: Date.now() });

      console.log(`👤 ${name} joined room: ${room} (${roomUsers.size} users)`);

      socket.emit('joinSuccess', { room, username: name, socketId: socket.id });
      socket.to(room).emit('userJoined', { username: name, socketId: socket.id });
      io.to(room).emit('userList', getUsers(room));

    } catch (err) {
      console.error('Join error:', err);
      socket.emit('error', 'Failed to join room');
    }
  });

  // ============ TEXT MESSAGE ============
  socket.on('message', (text) => {
    try {
      if (!socket.roomCode || !socket.username) return;
      if (!text || typeof text !== 'string') return;

      const safeText = sanitize(text).slice(0, 1000);
      if (!safeText) return;

      const msgId = generateId();

      const msgData = {
        id: msgId,
        type: 'text',
        username: socket.username,
        senderId: socket.id,
        text: safeText,
        timestamp: getTimestamp()
      };

      const roomMsgs = messageStore.get(socket.roomCode);
      if (roomMsgs) {
        roomMsgs.push({
          id: msgId,
          senderId: socket.id,
          seenBy: new Set([socket.id])
        });
        if (roomMsgs.length > 100) roomMsgs.shift();
      }

      console.log(`💬 ${socket.username}: ${safeText.slice(0, 50)}`);
      io.to(socket.roomCode).emit('message', msgData);

    } catch (err) {
      console.error('Message error:', err);
    }
  });

  // ============ IMAGE MESSAGE ============
  socket.on('imageMessage', (imageData) => {
    try {
      if (!socket.roomCode || !socket.username) return;
      if (!imageData || typeof imageData !== 'string') return;
      if (!imageData.startsWith('data:image/')) return;
      if (imageData.length > 4000000) {
        socket.emit('error', 'Image too large (max 3MB)');
        return;
      }

      const msgId = generateId();

      const msgData = {
        id: msgId,
        type: 'image',
        username: socket.username,
        senderId: socket.id,
        imageData: imageData,
        timestamp: getTimestamp()
      };

      const roomMsgs = messageStore.get(socket.roomCode);
      if (roomMsgs) {
        roomMsgs.push({
          id: msgId,
          senderId: socket.id,
          seenBy: new Set([socket.id])
        });
        if (roomMsgs.length > 100) roomMsgs.shift();
      }

      console.log(`🖼️ ${socket.username} sent image`);
      io.to(socket.roomCode).emit('message', msgData);

    } catch (err) {
      console.error('Image error:', err);
    }
  });

  // ============ READ RECEIPTS ============
  socket.on('markSeen', (messageIds) => {
    try {
      if (!socket.roomCode || !socket.username) return;
      if (!Array.isArray(messageIds)) return;

      const roomMsgs = messageStore.get(socket.roomCode);
      if (!roomMsgs) return;

      messageIds.forEach(msgId => {
        if (typeof msgId !== 'string') return;

        const msg = roomMsgs.find(m => m.id === msgId);
        if (msg && msg.senderId !== socket.id && !msg.seenBy.has(socket.id)) {
          msg.seenBy.add(socket.id);

          io.to(msg.senderId).emit('messageSeen', {
            messageId: msgId,
            seenBy: socket.username,
            seenById: socket.id
          });

          console.log(`👁️ ${socket.username} saw msg ${msgId.slice(0, 10)}...`);
        }
      });

    } catch (err) {
      console.error('MarkSeen error:', err);
    }
  });

  // ============ TYPING INDICATORS ============
  socket.on('typing', () => {
    if (socket.roomCode && socket.username) {
      socket.to(socket.roomCode).emit('typing', {
        username: socket.username,
        socketId: socket.id
      });
    }
  });

  socket.on('stopTyping', () => {
    if (socket.roomCode && socket.username) {
      socket.to(socket.roomCode).emit('stopTyping', {
        username: socket.username,
        socketId: socket.id
      });
    }
  });

  // ============ WEBRTC AUDIO CALL ============

  socket.on('callUser', ({ targetId, offer, callerName }) => {
    try {
      if (!targetId || !offer) return;

      console.log(`📞 ${socket.username} calling ${targetId}`);

      activeCalls.set(socket.id, targetId);
      activeCalls.set(targetId, socket.id);

      io.to(targetId).emit('incomingCall', {
        callerId: socket.id,
        callerName: callerName || socket.username,
        offer: offer
      });

    } catch (err) {
      console.error('CallUser error:', err);
    }
  });

  socket.on('answerCall', ({ targetId, answer }) => {
    try {
      if (!targetId || !answer) return;

      console.log(`✅ ${socket.username} answered call`);

      io.to(targetId).emit('callAnswered', {
        answererId: socket.id,
        answer: answer
      });

    } catch (err) {
      console.error('AnswerCall error:', err);
    }
  });

  socket.on('iceCandidate', ({ targetId, candidate }) => {
    try {
      if (!targetId || !candidate) return;

      io.to(targetId).emit('iceCandidate', {
        candidate: candidate,
        from: socket.id
      });

    } catch (err) {
      console.error('ICE error:', err);
    }
  });

  socket.on('rejectCall', ({ targetId }) => {
    try {
      if (!targetId) return;

      console.log(`❌ ${socket.username} rejected call`);

      activeCalls.delete(socket.id);
      activeCalls.delete(targetId);

      io.to(targetId).emit('callRejected', {
        from: socket.id,
        username: socket.username
      });

    } catch (err) {
      console.error('RejectCall error:', err);
    }
  });

  socket.on('endCall', ({ targetId }) => {
    try {
      if (!targetId) return;

      console.log(`📵 ${socket.username} ended call`);

      activeCalls.delete(socket.id);
      activeCalls.delete(targetId);

      io.to(targetId).emit('callEnded', {
        from: socket.id,
        username: socket.username
      });

    } catch (err) {
      console.error('EndCall error:', err);
    }
  });

  // ============ DISCONNECT ============
  socket.on('disconnect', () => {
    console.log('❌ Disconnected:', socket.username || socket.id);

    try {
      const callPartner = activeCalls.get(socket.id);
      if (callPartner) {
        io.to(callPartner).emit('callEnded', {
          from: socket.id,
          username: socket.username
        });
        activeCalls.delete(callPartner);
        activeCalls.delete(socket.id);
      }

      if (socket.roomCode) {
        socket.to(socket.roomCode).emit('stopTyping', {
          username: socket.username,
          socketId: socket.id
        });
      }

      if (socket.roomCode && rooms.has(socket.roomCode)) {
        const roomUsers = rooms.get(socket.roomCode);
        roomUsers.delete(socket.id);

        if (roomUsers.size === 0) {
          rooms.delete(socket.roomCode);
          messageStore.delete(socket.roomCode);
          console.log(`🗑️ Room ${socket.roomCode} deleted (empty)`);
        } else {
          socket.to(socket.roomCode).emit('userLeft', {
            username: socket.username,
            socketId: socket.id
          });
          io.to(socket.roomCode).emit('userList', getUsers(socket.roomCode));
        }
      }

    } catch (err) {
      console.error('Disconnect error:', err);
    }
  });
});

// ================== HEALTH CHECK ==================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    activeCalls: activeCalls.size / 2,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});