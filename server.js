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

// --- Налаштування ---

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
const HISTORY_LIMIT_GENERAL = 50;
const HISTORY_LIMIT_PRIVATE = 100;
const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,20}$/u;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 72; // обмеження bcrypt
const RESERVED_USERNAMES = new Set(['general']); // 'general' — службовий ідентифікатор загального чату

const app = express();
if (IS_PROD) app.set('trust proxy', 1); // за reverse proxy (Render, Railway тощо), щоб rate limit бачив реальний IP

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

// --- Middleware ---

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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Забагато спроб. Спробуйте пізніше.' }
});
app.use('/api/login', authLimiter);
app.use('/api/register', authLimiter);

// --- Схеми та моделі MongoDB ---

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

const messageSchema = new mongoose.Schema({
  user: { type: String, required: true },
  text: { type: String, required: true, maxlength: MAX_MSG_LENGTH },
  createdAt: { type: Date, default: Date.now, index: true }
});
const Message = mongoose.model('Message', messageSchema);

const privateMessageSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  text: { type: String, required: true, maxlength: MAX_MSG_LENGTH },
  createdAt: { type: Date, default: Date.now }
});
privateMessageSchema.index({ sender: 1, recipient: 1, createdAt: 1 });
privateMessageSchema.index({ recipient: 1, sender: 1, createdAt: 1 });
const PrivateMessage = mongoose.model('PrivateMessage', privateMessageSchema);

// username -> Set з ID сокетів
const onlineUsers = new Map();

// --- Допоміжні функції ---

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

// Остання N повідомлень у хронологічному порядку
async function latestMessages(query, limit) {
  const docs = await query.sort({ createdAt: -1 }).limit(limit).lean();
  return docs.reverse();
}

// --- REST API ---

app.post('/api/register', async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({ error: 'Заповніть усі поля' });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (!USERNAME_RE.test(cleanUsername)) {
      return res.status(400).json({
        error: 'Логін: 3–20 символів (літери, цифри, _ . -)'
      });
    }
    if (RESERVED_USERNAMES.has(cleanUsername)) {
      return res.status(400).json({ error: 'Цей логін зарезервовано' });
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return res.status(400).json({
        error: `Пароль повинен містити від ${PASSWORD_MIN} до ${PASSWORD_MAX} символів`
      });
    }

    if (await User.exists({ username: cleanUsername })) {
      return res.status(400).json({ error: 'Користувач вже існує' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await User.create({ username: cleanUsername, password: hashedPassword });

    issueToken(res, newUser, Boolean(rememberMe));

    // Повідомляємо всіх, щоб новий користувач одразу з'явився у списках
    io.emit('userRegistered', { username: newUser.username });

    res.status(201).json({ success: true, username: newUser.username });
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

    const user = await User.findOne({ username: username.trim().toLowerCase() });
    const isMatch = user ? await bcrypt.compare(password, user.password) : false;
    if (!isMatch) {
      return res.status(400).json({ error: 'Невірні дані для входу' });
    }

    issueToken(res, user, Boolean(rememberMe));
    res.json({ success: true, username: user.username });
  } catch (err) {
    console.error('Помилка авторизації:', err);
    res.status(500).json({ error: 'Помилка авторизації' });
  }
});

app.get('/api/me', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ authenticated: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, username: decoded.username });
  } catch {
    res.status(401).json({ authenticated: false });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

const requireAuth = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Не авторизовано' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Не авторизовано' });
  }
};

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const users = await User.find({ username: { $ne: req.user.username } }, 'username')
      .sort({ username: 1 })
      .lean();
    res.json(
      users.map((user) => ({
        username: user.username,
        isOnline: onlineUsers.has(user.username)
      }))
    );
  } catch (err) {
    console.error('Помилка завантаження користувачів:', err);
    res.status(500).json({ error: 'Помилка завантаження користувачів' });
  }
});

app.get('/api/messages/:targetUser', requireAuth, async (req, res) => {
  try {
    const currentUser = req.user.username;
    const targetUser = String(req.params.targetUser).trim().toLowerCase();

    const history = await latestMessages(
      PrivateMessage.find({
        $or: [
          { sender: currentUser, recipient: targetUser },
          { sender: targetUser, recipient: currentUser }
        ]
      }),
      HISTORY_LIMIT_PRIVATE
    );

    res.json(history);
  } catch (err) {
    console.error('Помилка завантаження історії:', err);
    res.status(500).json({ error: 'Помилка завантаження історії' });
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

// --- Socket.IO ---

io.use((socket, next) => {
  try {
    const token = getTokenFromCookieHeader(socket.handshake.headers.cookie);
    if (!token) return next(new Error('Auth error'));
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Auth error'));
  }
});

io.on('connection', async (socket) => {
  const username = socket.user.username;
  const canSend = createRateLimiter(10, 5000); // до 10 повідомлень за 5 секунд

  socket.join(username);

  if (!onlineUsers.has(username)) {
    onlineUsers.set(username, new Set());
  }
  onlineUsers.get(username).add(socket.id);
  io.emit('onlineUsers', Array.from(onlineUsers.keys()));

  try {
    const history = await latestMessages(Message.find(), HISTORY_LIMIT_GENERAL);
    socket.emit('chatHistory', history);
  } catch (err) {
    console.error('Помилка завантаження історії загального чату:', err);
  }

  socket.on('chatMessage', async (data) => {
    try {
      if (!data || typeof data.text !== 'string') return;
      const text = data.text.trim();
      if (!text) return;
      if (text.length > MAX_MSG_LENGTH) {
        return socket.emit('errorMessage', `Повідомлення задовге (максимум ${MAX_MSG_LENGTH} символів)`);
      }
      if (!canSend()) {
        return socket.emit('errorMessage', 'Надто часто. Зачекайте кілька секунд.');
      }

      const newMessage = await Message.create({ user: username, text });
      io.emit('chatMessage', { user: username, text, createdAt: newMessage.createdAt });
    } catch (err) {
      console.error('Помилка збереження загального повідомлення:', err);
    }
  });

  socket.on('privateMessage', async (data) => {
    try {
      if (!data || typeof data.recipient !== 'string' || typeof data.text !== 'string') return;

      const cleanText = data.text.trim();
      const cleanRecipient = data.recipient.trim().toLowerCase();
      if (!cleanText || !cleanRecipient) return;
      if (cleanText.length > MAX_MSG_LENGTH) {
        return socket.emit('errorMessage', `Повідомлення задовге (максимум ${MAX_MSG_LENGTH} символів)`);
      }
      if (!canSend()) {
        return socket.emit('errorMessage', 'Надто часто. Зачекайте кілька секунд.');
      }
      if (!(await User.exists({ username: cleanRecipient }))) {
        return socket.emit('errorMessage', 'Такого користувача не існує');
      }

      const newMsg = await PrivateMessage.create({
        sender: username,
        recipient: cleanRecipient,
        text: cleanText
      });

      const messageData = {
        sender: username,
        recipient: cleanRecipient,
        text: cleanText,
        createdAt: newMsg.createdAt
      };

      io.to(cleanRecipient).emit('privateMessage', messageData);
      if (cleanRecipient !== username) {
        io.to(username).emit('privateMessage', messageData);
      }
    } catch (err) {
      console.error('Помилка приватного повідомлення:', err);
    }
  });

  const relayTyping = (eventName) => (data) => {
    const recipient =
      data && typeof data.recipient === 'string' ? data.recipient.trim().toLowerCase() : '';
    if (!recipient) return;

    if (recipient === 'general') {
      socket.broadcast.emit(eventName, { sender: username, recipient: 'general' });
    } else if (recipient !== username) {
      io.to(recipient).emit(eventName, { sender: username, recipient });
    }
  };
  socket.on('typing', relayTyping('typing'));
  socket.on('stopTyping', relayTyping('stopTyping'));

  socket.on('disconnect', () => {
    const userSockets = onlineUsers.get(username);
    if (userSockets) {
      userSockets.delete(socket.id);
      if (userSockets.size === 0) onlineUsers.delete(username);
    }
    io.emit('onlineUsers', Array.from(onlineUsers.keys()));
  });
});

// --- Запуск ---

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

async function start() {
  try {
    if (!MONGO_URI) {
      throw new Error('MONGO_URI не вказано в змінних середовища!');
    }

    await mongoose.connect(MONGO_URI);
    console.log('Успішно підключено до MongoDB');

    server.listen(PORT, () => {
      console.log(`Сервер запущено на порту ${PORT}`);
    });
  } catch (err) {
    console.error('Помилка запуску сервера:', err);
    process.exit(1);
  }
}

start();