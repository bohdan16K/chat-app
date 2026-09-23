const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_chat_key_123';

// Middleware для обробки JSON, статики та Cookie
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

// --- СХЕМИ ТА МОДЕЛІ MONGODB ---

// 1. Схема користувача
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model('User', userSchema);

// 2. Схема повідомлення
const messageSchema = new mongoose.Schema({
  user: String,
  text: String,
  createdAt: { type: Date, default: Date.now }
});
const Message = mongoose.model('Message', messageSchema);

// 3. Приватні повідомлення
const privateMessageSchema = new mongoose.Schema({
  sender: { type: String, required: true },
  recipient: { type: String, required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const PrivateMessage = mongoose.model('PrivateMessage', privateMessageSchema);

// Сховище користувачів онлайн (Map: username -> Set з ID сокетів)
// Це вирішує проблему кількох вкладок у одного користувача
const onlineUsers = new Map();

// --- REST API МАРШРУТИ АВТОРИЗАЦІЇ ---

// Реєстрація (з автоматичною видачею токена)
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Заповніть усі поля' });
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: 'Користувач вже існує' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();

    const token = jwt.sign(
      { userId: newUser._id, username: newUser.username }, 
      JWT_SECRET, 
      { expiresIn: '1d' }
    );

    res.cookie('token', token, {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    res.status(201).json({ success: true, username: newUser.username, message: 'Успішно зареєстровано' });
  } catch (err) {
    res.status(500).json({ error: 'Помилка реєстрації' });
  }
});

// Вхід (з "Запам'ятати мене")
app.post('/api/login', async (req, res) => {
  try {
    const { username, password, rememberMe } = req.body;

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(400).json({ error: 'Невірні дані для входу' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Невірні дані для входу' });
    }

    const expiresIn = rememberMe ? '30d' : '1d';
    const maxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;

    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn });

    res.cookie('token', token, {
      httpOnly: true,
      maxAge: maxAge,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    });

    res.json({ success: true, username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Помилка авторизації' });
  }
});

// Перевірка сесії
app.get('/api/me', (req, res) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ authenticated: false });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ authenticated: true, username: decoded.username });
  } catch (err) {
    res.status(401).json({ authenticated: false });
  }
});

// Вихід
app.post('/api/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true });
});

// Middleware авторизації
const requireAuth = (req, res, next) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Не авторизовано' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: 'Не авторизовано' });
  }
};

// Список користувачів
app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const users = await User.find({ username: { $ne: req.user.username } }, 'username');
    const usersWithStatus = users.map(user => ({
      username: user.username,
      isOnline: onlineUsers.has(user.username)
    }));

    res.json(usersWithStatus);
  } catch (err) {
    res.status(500).json({ error: 'Помилка завантаження користувачів' });
  }
});

// Історія приватного чату
app.get('/api/messages/:targetUser', requireAuth, async (req, res) => {
  try {
    const currentUser = req.user.username;
    const targetUser = req.params.targetUser;

    const history = await PrivateMessage.find({
      $or: [
        { sender: currentUser, recipient: targetUser },
        { sender: targetUser, recipient: currentUser }
      ]
    }).sort({ createdAt: 1 });

    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Помилка завантаження історії' });
  }
});

// ==========================================
// --- SOCKET.IO МІДЛВЕР ТА ОБРОБКА З'ЄДНАНЬ ---
// ==========================================

io.use((socket, next) => {
  const reqCookies = socket.handshake.headers.cookie;
  if (!reqCookies) return next(new Error('Auth error'));

  const tokenCookie = reqCookies.split(';').find(c => c.trim().startsWith('token='));
  if (!tokenCookie) return next(new Error('Auth error'));

  // Надійне витягування токена без split('=')
  const token = tokenCookie.trim().substring(6);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error('Auth error'));
  }
});

io.on('connection', async (socket) => {
  const username = socket.user.username;
  console.log(`Користувач ${username} підключився (Socket ID: ${socket.id})`);

  socket.join(username);

  // Фіксація з'єднання у Map для підтримки кількох вкладок
  if (!onlineUsers.has(username)) {
    onlineUsers.set(username, new Set());
  }
  onlineUsers.get(username).add(socket.id);

  // Сповіщаємо про актуальний список користувачів онлайн
  io.emit('onlineUsers', Array.from(onlineUsers.keys()));

  // Відправка історії загального чату
  try {
    const history = await Message.find().sort({ createdAt: 1 }).limit(50);
    socket.emit('chatHistory', history);
  } catch (err) {
    console.error('Помилка завантаження історії:', err);
  }

  // Загальне повідомлення
  socket.on('chatMessage', async (data) => {
    try {
      if (!data.text?.trim()) return;

      const newMessage = new Message({
        user: username,
        text: data.text
      });
      await newMessage.save();

      io.emit('chatMessage', { user: username, text: data.text });
    } catch (err) {
      console.error('Помилка збереження повідомлення:', err);
    }
  });

  // Приватне повідомлення
  socket.on('privateMessage', async (data) => {
    try {
      const { recipient, text } = data;
      if (!recipient || !text?.trim()) return;

      const newMsg = new PrivateMessage({
        sender: username,
        recipient: recipient,
        text: text
      });
      await newMsg.save();

      const messageData = {
        sender: username,
        recipient: recipient,
        text: text,
        createdAt: newMsg.createdAt
      };

      // Надсилаємо отримувачу в його кімнату
      io.to(recipient).emit('privateMessage', messageData);

      // Надсилаємо відправнику в його кімнату (синхронізує всі його відкриті вкладки)
      io.to(username).emit('privateMessage', messageData);
    } catch (err) {
      console.error('Помилка приватного повідомлення:', err);
    }
  });

  // Індикатор друкування
  socket.on('typing', (data) => {
    if (data.recipient === 'general') {
      socket.broadcast.emit('typing', { sender: username, recipient: 'general' });
    } else {
      io.to(data.recipient).emit('typing', { sender: username, recipient: data.recipient });
    }
  });

  socket.on('stopTyping', (data) => {
    if (data.recipient === 'general') {
      socket.broadcast.emit('stopTyping', { sender: username, recipient: 'general' });
    } else {
      io.to(data.recipient).emit('stopTyping', { sender: username, recipient: data.recipient });
    }
  });

  // Відключення користувача
  socket.on('disconnect', () => {
    console.log(`Користувач ${username} відключився (Socket ID: ${socket.id})`);

    const userSockets = onlineUsers.get(username);
    if (userSockets) {
      userSockets.delete(socket.id);
      // Видаляємо юзера з онлайну тільки якщо закрито ВСІ його вкладки
      if (userSockets.size === 0) {
        onlineUsers.delete(username);
      }
    }

    io.emit('onlineUsers', Array.from(onlineUsers.keys()));
  });
});

// --- ЗАПУСК СЕРВЕРА ---

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