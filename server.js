const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const IS_PROD = process.env.NODE_ENV === 'production';

// ==========================================
// Налаштування
// ==========================================

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (IS_PROD) {
    console.error('JWT_SECRET не вказано в змінних середовища!');
    process.exit(1);
  }
  // У розробці генеруємо тимчасовий секрет (токени стануть недійсними після перезапуску)
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('JWT_SECRET не задано: використовується тимчасовий випадковий секрет.');
}

const MAX_MSG_LENGTH = 2000;
const PAGE_SIZE = 50;
const PAGE_SIZE_MAX = 100;
const REPLY_SNIPPET_LENGTH = 140;
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,20}$/u;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 72; // обмеження bcrypt
const RESERVED_USERNAMES = new Set(['general']); // службовий ідентифікатор загального чату
const MAX_GROUP_TITLE = 40;
const MAX_GROUP_MEMBERS = 50;

// Адміністратори: логіни через кому у змінній середовища, напр. ADMIN_USERNAMES=bohdan,anna
const ADMIN_USERNAMES =  new Set(
  (process.env.ADMIN_USERNAMES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const isAdminName = (name) => typeof name === 'string' && ADMIN_USERNAMES.has(name.toLowerCase());
const MUTE_FOREVER = new Date('9999-12-31T00:00:00.000Z');
const MUTE_MAX_MINUTES = 60 * 24 * 365; // не більше року (далі — «назавжди»)
// Дозволені реакції (мають збігатися з клієнтом)
const ALLOWED_REACTIONS = new Set([
  '👍', // 👍
  '❤️', // ❤️
  '😂', // 😂
  '😮', // 😮
  '😢', // 😢
  '🙏' //  🙏
]);

const isId = (value) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);

// Пошук без урахування регістру: у базі можуть лишатися логіни зі старих версій з великими літерами
const CI = { locale: 'en', strength: 2 };
const findUserCI = (name) =>
  typeof name === 'string' && name.trim()
    ? User.findOne({ username: name.trim() }).collation(CI)
    : Promise.resolve(null);

const app = express();
if (IS_PROD) app.set('trust proxy', 1); // за reverse proxy (Render, Railway тощо)

const server = http.createServer(app);

// Перевірка Origin: запити з інших сайтів відхиляємо (захист від CSRF / cross-site WebSocket)
function isSameOrigin(origin, host) {
  if (!origin) return true; // не-браузерні клієнти та звичайні same-origin GET
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const io = new Server(server, {
  allowRequest: (req, callback) => callback(null, isSameOrigin(req.headers.origin, req.headers.host))
});

// ==========================================
// Middleware
// ==========================================

// Health-check (для зовнішнього моніторингу / «будильника» Render)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: mongoose.connection.readyState === 1, uptime: Math.round(process.uptime()) });
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'upgrade-insecure-requests': null // щоб працювало на http://localhost
      }
    }
  })
);
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && !isSameOrigin(req.headers.origin, req.headers.host)) {
    return res.status(403).json({ error: 'Заборонений запит' });
  }
  next();
});

// Загальний ліміт на API та суворіший — на дії з паролем
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Забагато запитів. Спробуйте трохи пізніше.' }
  })
);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато спроб. Спробуйте пізніше.' }
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);
app.use('/api/change-password', authLimiter);
app.use('/api/delete-account', authLimiter);

// ==========================================
// Схеми та моделі MongoDB
// ==========================================

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: null },
  mutedUntil: { type: Date, default: null } // мут: до якого моменту не можна писати
});
const User = mongoose.model('User', userSchema);

const replySchema = new mongoose.Schema(
  {
    id: { type: String, index: true },
    author: String,
    text: String
  },
  { _id: false }
);

const reactionSchema = new mongoose.Schema(
  {
    emoji: String,
    users: [String]
  },
  { _id: false }
);

// Повідомлення кімнат: 'general' або id групи
const messageSchema = new mongoose.Schema({
  room: { type: String, default: 'general', index: true },
  user: { type: String, required: true },
  text: { type: String, default: '', maxlength: MAX_MSG_LENGTH },
  replyTo: { type: replySchema, default: undefined },
  reactions: { type: [reactionSchema], default: [] },
  editedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now, index: true }
});
messageSchema.index({ room: 1, _id: -1 });
const Message = mongoose.model('Message', messageSchema);

const privateMessageSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  text: { type: String, default: '', maxlength: MAX_MSG_LENGTH },
  replyTo: { type: replySchema, default: undefined },
  reactions: { type: [reactionSchema], default: [] },
  editedAt: { type: Date, default: null },
  deletedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});
privateMessageSchema.index({ sender: 1, recipient: 1, createdAt: 1 });
privateMessageSchema.index({ recipient: 1, sender: 1, createdAt: 1 });
privateMessageSchema.index({ sender: 1, recipient: 1, _id: -1 });
privateMessageSchema.index({ recipient: 1, sender: 1, _id: -1 });
const PrivateMessage = mongoose.model('PrivateMessage', privateMessageSchema);

// Групові чати
const groupSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: MAX_GROUP_TITLE },
  owner: { type: String, required: true },
  members: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
});
groupSchema.index({ members: 1 });
const Group = mongoose.model('Group', groupSchema);

// Мітки прочитаності: chat = 'general' | 'g:<groupId>' | <username співрозмовника>
const readMarkerSchema = new mongoose.Schema({
  user: { type: String, required: true },
  chat: { type: String, required: true },
  readAt: { type: Date, required: true }
});
readMarkerSchema.index({ user: 1, chat: 1 }, { unique: true });
const ReadMarker = mongoose.model('ReadMarker', readMarkerSchema);

// username -> Set з ID сокетів
const onlineUsers = new Map();

// ==========================================
// Допоміжні функції
// ==========================================

function issueToken(res, user, rememberMe) {
  const days = rememberMe ? 30 : 1;
  const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, {
    expiresIn: `${days}d`
  });
  res.cookie('token', token, {
    httpOnly: true,
    maxAge: days * 24 * 60 * 60 * 1000,
    secure: IS_PROD,
    sameSite: 'lax'
  });
}

function getTokenFromCookieHeader(header = '') {
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 'token') return decodeURIComponent(rest.join('='));
  }
  return null;
}

// Перевіряє токен і те, що користувач досі існує (і це саме той акаунт)
async function authenticate(token) {
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await User.findById(decoded.userId, 'username createdAt').lean();
    if (!user || user.username !== decoded.username) return null;
    return user;
  } catch {
    return null;
  }
}

const requireAuth = async (req, res, next) => {
  const user = await authenticate(req.cookies.token);
  if (!user) return res.status(401).json({ error: 'Не авторизовано' });
  req.user = user;
  next();
};

// Активні муті в пам'яті (username -> Date), щоб не ходити в базу на кожне повідомлення
const mutedUntilMap = new Map();

function activeMute(username) {
  const until = mutedUntilMap.get(username);
  if (!until) return null;
  if (until.getTime() <= Date.now()) {
    mutedUntilMap.delete(username);
    return null;
  }
  return until;
}

const requireAdmin = (req, res, next) => {
  if (!isAdminName(req.user.username)) {
    return res.status(403).json({ error: 'Лише для адміністраторів' });
  }
  next();
};

// Простий ліміт частоти: не більше `max` подій за `windowMs`
function createRateLimiter(max, windowMs) {
  let stamps = [];
  return () => {
    const now = Date.now();
    stamps = stamps.filter((t) => now - t < windowMs);
    if (stamps.length >= max) return false;
    stamps.push(now);
    return true;
  };
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    return `Пароль повинен містити від ${PASSWORD_MIN} до ${PASSWORD_MAX} символів`;
  }
  return null;
}

function clampLimit(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return PAGE_SIZE;
  return Math.min(n, PAGE_SIZE_MAX);
}

function serializeReactions(list) {
  return (list || [])
    .filter((r) => r.users && r.users.length > 0)
    .map((r) => ({ emoji: r.emoji, users: Array.from(r.users) }));
}

function serializeReply(reply) {
  if (!reply || !reply.id) return null;
  return { id: reply.id, author: reply.author, text: reply.text || '' };
}

function serializeRoomMessage(m) {
  const deleted = Boolean(m.deletedAt);
  return {
    id: String(m._id),
    kind: 'room',
    room: m.room || 'general',
    author: m.user,
    text: deleted ? '' : m.text,
    createdAt: m.createdAt,
    editedAt: m.editedAt || null,
    deleted,
    replyTo: serializeReply(m.replyTo),
    reactions: deleted ? [] : serializeReactions(m.reactions)
  };
}

function serializePrivateMessage(m) {
  const deleted = Boolean(m.deletedAt);
  return {
    id: String(m._id),
    kind: 'private',
    author: m.sender,
    recipient: m.recipient,
    text: deleted ? '' : m.text,
    createdAt: m.createdAt,
    editedAt: m.editedAt || null,
    deleted,
    replyTo: serializeReply(m.replyTo),
    reactions: deleted ? [] : serializeReactions(m.reactions)
  };
}

function serializeGroup(g) {
  return { id: String(g._id), title: g.title, owner: g.owner, members: Array.from(g.members) };
}

const roomChannel = (room) => (room === 'general' ? 'general' : `g:${room}`);

function emitMessage(event, kind, doc) {
  if (kind === 'private') {
    io.to([doc.recipient, doc.sender]).emit(event, serializePrivateMessage(doc));
  } else {
    io.to(roomChannel(doc.room || 'general')).emit(event, serializeRoomMessage(doc));
  }
}

// Остання сторінка повідомлень у хронологічному порядку (курсор — _id)
async function fetchPage(Model, filter, before, limit) {
  const query = { ...filter };
  if (before) query._id = { $lt: before };
  const docs = await Model.find(query)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = docs.length > limit;
  if (hasMore) docs.pop();
  docs.reverse();
  return { docs, hasMore };
}

async function resolveMembers(rawList, exclude = []) {
  if (!Array.isArray(rawList)) return [];
  const excluded = exclude.map((e) => String(e).toLowerCase());
  const names = [
    ...new Set(
      rawList
        .filter((s) => typeof s === 'string')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    )
  ]
    .filter((n) => !excluded.includes(n))
    .slice(0, MAX_GROUP_MEMBERS);
  if (!names.length) return [];
  const found = await User.find({ username: { $in: names } }, 'username').collation(CI).lean();
  return found.map((u) => u.username).filter((n) => !excluded.includes(n.toLowerCase()));
}

async function setReadMarkers(usernames, chat) {
  if (!usernames.length) return;
  const readAt = new Date();
  await ReadMarker.bulkWrite(
    usernames.map((user) => ({
      updateOne: { filter: { user, chat }, update: { $set: { readAt } }, upsert: true }
    }))
  );
}

async function deleteGroupData(group) {
  const id = String(group._id);
  await Message.deleteMany({ room: id });
  await ReadMarker.deleteMany({ chat: `g:${id}` });
  await Group.deleteOne({ _id: group._id });
}

// Кількість непрочитаних по всіх чатах
async function computeUnread(user) {
  const me = user.username;
  const markers = await ReadMarker.find({ user: me }).lean();
  const readAt = new Map(markers.map((m) => [m.chat, m.readAt]));
  const result = { general: 0, groups: {}, peers: {} };
  const tasks = [];

  tasks.push(
    Message.countDocuments({
      room: 'general',
      user: { $ne: me },
      deletedAt: null,
      createdAt: { $gt: readAt.get('general') || user.createdAt }
    }).then((n) => {
      result.general = n;
    })
  );

  const groups = await Group.find({ members: me }, 'createdAt').lean();
  for (const g of groups) {
    const id = String(g._id);
    tasks.push(
      Message.countDocuments({
        room: id,
        user: { $ne: me },
        deletedAt: null,
        createdAt: { $gt: readAt.get(`g:${id}`) || g.createdAt }
      }).then((n) => {
        if (n) result.groups[id] = n;
      })
    );
  }

  const senders = await PrivateMessage.distinct('sender', { recipient: me });
  for (const sender of senders) {
    tasks.push(
      PrivateMessage.countDocuments({
        sender,
        recipient: me,
        deletedAt: null,
        createdAt: { $gt: readAt.get(sender) || new Date(0) }
      }).then((n) => {
        if (n) result.peers[sender] = n;
      })
    );
  }

  await Promise.all(tasks);
  return result;
}

// Повне видалення акаунта та пов'язаних даних
async function deleteUserData(username) {
  const now = new Date();

  await PrivateMessage.deleteMany({ $or: [{ sender: username }, { recipient: username }] });

  // Повідомлення в загальному чаті/групах: прибираємо вміст, але лишаємо «дірку» для контексту
  await Message.updateMany(
    { user: username, deletedAt: null },
    { $set: { text: '', deletedAt: now, reactions: [] }, $unset: { replyTo: '' } }
  );
  // Цитати їхніх повідомлень в чужих відповідях теж очищаємо
  await Message.updateMany({ 'replyTo.author': username }, { $set: { 'replyTo.text': '' } });
  await Message.updateMany(
    { 'reactions.users': username },
    { $pull: { 'reactions.$[].users': username } }
  );
  await Message.updateMany(
    { 'reactions.users': { $size: 0 } },
    { $pull: { reactions: { users: { $size: 0 } } } }
  );

  await ReadMarker.deleteMany({ $or: [{ user: username }, { chat: username }] });

  const groups = await Group.find({ members: username });
  for (const group of groups) {
    const id = String(group._id);
    group.members = group.members.filter((m) => m !== username);
    if (group.members.length === 0) {
      io.to(`g:${id}`).emit('groupRemoved', { id });
      await deleteGroupData(group);
    } else {
      if (group.owner === username) group.owner = group.members[0];
      await group.save();
      io.to(`g:${id}`).emit('groupUpdated', serializeGroup(group));
    }
  }

  await User.deleteOne({ username });

  io.emit('userRemoved', { username });
  io.in(username).disconnectSockets(true);
}

// ==========================================
// REST API: авторизація та профіль
// ==========================================

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Заповніть усі поля' });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (!USERNAME_RE.test(cleanUsername)) {
      return res.status(400).json({ error: 'Логін: 3–20 символів (літери, цифри, _ . -)' });
    }
    if (RESERVED_USERNAMES.has(cleanUsername)) {
      return res.status(400).json({ error: 'Цей логін зарезервовано' });
    }
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    if (await findUserCI(cleanUsername)) {
      return res.status(400).json({ error: 'Користувач вже існує' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({ username: cleanUsername, password: hashedPassword });

    issueToken(res, newUser, Boolean(rememberMe));
    io.emit('userRegistered', { username: newUser.username });

    res.status(201).json({ success: true, username: newUser.username, isAdmin: isAdminName(newUser.username) });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(400).json({ error: 'Користувач вже існує' });
    }
    console.error('Помилка реєстрації:', err);
    res.status(500).json({ error: 'Помилка реєстрації' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Заповніть усі поля' });
    }

    const user = await findUserCI(username);
    const isMatch = user ? await bcrypt.compare(password, user.password) : false;
    if (!isMatch) {
      return res.status(400).json({ error: 'Невірні дані для входу' });
    }

    issueToken(res, user, Boolean(rememberMe));
    res.json({ success: true, username: user.username, isAdmin: isAdminName(user.username) });
  } catch (err) {
    console.error('Помилка авторизації:', err);
    res.status(500).json({ error: 'Помилка авторизації' });
  }
});

app.get('/api/me', async (req, res) => {
  const user = await authenticate(req.cookies.token);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, username: user.username, isAdmin: isAdminName(user.username) });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

app.post('/api/change-password', requireAuth, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body || {};
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string' || !oldPassword) {
      return res.status(400).json({ error: 'Заповніть усі поля' });
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) return res.status(400).json({ error: passwordError });
    if (oldPassword === newPassword) {
      return res.status(400).json({ error: 'Новий пароль збігається зі старим' });
    }

    const user = await User.findById(req.user._id);
    if (!user || !(await bcrypt.compare(oldPassword, user.password))) {
      return res.status(400).json({ error: 'Невірний поточний пароль' });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    res.json({ success: true });
  } catch (err) {
    console.error('Помилка зміни пароля:', err);
    res.status(500).json({ error: 'Не вдалося змінити пароль' });
  }
});

app.post('/api/delete-account', requireAuth, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Введіть пароль' });
    }

    const user = await User.findById(req.user._id);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Невірний пароль' });
    }

    await deleteUserData(user.username);
    res.clearCookie('token');
    res.json({ success: true });
  } catch (err) {
    console.error('Помилка видалення акаунта:', err);
    res.status(500).json({ error: 'Не вдалося видалити акаунт' });
  }
});

// ==========================================
// REST API: користувачі, історія, непрочитані
// ==========================================

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const viewerIsAdmin = isAdminName(req.user.username);
    const users = await User.find({ username: { $ne: req.user.username } }, 'username lastSeen mutedUntil')
      .sort({ username: 1 })
      .lean();
    const now = Date.now();
    res.json(
      users.map((user) => {
        const item = {
          username: user.username,
          isOnline: onlineUsers.has(user.username),
          lastSeen: user.lastSeen || null
        };
        // Статус муту та ознаку адміна бачать лише адміністратори
        if (viewerIsAdmin) {
          item.isAdmin = isAdminName(user.username);
          item.mutedUntil = user.mutedUntil && user.mutedUntil.getTime() > now ? user.mutedUntil : null;
        }
        return item;
      })
    );
  } catch (err) {
    console.error('Помилка завантаження користувачів:', err);
    res.status(500).json({ error: 'Помилка завантаження користувачів' });
  }
});

app.get('/api/unread', requireAuth, async (req, res) => {
  try {
    res.json(await computeUnread(req.user));
  } catch (err) {
    console.error('Помилка підрахунку непрочитаних:', err);
    res.status(500).json({ error: 'Помилка завантаження' });
  }
});

// Історія загального чату або групи (room = 'general' | id групи)
app.get('/api/rooms/:room/messages', requireAuth, async (req, res) => {
  try {
    const room = String(req.params.room);
    const before = req.query.before;
    if (before !== undefined && !isId(before)) {
      return res.status(400).json({ error: 'Некоректний курсор' });
    }

    if (room !== 'general') {
      if (!isId(room) || !(await Group.exists({ _id: room, members: req.user.username }))) {
        return res.status(403).json({ error: 'Немає доступу до цієї групи' });
      }
    }

    const { docs, hasMore } = await fetchPage(Message, { room }, before, clampLimit(req.query.limit));
    res.json({ messages: docs.map(serializeRoomMessage), hasMore });
  } catch (err) {
    console.error('Помилка завантаження історії:', err);
    res.status(500).json({ error: 'Помилка завантаження історії' });
  }
});

// Історія приватного чату
app.get('/api/messages/:targetUser', requireAuth, async (req, res) => {
  try {
    const me = req.user.username;
    const targetUser = await findUserCI(req.params.targetUser);
    const target = targetUser ? targetUser.username : String(req.params.targetUser).trim();
    const before = req.query.before;
    if (before !== undefined && !isId(before)) {
      return res.status(400).json({ error: 'Некоректний курсор' });
    }

    const filter = {
      $or: [
        { sender: me, recipient: target },
        { sender: target, recipient: me }
      ]
    };
    const { docs, hasMore } = await fetchPage(PrivateMessage, filter, before, clampLimit(req.query.limit));

    let peerRead = null;
    if (!before) {
      const marker = await ReadMarker.findOne({ user: target, chat: me }).lean();
      peerRead = marker ? marker.readAt : null;
    }

    res.json({ messages: docs.map(serializePrivateMessage), hasMore, peerRead });
  } catch (err) {
    console.error('Помилка завантаження історії:', err);
    res.status(500).json({ error: 'Помилка завантаження історії' });
  }
});

// ==========================================
// REST API: групи
// ==========================================

app.get('/api/groups', requireAuth, async (req, res) => {
  try {
    const groups = await Group.find({ members: req.user.username }).sort({ createdAt: 1 }).lean();
    res.json(groups.map(serializeGroup));
  } catch (err) {
    console.error('Помилка завантаження груп:', err);
    res.status(500).json({ error: 'Помилка завантаження груп' });
  }
});

app.post('/api/groups', requireAuth, async (req, res) => {
  try {
    const me = req.user.username;
    const body = req.body || {};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > MAX_GROUP_TITLE) {
      return res.status(400).json({ error: `Назва групи: 1–${MAX_GROUP_TITLE} символів` });
    }

    const others = await resolveMembers(body.members, [me]);
    if (!others.length) {
      return res.status(400).json({ error: 'Додайте хоча б одного учасника' });
    }

    const members = [me, ...others];
    const group = await Group.create({ title, owner: me, members });
    const id = String(group._id);

    await setReadMarkers(members, `g:${id}`);
    io.in(members).socketsJoin(`g:${id}`);
    io.to(`g:${id}`).emit('groupUpdated', serializeGroup(group));

    res.status(201).json(serializeGroup(group));
  } catch (err) {
    console.error('Помилка створення групи:', err);
    res.status(500).json({ error: 'Не вдалося створити групу' });
  }
});

app.post('/api/groups/:id/members', requireAuth, async (req, res) => {
  try {
    const me = req.user.username;
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Некоректна група' });

    const group = await Group.findById(req.params.id);
    if (!group || !group.members.includes(me)) return res.status(404).json({ error: 'Групу не знайдено' });
    if (group.owner !== me) return res.status(403).json({ error: 'Лише власник може додавати учасників' });

    const add = await resolveMembers((req.body || {}).members, Array.from(group.members));
    if (!add.length) return res.status(400).json({ error: 'Немає кого додати' });
    if (group.members.length + add.length > MAX_GROUP_MEMBERS) {
      return res.status(400).json({ error: `Максимум ${MAX_GROUP_MEMBERS} учасників` });
    }

    group.members.push(...add);
    await group.save();
    const id = String(group._id);

    await setReadMarkers(add, `g:${id}`);
    io.in(add).socketsJoin(`g:${id}`);
    io.to(`g:${id}`).emit('groupUpdated', serializeGroup(group));

    res.json(serializeGroup(group));
  } catch (err) {
    console.error('Помилка додавання учасників:', err);
    res.status(500).json({ error: 'Не вдалося додати учасників' });
  }
});

app.post('/api/groups/:id/leave', requireAuth, async (req, res) => {
  try {
    const me = req.user.username;
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Некоректна група' });

    const group = await Group.findOne({ _id: req.params.id, members: me });
    if (!group) return res.status(404).json({ error: 'Групу не знайдено' });
    const id = String(group._id);

    group.members = group.members.filter((m) => m !== me);
    io.in(me).socketsLeave(`g:${id}`);
    await ReadMarker.deleteOne({ user: me, chat: `g:${id}` });

    if (group.members.length === 0) {
      await deleteGroupData(group);
    } else {
      if (group.owner === me) group.owner = group.members[0];
      await group.save();
      io.to(`g:${id}`).emit('groupUpdated', serializeGroup(group));
    }

    io.to(me).emit('groupRemoved', { id });
    res.json({ success: true });
  } catch (err) {
    console.error('Помилка виходу з групи:', err);
    res.status(500).json({ error: 'Не вдалося вийти з групи' });
  }
});

app.delete('/api/groups/:id', requireAuth, async (req, res) => {
  try {
    const me = req.user.username;
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Некоректна група' });

    const group = await Group.findById(req.params.id);
    if (!group || !group.members.includes(me)) return res.status(404).json({ error: 'Групу не знайдено' });
    if (group.owner !== me) return res.status(403).json({ error: 'Лише власник може видалити групу' });

    const id = String(group._id);
    io.to(`g:${id}`).emit('groupRemoved', { id });
    await deleteGroupData(group);
    io.in(`g:${id}`).socketsLeave(`g:${id}`);

    res.json({ success: true });
  } catch (err) {
    console.error('Помилка видалення групи:', err);
    res.status(500).json({ error: 'Не вдалося видалити групу' });
  }
});

// ==========================================
// REST API: адміністрування
// ==========================================

// Мут користувача: { username, minutes } або { username, forever: true }
app.post('/api/admin/mute', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { username, minutes, forever } = req.body || {};
    const target = await findUserCI(username);
    if (!target) return res.status(404).json({ error: 'Користувача не знайдено' });
    if (isAdminName(target.username)) {
      return res.status(400).json({ error: 'Адміністратора не можна замутити' });
    }

    let until;
    if (forever === true) {
      until = MUTE_FOREVER;
    } else {
      const m = Number(minutes);
      if (!Number.isFinite(m) || m < 1 || m > MUTE_MAX_MINUTES) {
        return res.status(400).json({ error: 'Некоректна тривалість муту' });
      }
      until = new Date(Date.now() + m * 60000);
    }

    await User.updateOne({ _id: target._id }, { $set: { mutedUntil: until } });
    mutedUntilMap.set(target.username, until);

    io.to(target.username).emit('muteState', { mutedUntil: until });
    io.to('admins').emit('muteUpdated', { username: target.username, mutedUntil: until });

    res.json({ success: true, username: target.username, mutedUntil: until });
  } catch (err) {
    console.error('Помилка муту:', err);
    res.status(500).json({ error: 'Не вдалося замутити користувача' });
  }
});

app.post('/api/admin/unmute', requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = await findUserCI((req.body || {}).username);
    if (!target) return res.status(404).json({ error: 'Користувача не знайдено' });

    await User.updateOne({ _id: target._id }, { $set: { mutedUntil: null } });
    mutedUntilMap.delete(target.username);

    io.to(target.username).emit('muteState', { mutedUntil: null });
    io.to('admins').emit('muteUpdated', { username: target.username, mutedUntil: null });

    res.json({ success: true, username: target.username, mutedUntil: null });
  } catch (err) {
    console.error('Помилка зняття муту:', err);
    res.status(500).json({ error: 'Не вдалося зняти мут' });
  }
});

// Видалення користувача: приватні листування стираються, повідомлення в чатах стають «видаленими»
app.post('/api/admin/delete-user', requireAuth, requireAdmin, async (req, res) => {
  try {
    const target = await findUserCI((req.body || {}).username);
    if (!target) return res.status(404).json({ error: 'Користувача не знайдено' });
    if (isAdminName(target.username)) {
      return res.status(400).json({ error: 'Адміністратора не можна видалити' });
    }

    mutedUntilMap.delete(target.username);
    await deleteUserData(target.username);
    console.log(`Адміністратор ${req.user.username} видалив користувача ${target.username}`);

    res.json({ success: true, username: target.username });
  } catch (err) {
    console.error('Помилка видалення користувача:', err);
    res.status(500).json({ error: 'Не вдалося видалити користувача' });
  }
});

// Обробник помилок (наприклад, некоректний JSON)
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Некоректний запит' });
  }
  console.error(err);
  res.status(500).json({ error: 'Внутрішня помилка сервера' });
});

// ==========================================
// Socket.IO
// ==========================================

io.use(async (socket, next) => {
  try {
    const token = getTokenFromCookieHeader(socket.handshake.headers.cookie);
    const user = await authenticate(token);
    if (!user) return next(new Error('Auth error'));
    socket.user = { username: user.username };
    next();
  } catch {
    next(new Error('Auth error'));
  }
});

io.on('connection', (socket) => {
  const username = socket.user.username;
  const canSend = createRateLimiter(10, 5000); // нові повідомлення: до 10 за 5 с
  const canAct = createRateLimiter(40, 10000); // редагування, реакції, позначки прочитаного

  // Замученим не можна ні писати, ні редагувати, ні ставити реакції
  const blockedByMute = () => {
    if (!activeMute(username)) return false;
    socket.emit('errorMessage', 'Вас вимкнено (мут): надсилати повідомлення не можна');
    return true;
  };

  socket.join([username, 'general']);
  if (isAdminName(username)) socket.join('admins');
  socket.emit('muteState', { mutedUntil: activeMute(username) });

  // Підписка на кімнати груп (обробники, що залежать від неї, чекають на `ready`)
  const ready = (async () => {
    try {
      const groups = await Group.find({ members: username }, '_id').lean();
      socket.join(groups.map((g) => `g:${g._id}`));
    } catch (err) {
      console.error('Помилка підписки на групи:', err);
    }
  })();

  if (!onlineUsers.has(username)) onlineUsers.set(username, new Set());
  onlineUsers.get(username).add(socket.id);
  io.emit('onlineUsers', Array.from(onlineUsers.keys()));

  // Створює знімок повідомлення, на яке відповідають
  async function buildReply(Model, extraFilter, replyId) {
    if (!isId(replyId)) return undefined;
    const target = await Model.findOne({ _id: replyId, ...extraFilter }).lean();
    if (!target) return undefined;
    return {
      id: String(target._id),
      author: target.user || target.sender,
      text: target.deletedAt ? '' : String(target.text).slice(0, REPLY_SNIPPET_LENGTH)
    };
  }

  const inRoom = (room) => room === 'general' || (isId(room) && socket.rooms.has(`g:${room}`));

  // --- Нове повідомлення в загальний чат / групу ---
  socket.on('chatMessage', async (data) => {
    try {
      if (blockedByMute()) return;
      await ready;
      if (!data || typeof data.text !== 'string') return;
      const room = typeof data.room === 'string' ? data.room : 'general';
      if (!inRoom(room)) return socket.emit('errorMessage', 'Ви не є учасником цієї групи');

      const text = data.text.trim();
      if (!text) return;
      if (text.length > MAX_MSG_LENGTH) {
        return socket.emit('errorMessage', `Повідомлення задовге (максимум ${MAX_MSG_LENGTH} символів)`);
      }
      if (!canSend()) return socket.emit('errorMessage', 'Надто часто. Зачекайте кілька секунд.');

      const replyTo = await buildReply(Message, { room }, data.replyTo);
      const doc = await Message.create({ room, user: username, text, replyTo });
      emitMessage('message', 'room', doc);
    } catch (err) {
      console.error('Помилка збереження повідомлення:', err);
    }
  });

  // --- Приватне повідомлення ---
  socket.on('privateMessage', async (data) => {
    try {
      if (blockedByMute()) return;
      if (!data || typeof data.recipient !== 'string' || typeof data.text !== 'string') return;

      const text = data.text.trim();
      const rawRecipient = data.recipient.trim();
      if (!text || !rawRecipient) return;
      if (text.length > MAX_MSG_LENGTH) {
        return socket.emit('errorMessage', `Повідомлення задовге (максимум ${MAX_MSG_LENGTH} символів)`);
      }
      if (!canSend()) return socket.emit('errorMessage', 'Надто часто. Зачекайте кілька секунд.');
      const recipientUser = await findUserCI(rawRecipient);
      if (!recipientUser) {
        return socket.emit('errorMessage', 'Такого користувача не існує');
      }
      const recipient = recipientUser.username;
      if (recipient === username) return;

      const replyTo = await buildReply(
        PrivateMessage,
        {
          $or: [
            { sender: username, recipient },
            { sender: recipient, recipient: username }
          ]
        },
        data.replyTo
      );
      const doc = await PrivateMessage.create({ sender: username, recipient, text, replyTo });
      emitMessage('message', 'private', doc);
    } catch (err) {
      console.error('Помилка приватного повідомлення:', err);
    }
  });

  // --- Редагування власного повідомлення ---
  socket.on('editMessage', async (data) => {
    try {
      if (blockedByMute()) return;
      await ready;
      if (!data || !isId(data.id) || typeof data.text !== 'string') return;
      const kind = data.kind === 'private' ? 'private' : 'room';
      const text = data.text.trim();
      if (!text) return;
      if (text.length > MAX_MSG_LENGTH) {
        return socket.emit('errorMessage', `Повідомлення задовге (максимум ${MAX_MSG_LENGTH} символів)`);
      }
      if (!canAct()) return socket.emit('errorMessage', 'Надто часто. Зачекайте кілька секунд.');

      const Model = kind === 'private' ? PrivateMessage : Message;
      const authorField = kind === 'private' ? 'sender' : 'user';
      const existing = await Model.findOne({ _id: data.id, [authorField]: username, deletedAt: null }).lean();
      if (!existing) return;
      if (kind === 'room' && !inRoom(existing.room || 'general')) return;

      const updated = await Model.findByIdAndUpdate(
        data.id,
        { $set: { text, editedAt: new Date() } },
        { new: true }
      );
      if (updated) emitMessage('messageUpdated', kind, updated);
    } catch (err) {
      console.error('Помилка редагування:', err);
    }
  });

  // --- Видалення власного повідомлення (м'яке) ---
  socket.on('deleteMessage', async (data) => {
    try {
      await ready;
      if (!data || !isId(data.id)) return;
      const kind = data.kind === 'private' ? 'private' : 'room';
      if (!canAct()) return socket.emit('errorMessage', 'Надто часто. Зачекайте кілька секунд.');

      const Model = kind === 'private' ? PrivateMessage : Message;
      const authorField = kind === 'private' ? 'sender' : 'user';
      const existing = await Model.findOne({ _id: data.id, [authorField]: username, deletedAt: null }).lean();
      if (!existing) return;
      if (kind === 'room' && !inRoom(existing.room || 'general')) return;

      const updated = await Model.findByIdAndUpdate(
        data.id,
        { $set: { text: '', deletedAt: new Date(), reactions: [] } },
        { new: true }
      );
      // Прибираємо цитати видаленого повідомлення в інших відповідях
      await Model.updateMany({ 'replyTo.id': String(data.id) }, { $set: { 'replyTo.text': '' } });
      if (updated) emitMessage('messageUpdated', kind, updated);
    } catch (err) {
      console.error('Помилка видалення:', err);
    }
  });

  // --- Реакція на повідомлення (повторне натискання знімає її) ---
  socket.on('reactMessage', async (data) => {
    try {
      if (blockedByMute()) return;
      await ready;
      if (!data || !isId(data.id) || !ALLOWED_REACTIONS.has(data.emoji)) return;
      const kind = data.kind === 'private' ? 'private' : 'room';
      if (!canAct()) return socket.emit('errorMessage', 'Надто часто. Зачекайте кілька секунд.');

      const Model = kind === 'private' ? PrivateMessage : Message;
      const msg = await Model.findOne({ _id: data.id, deletedAt: null }).lean();
      if (!msg) return;
      if (kind === 'private' && msg.sender !== username && msg.recipient !== username) return;
      if (kind === 'room' && !inRoom(msg.room || 'general')) return;

      const emoji = data.emoji;
      const group = (msg.reactions || []).find((r) => r.emoji === emoji);
      if (group && group.users.includes(username)) {
        await Model.updateOne(
          { _id: msg._id, 'reactions.emoji': emoji },
          { $pull: { 'reactions.$.users': username } }
        );
        await Model.updateOne({ _id: msg._id }, { $pull: { reactions: { users: { $size: 0 } } } });
      } else if (group) {
        await Model.updateOne(
          { _id: msg._id, 'reactions.emoji': emoji },
          { $addToSet: { 'reactions.$.users': username } }
        );
      } else {
        await Model.updateOne({ _id: msg._id }, { $push: { reactions: { emoji, users: [username] } } });
      }

      const updated = await Model.findById(msg._id);
      if (updated) emitMessage('messageUpdated', kind, updated);
    } catch (err) {
      console.error('Помилка реакції:', err);
    }
  });

  // --- Позначка «прочитано» ---
  socket.on('markRead', async (data) => {
    try {
      await ready;
      if (!data || typeof data.chat !== 'string' || !canAct()) return;
      const raw = data.chat.trim();
      const isGroup = raw.startsWith('g:');
      let chat = raw;

      if (isGroup) {
        if (!socket.rooms.has(chat)) return;
      } else if (chat !== 'general') {
        const peer = await findUserCI(raw);
        if (!peer || peer.username === username) return;
        chat = peer.username;
      }

      const at = new Date();
      await ReadMarker.updateOne({ user: username, chat }, { $set: { readAt: at } }, { upsert: true });

      // Синхронізуємо інші вкладки/пристрої цього користувача
      io.to(username).emit('unreadCleared', { chat });
      // Співрозмовник бачить статус «прочитано»
      if (!isGroup && chat !== 'general') {
        io.to(chat).emit('peerRead', { peer: username, at });
      }
    } catch (err) {
      console.error('Помилка позначки прочитаного:', err);
    }
  });

  // --- Індикатори друкування ---
  const relayTyping = (eventName) => (data) => {
    const raw = data && typeof data.recipient === 'string' ? data.recipient.trim() : '';
    if (!raw) return;

    if (raw === 'general') {
      socket.to('general').emit(eventName, { sender: username, recipient: 'general' });
    } else if (raw.startsWith('g:')) {
      if (socket.rooms.has(raw)) socket.to(raw).emit(eventName, { sender: username, recipient: raw });
    } else {
      const recipient = raw;
      if (recipient !== username) io.to(recipient).emit(eventName, { sender: username, recipient });
    }
  };
  socket.on('typing', relayTyping('typing'));
  socket.on('stopTyping', relayTyping('stopTyping'));

  socket.on('disconnect', async () => {
    const userSockets = onlineUsers.get(username);
    if (userSockets) {
      userSockets.delete(socket.id);
      if (userSockets.size === 0) {
        onlineUsers.delete(username);
        const at = new Date();
        try {
          await User.updateOne({ username }, { $set: { lastSeen: at } });
          io.emit('lastSeen', { username, at });
        } catch (err) {
          console.error('Помилка збереження lastSeen:', err);
        }
      }
    }
    io.emit('onlineUsers', Array.from(onlineUsers.keys()));
  });
});

// ==========================================
// Запуск
// ==========================================

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

async function start() {
  try {
    if (!MONGO_URI) {
      throw new Error('MONGO_URI не вказано в змінних середовища!');
    }

    await mongoose.connect(MONGO_URI);
    console.log('Успішно підключено до MongoDB');

    // Міграція: старі повідомлення без поля room належать загальному чату
    await Message.updateMany({ room: { $exists: false } }, { $set: { room: 'general' } });

    // Відновлюємо активні муті після перезапуску сервера
    const muted = await User.find({ mutedUntil: { $gt: new Date() } }, 'username mutedUntil').lean();
    muted.forEach((u) => mutedUntilMap.set(u.username, u.mutedUntil));

    if (ADMIN_USERNAMES.size) {
      console.log(`Адміністратори: ${[...ADMIN_USERNAMES].join(', ')}`);
    } else {
      console.warn('ADMIN_USERNAMES не задано: адміністраторів немає.');
    }

    server.listen(PORT, () => {
      console.log(`Сервер запущено на порту ${PORT}`);
    });
  } catch (err) {
    console.error('Помилка запуску сервера:', err);
    process.exit(1);
  }
}

start();