const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookie = require('cookie');

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


// --- REST API МАРШРУТИ АВТОРИЗАЦІЇ ---

// Реєстрація
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

    res.status(201).json({ success: true, message: 'Успішно зареєстровано' });
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

    // Термін дії: 30 днів (з прапором) або 1 день
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

// Автоматична перевірка сесії при перезавантаженні сторінки
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


// --- SOCKET.IO МІДЛВЕР ТА ОБРОБКА З'ЄДНАНЬ ---

// Авторизація Socket.IO через HTTP-only Cookie
io.use((socket, next) => {
  const reqCookies = socket.handshake.headers.cookie;
  if (!reqCookies) return next(new Error('Auth error'));

  const parsedCookies = cookie.parse(reqCookies);
  const token = parsedCookies.token;
  if (!token) return next(new Error('Auth error'));

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded; // Передаємо дані про юзера в сокет
    next();
  } catch (err) {
    next(new Error('Auth error'));
  }
});

io.on('connection', async (socket) => {
  console.log(`Користувач ${socket.user.username} підключився`);

  // Відправка історії
  try {
    const history = await Message.find().sort({ createdAt: 1 }).limit(50);
    socket.emit('chatHistory', history);
  } catch (err) {
    console.error('Помилка завантаження історії:', err);
  }

  // Нове повідомлення (ім'я береться напряму з токена сокета)
  socket.on('chatMessage', async (data) => {
    try {
      const newMessage = new Message({
        user: socket.user.username,
        text: data.text
      });
      await newMessage.save();

      io.emit('chatMessage', { user: socket.user.username, text: data.text });
    } catch (err) {
      console.error('Помилка збереження повідомлення:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Користувач ${socket.user.username} відключився`);
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
  }
}

start();