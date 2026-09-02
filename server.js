const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Віддаємо статичні файли з папки public
app.use(express.static('public'));

io.on('connection', (socket) => {
  console.log('Користувач підключився');

  // Слухаємо подію відправки повідомлення від клієнта
  socket.on('chatMessage', (data) => {
    // Пересилаємо повідомлення усім підключеним користувачам
    io.emit('chatMessage', data);
  });

  socket.on('disconnect', () => {
    console.log('Користувач відключився');
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Сервер запущено на порту ${PORT}`);
});