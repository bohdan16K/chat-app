const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 1. Підключення до MongoDB Atlas
const MONGO_URI = process.env.MONGO_URI;

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('Успішно підключено до MongoDB'))
    .catch((err) => console.error('Помилка підключення до MongoDB:', err));
} else {
  console.warn('УВАГА: MONGO_URI не вказано в змінних середовища!');
}

// 2. Схема та модель повідомлення
const messageSchema = new mongoose.Schema({
  user: String,
  text: String,
  createdAt: { type: Date, default: Date.now }
});

const Message = mongoose.model('Message', messageSchema);

app.use(express.static('public'));

io.on('connection', async (socket) => {
  console.log('Користувач підключився');

  // 3. Завантаження та відправка історії повідомлень новому користувачеві
  try {
    const history = await Message.find().sort({ createdAt: 1 }).limit(50);
    socket.emit('chat history', history);
  } catch (err) {
    console.error('Помилка завантаження історії:', err);
  }

  // 4. Обробка та збереження нового повідомлення
  socket.on('chat message', async (msg) => {
    try {
      // Зберігаємо в базі даних
      const newMessage = new Message({ user: data.user, text: data.text });
      await newMessage.save();

      // Розсилаємо усім підключеним клієнтам
      io.emit('chat message', data);
    } catch (err) {
      console.error('Помилка збереження повідомлення:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('Користувач відключився');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});