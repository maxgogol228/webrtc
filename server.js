const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Rate limiting для защиты от DoS
const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 час
    max: 100, // максимум 100 запросов в час
    message: 'Слишком много запросов, попробуйте позже',
    standardHeaders: true,
    legacyHeaders: false,
});

// Применяем rate limiter ко всем запросам
app.use(limiter);

// Дополнительный лимит для сокетов
const socketRateLimit = new Map();
const SOCKET_LIMIT = 50; // максимум подключений с IP в час
const SOCKET_WINDOW = 60 * 60 * 1000; // 1 час

// Раздаём статику
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище комнат (в памяти)
const rooms = new Map();

io.on('connection', (socket) => {
    // Проверка rate limit для сокетов
    const clientIP = socket.handshake.address;
    const now = Date.now();
    
    if (!socketRateLimit.has(clientIP)) {
        socketRateLimit.set(clientIP, { count: 0, resetTime: now + SOCKET_WINDOW });
    }
    
    const clientLimit = socketRateLimit.get(clientIP);
    if (clientLimit.count >= SOCKET_LIMIT) {
        socket.emit('error', 'Превышен лимит подключений. Попробуйте позже.');
        socket.disconnect();
        return;
    }
    clientLimit.count++;

    // В server.js, внутри io.on('connection', ...) добавь:
    socket.on('get-username', (userId) => {
        // Ищем пользователя в комнате
        for (const [roomCode, room] of rooms) {
            const user = room.users.get(userId);
            if (user) {
                socket.emit('username', { id: userId, username: user.username });
                break;
            }
        }
    });
    socket.on('chat-message', (data) => {
        const { roomCode, username, message } = data;
        // Отправляем всем в комнате кроме отправителя
        socket.to(roomCode).emit('chat-message', { username, message });
    });

    // Очистка старых записей
    if (now > clientLimit.resetTime) {
        clientLimit.count = 1;
        clientLimit.resetTime = now + SOCKET_WINDOW;
    }

    console.log(`Пользователь подключился: ${socket.id}`);

    socket.on('join-room', (data) => {
        const { roomCode, username } = data;
        socket.to(roomCode).emit('user-joined', {
            id: socket.id,
            username
        });
        
        // Валидация входных данных
        if (!roomCode || !username || 
            roomCode.length > 20 || username.length > 30 ||
            !/^[a-zA-Z0-9_-]+$/.test(roomCode)) {
            socket.emit('error', 'Некорректные данные комнаты или имени');
            return;
        }

        // Покидаем предыдущую комнату если есть
        if (socket.currentRoom) {
            leaveRoom(socket, socket.currentRoom);
        }

        // Присоединяемся к комнате
        socket.join(roomCode);
        socket.currentRoom = roomCode;
        socket.username = username;

        // Создаём или получаем комнату
        if (!rooms.has(roomCode)) {
            rooms.set(roomCode, {
                users: new Map(),
                createdAt: Date.now()
            });
            console.log(`Комната ${roomCode} создана`);
        }

        const room = rooms.get(roomCode);
        
        // Проверка количества пользователей (максимум 4)
        if (room.users.size >= 4) {
            socket.emit('room-full', 'Комната заполнена (максимум 4 человека)');
            socket.leave(roomCode);
            return;
        }

        // Добавляем пользователя в комнату
        room.users.set(socket.id, { username, joinedAt: Date.now() });

        // Отправляем текущему пользователю список всех участников
        const usersList = Array.from(room.users.entries()).map(([id, user]) => ({
            id,
            username: user.username
        }));
        
        socket.emit('room-users', usersList);

        // Уведомляем остальных о новом пользователе
        socket.to(roomCode).emit('user-joined', {
            id: socket.id,
            username
        });

        console.log(`${username} присоединился к комнате ${roomCode}`);
    });

    // WebRTC сигналинг
    socket.on('offer', (data) => {
        io.to(data.target).emit('offer', {
            offer: data.offer,
            sender: socket.id,
            username: socket.username
        });
    });

    socket.on('answer', (data) => {
        io.to(data.target).emit('answer', {
            answer: data.answer,
            sender: socket.id
        });
    });

    socket.on('ice-candidate', (data) => {
        io.to(data.target).emit('ice-candidate', {
            candidate: data.candidate,
            sender: socket.id
        });
    });

    // Отключение
    socket.on('disconnect', () => {
        console.log(`Пользователь отключился: ${socket.id}`);
        if (socket.currentRoom) {
            leaveRoom(socket, socket.currentRoom);
        }
    });

    // Обработка ошибок
    socket.on('error', (error) => {
        console.error('Socket error:', error);
    });
});

function leaveRoom(socket, roomCode) {
    socket.leave(roomCode);
    
    if (rooms.has(roomCode)) {
        const room = rooms.get(roomCode);
        room.users.delete(socket.id);
        
        // Уведомляем остальных
        socket.to(roomCode).emit('user-left', {
            id: socket.id,
            username: socket.username
        });

        // Если комната пуста и создана больше часа назад - удаляем
        if (room.users.size === 0) {
            const roomAge = Date.now() - room.createdAt;
            if (roomAge > 3600000) { // 1 час
                rooms.delete(roomCode);
                console.log(`Комната ${roomCode} удалена (пустая)`);
            }
        }
    }
}

// Периодическая очистка старых комнат
setInterval(() => {
    const now = Date.now();
    for (const [roomCode, room] of rooms.entries()) {
        const roomAge = now - room.createdAt;
        if (room.users.size === 0 && roomAge > 3600000) {
            rooms.delete(roomCode);
            console.log(`Комната ${roomCode} удалена при очистке`);
        }
    }
}, 600000); // Каждые 10 минут

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
