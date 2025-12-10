const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

const app = express();
const server = http.createServer(app);

// ================== SOCKET.IO WITH CONNECTION STATE RECOVERY ==================
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5e6,

  // Ping settings optimized for unstable networks
  pingTimeout: 60000,      // Wait 60 seconds before considering connection dead
  pingInterval: 25000,     // Send ping every 25 seconds

  // Connection state recovery - helps restore state after temporary disconnection
  connectionStateRecovery: {
    maxDisconnectionDuration: 5 * 60 * 1000, // 5 minutes - longer for poor networks
    skipMiddlewares: true,
  },

  // Transport settings - polling first for reliability on poor networks
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  upgradeTimeout: 30000,   // 30 seconds to upgrade to websocket

  // HTTP long-polling settings
  httpCompression: true,

  // Compression settings (disable if causing memory issues)
  perMessageDeflate: false,

  // Allow EIO4 protocol
  allowEIO3: true
});

// ================== SECURITY ==================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "wss:", "ws:", "https:"],
      mediaSrc: ["'self'", "blob:"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false
}));

// Enable gzip compression for all responses
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  level: 6 // Balance between speed and compression ratio
}));

app.use(express.static('public', {
  maxAge: '1d', // Cache static files for 1 day
  etag: true
}));
app.use(express.json({ limit: '1mb' })); // Limit JSON body size

// ================== CONSTANTS ==================
const MAX_MESSAGES_PER_ROOM = 50;
const MAX_ROOMS = 1000;
const MAX_USERS_PER_ROOM = 50;

// ================== DATA STORES ==================
const rooms = new Map();
const messageStore = new Map();
const activeCalls = new Map();
const userSessions = new Map(); // Track user sessions for reconnection

// ================== HELPERS ==================
function getUsers(room) {
  if (!rooms.has(room)) return [];
  return Array.from(rooms.get(room).entries()).map(([id, data]) => ({
    socketId: id,
    username: data.username,
    online: data.online,
    lastSeen: data.lastSeen
  }));
}

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>&"']/g, (char) => {
    const entities = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
    return entities[char] || char;
  }).trim();
}

function generateId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 12);
}

function getTimestamp() {
  return new Date().toISOString();
}

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Clean up stale rooms periodically
setInterval(() => {
  const now = Date.now();
  for (const [roomCode, roomUsers] of rooms.entries()) {
    // Remove users who haven't been active for 5 minutes
    for (const [socketId, userData] of roomUsers.entries()) {
      if (!userData.online && now - userData.lastSeen > 5 * 60 * 1000) {
        roomUsers.delete(socketId);
      }
    }
    // Remove empty rooms
    if (roomUsers.size === 0) {
      rooms.delete(roomCode);
      messageStore.delete(roomCode);
      console.log(`🗑️ Room ${roomCode} cleaned up (stale)`);
    }
  }
}, 60000); // Run every minute

// ================== SOCKET HANDLER ==================
io.on('connection', (socket) => {
  console.log('✅ Connected:', socket.id, '| Recovered:', socket.recovered);

  // Send socket ID to client
  socket.emit('yourSocketId', socket.id);

  // Handle recovered connections
  if (socket.recovered) {
    console.log('🔄 Session recovered for:', socket.id);
    // The socket.rooms and socket.data were restored
    if (socket.data.roomCode && socket.data.username) {
      socket.username = socket.data.username;
      socket.roomCode = socket.data.roomCode;

      // Update user status
      const roomUsers = rooms.get(socket.roomCode);
      if (roomUsers) {
        const userData = roomUsers.get(socket.id);
        if (userData) {
          userData.online = true;
          userData.lastSeen = Date.now();
        }
        io.to(socket.roomCode).emit('userList', getUsers(socket.roomCode));
      }
    }
  }

  // ============ JOIN ROOM ============
  socket.on('join', ({ username, roomCode, sessionId }) => {
    try {
      if (!username || !roomCode) {
        return socket.emit('error', { type: 'validation', message: 'Username and room code required' });
      }

      const name = sanitize(username).slice(0, 20);
      const room = sanitize(roomCode).toLowerCase().slice(0, 30);

      if (!name || !room) {
        return socket.emit('error', { type: 'validation', message: 'Invalid username or room code' });
      }

      // Initialize room if needed
      if (!rooms.has(room)) {
        rooms.set(room, new Map());
        messageStore.set(room, []);
      }

      const roomUsers = rooms.get(room);

      // Check for duplicate username (except for reconnecting users)
      for (let [id, u] of roomUsers) {
        if (u.username.toLowerCase() === name.toLowerCase() && id !== socket.id) {
          // Check if it's a reconnection attempt
          if (sessionId && u.sessionId === sessionId) {
            // Allow reconnection - remove old entry
            roomUsers.delete(id);
            break;
          } else if (u.online) {
            return socket.emit('error', { type: 'duplicate', message: 'Username already taken' });
          } else {
            // User was offline, remove old entry
            roomUsers.delete(id);
            break;
          }
        }
      }

      // Generate session ID for reconnection tracking
      const userSessionId = sessionId || generateId();

      socket.username = name;
      socket.roomCode = room;
      socket.data.username = name;
      socket.data.roomCode = room;
      socket.data.sessionId = userSessionId;

      socket.join(room);

      roomUsers.set(socket.id, {
        username: name,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
        online: true,
        sessionId: userSessionId
      });

      console.log(`👤 ${name} joined room: ${room} (${roomUsers.size} users)`);

      // Send success with session ID for reconnection
      socket.emit('joinSuccess', {
        room,
        username: name,
        socketId: socket.id,
        sessionId: userSessionId
      });

      // Get recent messages for the new user
      const recentMessages = messageStore.get(room) || [];
      if (recentMessages.length > 0) {
        socket.emit('messageHistory', recentMessages.slice(-50).map(m => m.data));
      }

      socket.to(room).emit('userJoined', { username: name, socketId: socket.id });
      io.to(room).emit('userList', getUsers(room));

    } catch (err) {
      console.error('Join error:', err);
      socket.emit('error', { type: 'server', message: 'Failed to join room' });
    }
  });

  // ============ TEXT MESSAGE ============
  socket.on('message', (text, callback) => {
    try {
      if (!socket.roomCode || !socket.username) {
        if (callback) callback({ status: 'error', message: 'Not in a room' });
        return;
      }
      if (!text || typeof text !== 'string') {
        if (callback) callback({ status: 'error', message: 'Invalid message' });
        return;
      }

      const safeText = sanitize(text).slice(0, 5000);
      if (!safeText) {
        if (callback) callback({ status: 'error', message: 'Empty message' });
        return;
      }

      const msgId = generateId();
      const timestamp = getTimestamp();

      const msgData = {
        id: msgId,
        type: 'text',
        username: socket.username,
        senderId: socket.id,
        text: safeText,
        timestamp: timestamp
      };

      const roomMsgs = messageStore.get(socket.roomCode);
      if (roomMsgs) {
        roomMsgs.push({
          id: msgId,
          senderId: socket.id,
          seenBy: new Set([socket.id]),
          data: msgData,
          createdAt: Date.now()
        });
        // Keep only last 50 messages
        while (roomMsgs.length > MAX_MESSAGES_PER_ROOM) {
          roomMsgs.shift();
        }
      }

      console.log(`💬 ${socket.username}: ${safeText.slice(0, 50)}`);
      io.to(socket.roomCode).emit('message', msgData);

      // Acknowledge message sent
      if (callback) callback({ status: 'ok', messageId: msgId });

    } catch (err) {
      console.error('Message error:', err);
      if (callback) callback({ status: 'error', message: 'Failed to send message' });
    }
  });

  // ============ IMAGE MESSAGE ============
  socket.on('imageMessage', (imageData, callback) => {
    try {
      if (!socket.roomCode || !socket.username) {
        if (callback) callback({ status: 'error', message: 'Not in a room' });
        return;
      }
      if (!imageData || typeof imageData !== 'string') {
        if (callback) callback({ status: 'error', message: 'Invalid image data' });
        return;
      }
      if (!imageData.startsWith('data:image/')) {
        if (callback) callback({ status: 'error', message: 'Invalid image format' });
        return;
      }
      if (imageData.length > 4000000) {
        if (callback) callback({ status: 'error', message: 'Image too large (max 3MB)' });
        socket.emit('error', { type: 'size', message: 'Image too large (max 3MB)' });
        return;
      }

      const msgId = generateId();
      const timestamp = getTimestamp();

      const msgData = {
        id: msgId,
        type: 'image',
        username: socket.username,
        senderId: socket.id,
        imageData: imageData,
        timestamp: timestamp
      };

      const roomMsgs = messageStore.get(socket.roomCode);
      if (roomMsgs) {
        roomMsgs.push({
          id: msgId,
          senderId: socket.id,
          seenBy: new Set([socket.id]),
          data: { ...msgData, imageData: '[IMAGE]' }, // Don't store full image in history
          createdAt: Date.now()
        });
        // Keep only last 50 messages
        while (roomMsgs.length > MAX_MESSAGES_PER_ROOM) {
          roomMsgs.shift();
        }
      }

      console.log(`🖼️ ${socket.username} sent image`);
      io.to(socket.roomCode).emit('message', msgData);

      if (callback) callback({ status: 'ok', messageId: msgId });

    } catch (err) {
      console.error('Image error:', err);
      if (callback) callback({ status: 'error', message: 'Failed to send image' });
    }
  });

  // ============ READ RECEIPTS ============
  socket.on('markSeen', (messageIds) => {
    try {
      if (!socket.roomCode || !socket.username) return;
      if (!Array.isArray(messageIds)) return;

      const roomMsgs = messageStore.get(socket.roomCode);
      if (!roomMsgs) return;

      const seenMessages = [];

      messageIds.forEach(msgId => {
        if (typeof msgId !== 'string') return;

        const msg = roomMsgs.find(m => m.id === msgId);
        if (msg && msg.senderId !== socket.id && !msg.seenBy.has(socket.id)) {
          msg.seenBy.add(socket.id);
          seenMessages.push({
            messageId: msgId,
            senderId: msg.senderId
          });
        }
      });

      // Batch notify senders
      seenMessages.forEach(({ messageId, senderId }) => {
        io.to(senderId).emit('messageSeen', {
          messageId: messageId,
          seenBy: socket.username,
          seenById: socket.id
        });
      });

    } catch (err) {
      console.error('MarkSeen error:', err);
    }
  });

  // ============ TYPING INDICATORS ============
  let typingThrottle = null;

  socket.on('typing', () => {
    if (socket.roomCode && socket.username && !typingThrottle) {
      socket.to(socket.roomCode).emit('typing', {
        username: socket.username,
        socketId: socket.id
      });
      typingThrottle = setTimeout(() => { typingThrottle = null; }, 1000);
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
      if (!targetId || !offer) {
        socket.emit('callError', { message: 'Invalid call request' });
        return;
      }

      // Check if target is in a call
      if (activeCalls.has(targetId)) {
        socket.emit('callError', { message: 'User is busy' });
        return;
      }

      console.log(`📞 ${socket.username} calling ${targetId}`);

      activeCalls.set(socket.id, { target: targetId, status: 'calling', startTime: Date.now() });
      activeCalls.set(targetId, { target: socket.id, status: 'ringing', startTime: Date.now() });

      io.to(targetId).emit('incomingCall', {
        callerId: socket.id,
        callerName: callerName || socket.username,
        offer: offer
      });

      // Auto-cancel call after 60 seconds if not answered
      setTimeout(() => {
        const call = activeCalls.get(socket.id);
        if (call && call.status === 'calling') {
          socket.emit('callTimeout', { targetId });
          io.to(targetId).emit('callCancelled', { callerId: socket.id });
          activeCalls.delete(socket.id);
          activeCalls.delete(targetId);
        }
      }, 60000);

    } catch (err) {
      console.error('CallUser error:', err);
      socket.emit('callError', { message: 'Failed to initiate call' });
    }
  });

  socket.on('answerCall', ({ targetId, answer }) => {
    try {
      if (!targetId || !answer) return;

      console.log(`✅ ${socket.username} answered call`);

      // Update call status
      const myCall = activeCalls.get(socket.id);
      const theirCall = activeCalls.get(targetId);
      if (myCall) myCall.status = 'connected';
      if (theirCall) theirCall.status = 'connected';

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

  // ============ RECONNECTION HANDLER ============
  socket.on('rejoin', ({ sessionId, roomCode, username }) => {
    try {
      if (!sessionId || !roomCode || !username) return;

      const room = rooms.get(roomCode);
      if (!room) return;

      // Find user by session ID
      for (const [oldSocketId, userData] of room.entries()) {
        if (userData.sessionId === sessionId && userData.username === username) {
          // Transfer user data to new socket
          room.delete(oldSocketId);
          room.set(socket.id, {
            ...userData,
            online: true,
            lastSeen: Date.now()
          });

          socket.username = username;
          socket.roomCode = roomCode;
          socket.data.username = username;
          socket.data.roomCode = roomCode;
          socket.data.sessionId = sessionId;

          socket.join(roomCode);

          socket.emit('rejoinSuccess', {
            room: roomCode,
            username,
            socketId: socket.id,
            sessionId
          });

          io.to(roomCode).emit('userList', getUsers(roomCode));
          console.log(`🔄 ${username} rejoined room: ${roomCode}`);
          return;
        }
      }

      socket.emit('rejoinFailed', { message: 'Session expired' });

    } catch (err) {
      console.error('Rejoin error:', err);
      socket.emit('rejoinFailed', { message: 'Failed to rejoin' });
    }
  });

  // ============ HEARTBEAT ============
  socket.on('heartbeat', () => {
    if (socket.roomCode && rooms.has(socket.roomCode)) {
      const roomUsers = rooms.get(socket.roomCode);
      const userData = roomUsers.get(socket.id);
      if (userData) {
        userData.lastSeen = Date.now();
        userData.online = true;
      }
    }
    socket.emit('heartbeat_ack');
  });

  // ============ DISCONNECT ============
  socket.on('disconnect', (reason) => {
    console.log('❌ Disconnected:', socket.username || socket.id, '| Reason:', reason);

    try {
      // Handle active calls
      const callPartner = activeCalls.get(socket.id);
      if (callPartner) {
        io.to(callPartner.target).emit('callEnded', {
          from: socket.id,
          username: socket.username,
          reason: 'disconnected'
        });
        activeCalls.delete(callPartner.target);
        activeCalls.delete(socket.id);
      }

      // Stop typing indicator
      if (socket.roomCode) {
        socket.to(socket.roomCode).emit('stopTyping', {
          username: socket.username,
          socketId: socket.id
        });
      }

      // Update room status
      if (socket.roomCode && rooms.has(socket.roomCode)) {
        const roomUsers = rooms.get(socket.roomCode);
        const userData = roomUsers.get(socket.id);

        if (userData) {
          // Mark as offline instead of removing immediately (for reconnection)
          userData.online = false;
          userData.lastSeen = Date.now();

          // Notify others
          socket.to(socket.roomCode).emit('userOffline', {
            username: socket.username,
            socketId: socket.id
          });
          io.to(socket.roomCode).emit('userList', getUsers(socket.roomCode));
        }

        // Clean up empty rooms after a delay
        setTimeout(() => {
          if (rooms.has(socket.roomCode)) {
            const currentUsers = rooms.get(socket.roomCode);
            let hasOnlineUsers = false;
            for (const [, user] of currentUsers) {
              if (user.online) {
                hasOnlineUsers = true;
                break;
              }
            }
            if (!hasOnlineUsers) {
              rooms.delete(socket.roomCode);
              messageStore.delete(socket.roomCode);
              console.log(`🗑️ Room ${socket.roomCode} deleted (all users offline)`);
            }
          }
        }, 5 * 60 * 1000); // 5 minute delay
      }

    } catch (err) {
      console.error('Disconnect error:', err);
    }
  });
});

// ================== HEALTH CHECK ==================
app.get('/health', (req, res) => {
  const roomCount = rooms.size;
  let totalUsers = 0;
  let onlineUsers = 0;
  let totalMessages = 0;

  for (const [, roomUsers] of rooms) {
    for (const [, user] of roomUsers) {
      totalUsers++;
      if (user.online) onlineUsers++;
    }
  }

  for (const [, messages] of messageStore) {
    totalMessages += messages.length;
  }

  const memUsage = process.memoryUsage();

  res.json({
    status: 'ok',
    version: '2.2.0',
    rooms: roomCount,
    maxRooms: MAX_ROOMS,
    totalUsers,
    onlineUsers,
    maxUsersPerRoom: MAX_USERS_PER_ROOM,
    activeCalls: Math.floor(activeCalls.size / 2),
    totalMessages,
    maxMessagesPerRoom: MAX_MESSAGES_PER_ROOM,
    uptime: Math.floor(process.uptime()),
    uptimeFormatted: formatUptime(process.uptime()),
    memory: {
      heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB'
    },
    timestamp: new Date().toISOString()
  });
});

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

// Lightweight ping for keep-alive
app.get('/ping', (req, res) => {
  res.send('pong');
});

// ================== ICE SERVERS ENDPOINT ==================
app.get('/api/ice-servers', (req, res) => {
  // Return ICE server configuration
  // In production, you might want to generate time-limited credentials
  res.json({
    iceServers: [
      // Google STUN servers (reliable)
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      // Other free STUN servers
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'stun:stun.framasoft.org:3478' },
      // Free TURN servers (for NAT traversal)
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      // Additional free TURN servers for redundancy
      {
        urls: 'turn:relay.metered.ca:80',
        username: 'e8dd65f92c95c6bf4bf1',
        credential: 'DQpDQkhS3f/L4bsi'
      },
      {
        urls: 'turn:relay.metered.ca:443',
        username: 'e8dd65f92c95c6bf4bf1',
        credential: 'DQpDQkhS3f/L4bsi'
      }
    ]
  });
});

// ================== ERROR HANDLING ==================
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ================== KEEP ALIVE (RENDER) ==================
// Prevent Render free tier from sleeping by pinging itself
const keepAlive = () => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const interval = 10 * 60 * 1000; // 10 minutes (Render sleeps after 15)

  console.log(`⏰ Keep-alive set up for: ${url}`);

  // Periodic self-ping
  setInterval(() => {
    http.get(`${url}/ping`, (res) => {
      if (res.statusCode === 200) {
        // console.log('⚡ Keep-alive ping successful');
      } else {
        console.error(`⚠️ Keep-alive ping failed: ${res.statusCode}`);
      }
    }).on('error', (err) => {
      console.error('⚠️ Keep-alive ping error:', err.message);
    });
  }, interval);
};

// ================== GRACEFUL SHUTDOWN ==================
const gracefulShutdown = (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    console.log('✅ HTTP server closed');

    // Close all socket connections
    io.close(() => {
      console.log('✅ Socket.IO connections closed');
      console.log('👋 Graceful shutdown complete');
      process.exit(0);
    });
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('⚠️ Forcing shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ================== START SERVER ==================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`💾 Memory: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);

  // Start keep-alive
  keepAlive();
});
