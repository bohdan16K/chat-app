(() => {
  'use strict';

  // --- Константи ---
  const TYPING_STOP_DELAY = 1500;   // через скільки мс бездіяльності надсилаємо stopTyping
  const TYPING_EMIT_INTERVAL = 1000; // не частіше ніж раз на секунду надсилаємо typing
  const TYPING_EXPIRE = 3500;       // страховка: прибрати індикатор, якщо stopTyping загубився
  const GENERAL_HISTORY_CAP = 200;
  const BASE_TITLE = 'Real-Time Chat';

  // --- Стан ---
  let socket = null;
  let currentUser = null;
  let activeChat = 'general';
  let users = [];
  let generalHistory = [];
  let sessionStarted = false;
  let typingChat = null;
  let typingStopTimer = null;
  let lastTypingEmit = 0;
  let toastTimer = null;

  const unreadCounts = {};
  const onlineUsersSet = new Set();
  const typingMap = new Map(); // "chat|sender" -> { chat, sender, timer }

  // --- DOM ---
  const $ = (id) => document.getElementById(id);
  const authForm = $('authForm');
  const authUsername = $('authUsername');
  const authPassword = $('authPassword');
  const authError = $('authError');
  const rememberMe = $('rememberMe');
  const loginBtn = $('loginBtn');
  const registerBtn = $('registerBtn');
  const logoutBtn = $('logoutBtn');
  const chatContainer = $('chatContainer');
  const userDisplay = $('userDisplay');
  const generalChatBtn = $('generalChatBtn');
  const generalBadge = $('badge-general');
  const usersList = $('usersList');
  const chatTitle = $('chatTitle');
  const backBtn = $('backBtn');
  const messages = $('messages');
  const typingIndicator = $('typingIndicator');
  const chatForm = $('chatForm');
  const messageInput = $('messageInput');
  const toast = $('toast');

  // --- Утиліти ---
  async function api(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      /* порожня або не-JSON відповідь */
    }
    return { ok: res.ok, data };
  }

  function showToast(text) {
    toast.textContent = text;
    toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
  }

  function formatTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  }

  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

  // --- Авторизація ---
  function showAuthError(text) {
    authError.textContent = text;
    authError.classList.toggle('hidden', !text);
  }

  function setAuthBusy(busy) {
    loginBtn.disabled = busy;
    registerBtn.disabled = busy;
  }

  async function authRequest(kind) {
    const username = authUsername.value.trim();
    const password = authPassword.value; // пароль не обрізаємо
    if (!username || !password) return showAuthError('Заповніть усі поля!');

    showAuthError('');
    setAuthBusy(true);
    try {
      const { ok, data } = await api(`/api/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ username, password, rememberMe: rememberMe.checked })
      });
      if (ok && data.success) {
        authPassword.value = '';
        startChatSession(data.username); // після реєстрації сервер теж видає cookie
      } else {
        showAuthError(data.error || 'Сталася помилка');
      }
    } catch {
      showAuthError('Немає зв\u2019язку з сервером');
    } finally {
      setAuthBusy(false);
    }
  }

  authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    authRequest('login');
  });
  registerBtn.addEventListener('click', () => authRequest('register'));

  logoutBtn.addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
    } finally {
      window.location.reload();
    }
  });

  // --- Повідомлення ---
  function createMessageEl({ author, text, createdAt }, showAuthor) {
    const isSelf = author === currentUser;
    const el = document.createElement('div');
    el.className = `message ${isSelf ? 'sent' : 'received'}`;

    if (!isSelf && showAuthor) {
      const authorEl = document.createElement('span');
      authorEl.className = 'author';
      authorEl.textContent = author;
      el.appendChild(authorEl);
    }

    const textEl = document.createElement('div');
    textEl.className = 'text';
    textEl.textContent = text; // textContent — захист від XSS
    el.appendChild(textEl);

    const time = formatTime(createdAt);
    if (time) {
      const timeEl = document.createElement('span');
      timeEl.className = 'time';
      timeEl.textContent = time;
      el.appendChild(timeEl);
    }
    return el;
  }

  function isNearBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 120;
  }

  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }

  function renderMessages(items) {
    const showAuthor = activeChat === 'general';
    const fragment = document.createDocumentFragment();
    items.forEach((item) => fragment.appendChild(createMessageEl(item, showAuthor)));
    messages.replaceChildren(fragment);
    scrollToBottom();
  }

  function appendMessage(item) {
    const stick = isNearBottom() || item.author === currentUser;
    messages.appendChild(createMessageEl(item, activeChat === 'general'));
    if (stick) scrollToBottom();
  }

  function renderGeneralHistory() {
    renderMessages(
      generalHistory.map((m) => ({ author: m.user, text: m.text, createdAt: m.createdAt }))
    );
  }

  async function loadPrivateHistory(target) {
    try {
      const { ok, data } = await api(`/api/messages/${encodeURIComponent(target)}`);
      if (activeChat !== target) return; // користувач уже перейшов в інший чат
      if (!ok) throw new Error(data.error || 'history error');
      renderMessages(
        data.map((m) => ({ author: m.sender, text: m.text, createdAt: m.createdAt }))
      );
    } catch (err) {
      console.error('Помилка завантаження історії:', err);
      showToast('Не вдалося завантажити історію');
    }
  }

  // --- Список користувачів ---
  function renderUsers() {
    const sorted = [...users].sort(
      (a, b) =>
        Number(onlineUsersSet.has(b)) - Number(onlineUsersSet.has(a)) || a.localeCompare(b, 'uk')
    );

    const fragment = document.createDocumentFragment();
    sorted.forEach((name) => {
      const item = document.createElement('div');
      item.className = 'user-item' + (activeChat === name ? ' active' : '');
      item.dataset.username = name;
      item.setAttribute('role', 'button');
      item.tabIndex = 0;

      const dot = document.createElement('span');
      dot.className = 'status-dot' + (onlineUsersSet.has(name) ? ' online' : '');

      const label = document.createElement('span');
      label.textContent = name;

      const count = unreadCounts[name] || 0;
      const badge = document.createElement('span');
      badge.className = 'unread-badge' + (count > 0 ? '' : ' hidden');
      badge.textContent = count;

      item.append(dot, label, badge);
      item.addEventListener('click', () => switchChat(name));
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          switchChat(name);
        }
      });
      fragment.appendChild(item);
    });
    usersList.replaceChildren(fragment);
  }

  function addUser(name) {
    if (!name || name === currentUser || users.includes(name)) return;
    users.push(name);
    renderUsers();
  }

  async function loadUsers() {
    try {
      const { ok, data } = await api('/api/users');
      if (!ok) return;
      users = data.map((u) => u.username).filter((name) => name !== currentUser);
      renderUsers();
    } catch (err) {
      console.error('Помилка завантаження користувачів:', err);
    }
  }

  // --- Непрочитані ---
  function updateGeneralBadge() {
    const count = unreadCounts.general || 0;
    generalBadge.textContent = count;
    generalBadge.classList.toggle('hidden', count === 0);
  }

  function updateDocumentTitle() {
    const total = Object.values(unreadCounts).reduce((sum, n) => sum + n, 0);
    document.title = total > 0 ? `(${total}) ${BASE_TITLE}` : BASE_TITLE;
  }

  function incrementUnread(chatId) {
    unreadCounts[chatId] = (unreadCounts[chatId] || 0) + 1;
    if (chatId === 'general') updateGeneralBadge();
    else renderUsers();
    updateDocumentTitle();
  }

  // --- Перемикання чатів ---
  function switchChat(target) {
    if (typingChat) stopTypingNow();

    activeChat = target;
    unreadCounts[target] = 0;

    generalChatBtn.classList.toggle('active', target === 'general');
    updateGeneralBadge();
    updateDocumentTitle();
    renderUsers();
    updateTypingDisplay();

    messages.replaceChildren();
    if (target === 'general') {
      chatTitle.textContent = '📢 Загальний чат';
      renderGeneralHistory();
    } else {
      chatTitle.textContent = `💬 Приватний чат з ${target}`;
      loadPrivateHistory(target);
    }

    $('chatContainer').classList.add('mobile-chat-open');
    if (!isMobile()) messageInput.focus();
  }

  generalChatBtn.addEventListener('click', () => switchChat('general'));
  generalChatBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      switchChat('general');
    }
  });
  backBtn.addEventListener('click', () => chatContainer.classList.remove('mobile-chat-open'));

  // --- Індикатор друкування ---
  function setTyping(chat, sender) {
    const key = `${chat}|${sender}`;
    const existing = typingMap.get(key);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      typingMap.delete(key); 
      updateTypingDisplay();
    }, TYPING_EXPIRE);
    typingMap.set(key, { chat, sender, timer });
  }

  function clearTyping(chat, sender) {
    const key = `${chat}|${sender}`;
    const existing = typingMap.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      typingMap.delete(key);
    }
  }

  function updateTypingDisplay() {
    const names = [...typingMap.values()].filter((t) => t.chat === activeChat).map((t) => t.sender);

    if (names.length === 0) {
      typingIndicator.classList.add('hidden');
      return;
    }

    let text;
    if (names.length === 1) text = `${names[0]} друкує...`;
    else if (names.length === 2) text = `${names[0]}, ${names[1]} друкують...`;
    else text = 'Кілька людей друкують...';

    typingIndicator.textContent = text;
    typingIndicator.classList.remove('hidden');
  }

  function stopTypingNow() {
    clearTimeout(typingStopTimer);
    lastTypingEmit = 0;
    if (socket && typingChat) {
      socket.emit('stopTyping', { recipient: typingChat });
    }
    typingChat = null;
  }

  messageInput.addEventListener('input', () => {
    if (!socket) return;

    const now = Date.now();
    if (now - lastTypingEmit > TYPING_EMIT_INTERVAL) {
      typingChat = activeChat;
      socket.emit('typing', { recipient: typingChat });
      lastTypingEmit = now;
    }

    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(stopTypingNow, TYPING_STOP_DELAY);
  });

  // --- Відправка ---
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!socket) return;

    const text = messageInput.value.trim();
    if (!text) return;

    if (activeChat === 'general') {
      socket.emit('chatMessage', { text });
    } else {
      socket.emit('privateMessage', { recipient: activeChat, text });
    }

    stopTypingNow();
    messageInput.value = '';
    messageInput.focus();
  });

  // --- Socket.IO ---
  function startChatSession(username) {
    if (sessionStarted) return;
    sessionStarted = true;

    currentUser = username;
    authForm.classList.add('hidden');
    chatContainer.classList.remove('hidden');
    userDisplay.textContent = username;

    socket = io();

    // Спрацьовує і при першому підключенні, і при перепідключенні
    socket.on('connect', () => {
      loadUsers();
      if (activeChat !== 'general') loadPrivateHistory(activeChat);
    });

    socket.on('connect_error', (err) => {
      if (err && err.message === 'Auth error') window.location.reload();
    });

    socket.on('chatHistory', (history) => {
      generalHistory = history;
      if (activeChat === 'general') renderGeneralHistory();
    });

    socket.on('chatMessage', (data) => {
      generalHistory.push(data);
      if (generalHistory.length > GENERAL_HISTORY_CAP) generalHistory.shift();
      clearTyping('general', data.user);

      if (activeChat === 'general') {
        appendMessage({ author: data.user, text: data.text, createdAt: data.createdAt });
        updateTypingDisplay();
      } else if (data.user !== currentUser) {
        incrementUnread('general');
      }
    });

    socket.on('privateMessage', (msg) => {
      const peer = msg.sender === currentUser ? msg.recipient : msg.sender;
      clearTyping(peer, msg.sender);

      if (activeChat === peer) {
        appendMessage({ author: msg.sender, text: msg.text, createdAt: msg.createdAt });
        updateTypingDisplay();
      } else if (msg.sender !== currentUser) {
        addUser(peer); // повідомлення від користувача, якого ще немає у списку
        incrementUnread(peer);
      }
    });

    socket.on('onlineUsers', (list) => {
      onlineUsersSet.clear();
      list.forEach((name) => onlineUsersSet.add(name));
      renderUsers();
    });

    socket.on('userRegistered', ({ username: name }) => addUser(name));

    socket.on('typing', (data) => {
      const chat = data.recipient === 'general' ? 'general' : data.sender;
      setTyping(chat, data.sender);
      updateTypingDisplay();
    });

    socket.on('stopTyping', (data) => {
      const chat = data.recipient === 'general' ? 'general' : data.sender;
      clearTyping(chat, data.sender);
      updateTypingDisplay();
    });

    socket.on('errorMessage', showToast);
  }

  // --- Перевірка сесії при завантаженні ---
  (async () => {
    try {
      const { ok, data } = await api('/api/me');
      if (ok && data.authenticated) startChatSession(data.username);
    } catch (err) {
      console.error('Помилка перевірки сесії:', err);
    }
  })();
})();