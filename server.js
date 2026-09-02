const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 1. Схема та модель повідомлення
const messageSchema = new mongoose.Schema({
  user: String,
  text: String,
  createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

app.use(express.static('public'));

// 2. Обробка з'єднань Socket.IO
io.on('connection', async (socket) => {
  console.log('Користувач підключився');

  // Відправка історії повідомлень
  try {
    const history = await Message.find().sort({ createdAt: 1 }).limit(50);
    socket.emit('chatHistory', history);
  } catch (err) {
    console.error('Помилка завантаження історії з БД:', err);
  }

  // Прийом нового повідомлення від клієнта
  socket.on('chatMessage', async (data) => {
    try {
      const newMessage = new Message({ user: data.user, text: data.text });
      await newMessage.save();

      // Розсилка всім підключеним клієнтам
      io.emit('chatMessage', data);
    } catch (err) {
      console.error('Помилка збереження повідомлення:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('Користувач відключився');
  });
});

// 3. Асинхронне підключення до БД та запуск сервера
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

async function start() {
  try {
    if (!MONGO_URI) {
      throw new Error('MONGO_URI не вказано в змінних середовища Render!');
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