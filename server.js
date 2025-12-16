require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { MongoClient } = require('mongodb');

// ================== MONGODB CONFIGURATION ==================
const MONGODB_URI = process.env.MONGODB_URI;
const SPECIAL_ROOM = process.env.SPECIAL_ROOM || 'june28';
let mongoClient = null;
let mongoDb = null;
let mongoConnected = false;

// Connect to MongoDB
async function connectMongoDB() {
  if (!MONGODB_URI) {
    console.log('⚠️ MongoDB URI not configured - special room will use JSON storage');
    return;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    mongoDb = mongoClient.db('privatechat');
    mongoConnected = true;
    console.log(`✅ MongoDB connected for room "${SPECIAL_ROOM}"`);

    // Create index for efficient queries
    await mongoDb.collection('messages').createIndex({ roomCode: 1, timestamp: 1 });
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    mongoConnected = false;
  }
}

// Get messages from MongoDB (for special room only)
async function getMessagesFromMongoDB(roomCode, limit = 50) {
  if (!mongoConnected || !usesMongoDB(roomCode)) return null;

  // Use normalized room code for query
  const normalizedRoom = normalizeRoomCode(roomCode);

  try {
    const messages = await mongoDb.collection('messages')
      .find({ roomCode: normalizedRoom })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray();

    console.log(`📂 MongoDB query for room "${normalizedRoom}" returned ${messages.length} messages`);

    // Convert to app format and reverse to chronological order
    return messages.reverse().map(msg => ({
      ...msg,
      seenBy: new Set(msg.seenBy || []),
      timestamp: msg.timestamp instanceof Date ? msg.timestamp.toISOString() : msg.timestamp
    }));
  } catch (err) {
    console.error('MongoDB load error:', err.message);
    return null;
  }
}

// Normalize room code for comparison (remove spaces, lowercase)
function normalizeRoomCode(roomCode) {
  if (!roomCode) return '';
  return roomCode.toLowerCase().replace(/\s+/g, '');
}

// Check if room uses MongoDB
function usesMongoDB(roomCode) {
  const normalizedInput = normalizeRoomCode(roomCode);
  const normalizedSpecial = normalizeRoomCode(SPECIAL_ROOM);
  return mongoConnected && normalizedInput === normalizedSpecial;
}

// Save message to MongoDB (for special room only)
async function saveMessageToMongoDB(roomCode, message) {
  if (!mongoConnected) return false;
  if (!usesMongoDB(roomCode)) return false;

  // Use normalized room code for storage
  const normalizedRoom = normalizeRoomCode(roomCode);

  try {
    await mongoDb.collection('messages').insertOne({
      roomCode: normalizedRoom,
      ...message,
      // Ensure specific fields are saved correctly
      seenBy: Array.from(message.seenBy || []),
      timestamp: new Date(message.timestamp)
    });
    // console.log(`✅ Message saved to MongoDB for room "${normalizedRoom}"`);
    return true;
  } catch (err) {
    console.error('❌ MongoDB save error:', err.message);
    return false;
  }
}

// ================== USER LAST SEEN PERSISTENCE (SPECIAL ROOM) ==================
// Save/update user last seen to MongoDB
async function saveUserLastSeenToMongoDB(roomCode, username, lastSeen, online = false) {
  if (!mongoConnected || !usesMongoDB(roomCode)) return false;

  const normalizedRoom = normalizeRoomCode(roomCode);
  const normalizedUsername = username.toLowerCase();

  try {
    await mongoDb.collection('users').updateOne(
      { roomCode: normalizedRoom, usernameKey: normalizedUsername },
      {
        $set: {
          roomCode: normalizedRoom,
          usernameKey: normalizedUsername,
          username: username,
          lastSeen: new Date(lastSeen),
          online: online,
          updatedAt: new Date()
        }
      },
      { upsert: true }
    );
    return true;
  } catch (err) {
    console.error('❌ MongoDB user save error:', err.message);
    return false;
  }
}

// Get all users with last seen info from MongoDB (for special room)
async function getUsersFromMongoDB(roomCode) {
  if (!mongoConnected || !usesMongoDB(roomCode)) return [];

  const normalizedRoom = normalizeRoomCode(roomCode);

  try {
    const users = await mongoDb.collection('users')
      .find({ roomCode: normalizedRoom })
      .sort({ lastSeen: -1 })
      .toArray();

    return users.map(u => ({
      username: u.username,
      lastSeen: u.lastSeen instanceof Date ? u.lastSeen.getTime() : u.lastSeen,
      online: false, // MongoDB users are historical, not currently online
      fromMongoDB: true
    }));
  } catch (err) {
    console.error('MongoDB users load error:', err.message);
    return [];
  }
}

// Create index for users collection
async function createUserIndex() {
  if (!mongoConnected) return;
  try {
    await mongoDb.collection('users').createIndex(
      { roomCode: 1, usernameKey: 1 },
      { unique: true }
    );
    console.log('✅ MongoDB users index created');
  } catch (err) {
    // Index might already exist
    if (!err.message.includes('already exists')) {
      console.error('MongoDB users index error:', err.message);
    }
  }
}

// Initialize MongoDB connection
connectMongoDB().then(() => {
  createUserIndex();
});

const app = express();
const server = http.createServer(app);

// ================== SOCKET.IO WITH CONNECTION STATE RECOVERY ==================
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 5e6,

  // Ping settings optimized for slow/unstable networks
  pingTimeout: 120000,     // Wait 120 seconds before considering connection dead (slow networks need more time)
  pingInterval: 10000,     // Send ping every 10 seconds for faster detection

  // Connection state recovery - helps restore state after temporary disconnection
  connectionStateRecovery: {
    maxDisconnectionDuration: 10 * 60 * 1000, // 10 minutes - longer for poor networks
    skipMiddlewares: true,
  },

  // Transport settings - polling first for reliability on poor networks
  transports: ['polling', 'websocket'],
  allowUpgrades: true,
  upgradeTimeout: 60000,   // 60 seconds to upgrade to websocket (slow networks need more time)

  // HTTP long-polling settings for better slow network support
  httpCompression: true,

  // Compression settings
  perMessageDeflate: false,

  // Allow older protocol for compatibility
  allowEIO3: true,

  // Additional slow network optimizations
  connectTimeout: 45000,   // 45 seconds to establish initial connection
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

// ================== MESSAGE PERSISTENCE ==================
const MESSAGES_FILE = path.join(__dirname, 'messages.json');

// Save messages to file
function saveMessages() {
  try {
    const data = {};
    for (const [room, messages] of messageStore.entries()) {
      // Convert Set to Array for JSON serialization
      data[room] = messages.map(msg => ({
        ...msg,
        seenBy: Array.from(msg.seenBy || [])
      }));
    }
    fs.writeFileSync(MESSAGES_FILE, JSON.stringify(data, null, 2));
    console.log(`💾 Messages saved (${Object.keys(data).length} rooms)`);
  } catch (err) {
    console.error('Failed to save messages:', err.message);
  }
}

// Load messages from file
function loadMessages() {
  try {
    if (fs.existsSync(MESSAGES_FILE)) {
      const data = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
      for (const [room, messages] of Object.entries(data)) {
        // Convert Array back to Set for seenBy
        const restoredMessages = messages.map(msg => ({
          ...msg,
          seenBy: new Set(msg.seenBy || [])
        }));
        messageStore.set(room, restoredMessages);
      }
      console.log(`📂 Messages loaded (${Object.keys(data).length} rooms)`);
    }
  } catch (err) {
    console.error('Failed to load messages:', err.message);
  }
}

// Load messages on startup
loadMessages();

// Auto-save messages every 30 seconds
setInterval(saveMessages, 30000);

// NOTE: Signal handlers (SIGINT/SIGTERM) are defined at the bottom of the file
// in the graceful shutdown section


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

// Enhanced getUsers that includes MongoDB stored users for special room
async function getUsersWithHistory(room) {
  const currentUsers = getUsers(room);

  // For special room, merge with historical users from MongoDB
  if (usesMongoDB(room)) {
    const mongoUsers = await getUsersFromMongoDB(room);

    // Create a map of current users by lowercase username
    const currentUsernames = new Set(
      currentUsers.map(u => u.username.toLowerCase())
    );

    // Add MongoDB users that are not currently online
    mongoUsers.forEach(mongoUser => {
      if (!currentUsernames.has(mongoUser.username.toLowerCase())) {
        currentUsers.push({
          socketId: null,
          username: mongoUser.username,
          online: false,
          lastSeen: mongoUser.lastSeen
        });
      }
    });
  }

  return currentUsers;
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


// Clean up stale rooms periodically (but preserve messages!)
setInterval(() => {
  const now = Date.now();
  for (const [roomCode, roomUsers] of rooms.entries()) {
    // Remove users who haven't been active for 5 minutes
    for (const [socketId, userData] of roomUsers.entries()) {
      if (!userData.online && now - userData.lastSeen > 5 * 60 * 1000) {
        roomUsers.delete(socketId);
      }
    }
    // Remove empty room user lists (but keep messages for when users rejoin!)
    if (roomUsers.size === 0) {
      rooms.delete(roomCode);
      // DO NOT delete messages - they are persisted and will be loaded when someone rejoins
      console.log(`🗑️ Room ${roomCode} user list cleaned up (messages preserved)`);
      saveMessages(); // Save before cleanup
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
        // Emit enhanced user list for special room
        if (usesMongoDB(socket.roomCode)) {
          saveUserLastSeenToMongoDB(socket.roomCode, socket.username, Date.now(), true);
          getUsersWithHistory(socket.roomCode).then(users => {
            io.to(socket.roomCode).emit('userList', users);
          });
        } else {
          io.to(socket.roomCode).emit('userList', getUsers(socket.roomCode));
        }
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
        // Check if messages exist from a previous session (persisted in file)
        // If not already in memory, try to load from file
        if (!messageStore.has(room)) {
          // Try to load messages from file for this room
          try {
            if (fs.existsSync(MESSAGES_FILE)) {
              const data = JSON.parse(fs.readFileSync(MESSAGES_FILE, 'utf8'));
              if (data[room] && Array.isArray(data[room])) {
                const restoredMessages = data[room].map(msg => ({
                  ...msg,
                  seenBy: new Set(msg.seenBy || [])
                }));
                messageStore.set(room, restoredMessages);
                console.log(`📂 Loaded ${restoredMessages.length} messages for room: ${room}`);
              } else {
                messageStore.set(room, []);
              }
            } else {
              messageStore.set(room, []);
            }
          } catch (err) {
            console.error('Failed to load messages for room:', room, err.message);
            messageStore.set(room, []);
          }
        }
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
      // For the special room, load from MongoDB if available
      if (usesMongoDB(room)) {
        getMessagesFromMongoDB(room, 50).then(mongoMessages => {
          if (mongoMessages && mongoMessages.length > 0) {
            console.log(`📂 Loaded ${mongoMessages.length} messages from MongoDB for room: ${room}`);
            socket.emit('messageHistory', mongoMessages.map(m => ({
              id: m.id,
              type: m.type,
              username: m.username,
              senderId: m.senderId,
              text: m.text,
              imageData: m.imageData,
              timestamp: m.timestamp
            })));
          }
        }).catch(err => {
          console.error('MongoDB load error:', err.message);
          // Fallback to in-memory messages
          const recentMessages = messageStore.get(room) || [];
          if (recentMessages.length > 0) {
            socket.emit('messageHistory', recentMessages.slice(-50).map(m => m.data));
          }
        });
      } else {
        const recentMessages = messageStore.get(room) || [];
        if (recentMessages.length > 0) {
          socket.emit('messageHistory', recentMessages.slice(-50).map(m => m.data));
        }
      }

      socket.to(room).emit('userJoined', { username: name, socketId: socket.id });

      // For special room, save user info to MongoDB and emit enhanced user list
      if (usesMongoDB(room)) {
        saveUserLastSeenToMongoDB(room, name, Date.now(), true);
        getUsersWithHistory(room).then(users => {
          io.to(room).emit('userList', users);
        });
      } else {
        io.to(room).emit('userList', getUsers(room));
      }

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

      // Save to MongoDB if this is the special room
      if (usesMongoDB(socket.roomCode)) {
        saveMessageToMongoDB(socket.roomCode, {
          id: msgId,
          type: 'text',
          username: socket.username,
          senderId: socket.id,
          text: safeText,
          timestamp: timestamp,
          seenBy: new Set([socket.id])
        });
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

      // Save to MongoDB if this is the special room (store image reference, not full data)
      if (usesMongoDB(socket.roomCode)) {
        saveMessageToMongoDB(socket.roomCode, {
          id: msgId,
          type: 'image',
          username: socket.username,
          senderId: socket.id,
          imageData: imageData, // Store full image in MongoDB
          timestamp: timestamp,
          seenBy: new Set([socket.id])
        });
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

  // ============ WEBRTC AUDIO/VIDEO CALL ============
  socket.on('callUser', ({ targetId, offer, callerName, isVideo }) => {
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

      console.log(`${isVideo ? '📹' : '📞'} ${socket.username} calling ${targetId} (${isVideo ? 'video' : 'audio'})`);

      activeCalls.set(socket.id, { target: targetId, status: 'calling', startTime: Date.now(), isVideo });
      activeCalls.set(targetId, { target: socket.id, status: 'ringing', startTime: Date.now(), isVideo });

      io.to(targetId).emit('incomingCall', {
        callerId: socket.id,
        callerName: callerName || socket.username,
        offer: offer,
        isVideo: isVideo || false
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

          // Emit enhanced user list for special room
          if (usesMongoDB(roomCode)) {
            saveUserLastSeenToMongoDB(roomCode, username, Date.now(), true);
            getUsersWithHistory(roomCode).then(users => {
              io.to(roomCode).emit('userList', users);
            });
          } else {
            io.to(roomCode).emit('userList', getUsers(roomCode));
          }
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

          // Save last seen to MongoDB for special room
          if (usesMongoDB(socket.roomCode)) {
            saveUserLastSeenToMongoDB(socket.roomCode, socket.username, userData.lastSeen, false);
          }

          // Notify others
          socket.to(socket.roomCode).emit('userOffline', {
            username: socket.username,
            socketId: socket.id
          });

          // Emit enhanced user list for special room
          if (usesMongoDB(socket.roomCode)) {
            getUsersWithHistory(socket.roomCode).then(users => {
              io.to(socket.roomCode).emit('userList', users);
            });
          } else {
            io.to(socket.roomCode).emit('userList', getUsers(socket.roomCode));
          }
        }

        // Clean up empty rooms after a delay (but keep messages!)
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
              // DO NOT DELETE MESSAGES - keep them for when users rejoin!
              // Messages are persisted to file and will be available when someone rejoins
              console.log(`🗑️ Room ${socket.roomCode} user list cleaned up (messages preserved)`);
              // Save messages immediately before we might lose the room reference
              saveMessages();
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
  res.set('Cache-Control', 'no-store');
  res.send('pong');
});


// ================== ICE SERVERS ENDPOINT ==================
app.get('/api/ice-servers', (req, res) => {
  // Return ICE server configuration with emphasis on TURN servers for restrictive networks
  // Priority: TURNS (TLS/443) > TURN (TCP/443) > TURN (UDP) > STUN
  res.json({
    iceServers: [
      // Google STUN servers (for simple NAT traversal)
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },

      // ===== METERED TURN SERVERS (Most Reliable) =====
      // These work on most restrictive networks - prioritize TCP/443 and TURNS
      {
        urls: [
          'turn:a.relay.metered.ca:443',
          'turn:a.relay.metered.ca:443?transport=tcp',
          'turns:a.relay.metered.ca:443?transport=tcp'
        ],
        username: 'e8dd65f92c95c6bf4bf1',
        credential: 'DQpDQkhS3f/L4bsi'
      },
      {
        urls: [
          'turn:b.relay.metered.ca:443',
          'turn:b.relay.metered.ca:443?transport=tcp',
          'turns:b.relay.metered.ca:443?transport=tcp'
        ],
        username: 'e8dd65f92c95c6bf4bf1',
        credential: 'DQpDQkhS3f/L4bsi'
      },
      // Additional metered servers on different ports
      {
        urls: [
          'turn:a.relay.metered.ca:80',
          'turn:a.relay.metered.ca:80?transport=tcp'
        ],
        username: 'e8dd65f92c95c6bf4bf1',
        credential: 'DQpDQkhS3f/L4bsi'
      },

      // ===== OPEN RELAY SERVERS (Backup) =====
      {
        urls: [
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp',
          'turns:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:80?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },

      // ===== ADDITIONAL FREE TURN SERVERS =====
      // Xirsys free tier (TCP on 443 for restrictive networks)
      {
        urls: [
          'turn:turn.anyfirewall.com:443?transport=tcp'
        ],
        username: 'webrtc',
        credential: 'webrtc'
      }
    ],
    // ICE transport policy - can be set to 'relay' to force TURN usage for testing
    iceTransportPolicy: 'all'
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
// Reduced to 4 minutes for more reliable keep-alive
const keepAlive = () => {
  const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  const interval = 4 * 60 * 1000; // 4 minutes (Render sleeps after 15, use 4 for extra safety)

  console.log(`⏰ Keep-alive set up for: ${url}`);

  // Periodic self-ping
  setInterval(() => {
    const pingUrl = `${url}/ping`;
    http.get(pingUrl, (res) => {
      if (res.statusCode === 200) {
        console.log(`⚡ Keep-alive ping successful (${new Date().toLocaleTimeString()})`);
      } else {
        console.error(`⚠️ Keep-alive ping failed: ${res.statusCode} (${new Date().toLocaleTimeString()})`);
      }
    }).on('error', (err) => {
      console.error(`⚠️ Keep-alive ping error (${new Date().toLocaleTimeString()}):`, err.message);
    });
  }, interval);

  // Send first ping immediately to test connectivity
  console.log('🔍 Testing keep-alive connectivity...');
  http.get(`${url}/ping`, (res) => {
    if (res.statusCode === 200) {
      console.log('✅ Keep-alive test successful - service will stay awake');
    } else {
      console.error(`⚠️ Keep-alive test failed with status: ${res.statusCode}`);
    }
  }).on('error', (err) => {
    console.error('❌ Keep-alive test failed. Check RENDER_EXTERNAL_URL:', err.message);
  });
};

// ================== GRACEFUL SHUTDOWN ==================
const gracefulShutdown = (signal) => {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  // Save messages before shutdown
  console.log('💾 Saving messages before shutdown...');
  saveMessages();

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
    saveMessages(); // Try to save one more time before force exit
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
