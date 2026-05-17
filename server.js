const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 100,
    message: 'Too many requests',
    standardHeaders: true,
    legacyHeaders: false,
});

app.use(limiter);
app.use(express.static(path.join(__dirname, 'public')));

const socketRateLimit = new Map();
const SOCKET_LIMIT = 50;
const SOCKET_WINDOW = 60 * 60 * 1000;

const rooms = new Map();

io.on('connection', (socket) => {
    const clientIP = socket.handshake.address;
    const now = Date.now();
    
    if (!socketRateLimit.has(clientIP)) {
        socketRateLimit.set(clientIP, { count: 0, resetTime: now + SOCKET_WINDOW });
    }
    
    const clientLimit = socketRateLimit.get(clientIP);
    if (clientLimit.count >= SOCKET_LIMIT) {
        socket.emit('error', 'Rate limit exceeded');
        socket.disconnect();
        return;
    }
    clientLimit.count++;
    if (now > clientLimit.resetTime) {
        clientLimit.count = 1;
        clientLimit.resetTime = now + SOCKET_WINDOW;
    }

    console.log(`Connected: ${socket.id}`);

    socket.on('join-room', (data) => {
        const { roomCode, username } = data;
        
        if (!roomCode || !username || 
            roomCode.length > 20 || username.length > 30 ||
            !/^[a-zA-Z0-9_-]+$/.test(roomCode)) {
            socket.emit('error', 'Invalid data');
            return;
        }

        if (socket.currentRoom) {
            leaveRoom(socket, socket.currentRoom);
        }

        socket.join(roomCode);
        socket.currentRoom = roomCode;
        socket.username = username;

        if (!rooms.has(roomCode)) {
            rooms.set(roomCode, { users: new Map(), createdAt: Date.now() });
            console.log(`Room ${roomCode} created`);
        }

        const room = rooms.get(roomCode);
        
        if (room.users.size >= 4) {
            socket.emit('room-full', 'Room is full (max 4)');
            socket.leave(roomCode);
            return;
        }

        room.users.set(socket.id, { username, joinedAt: Date.now() });

        // Отправляем новому пользователю список всех в комнате
        const usersList = Array.from(room.users.entries()).map(([id, user]) => ({
            id,
            username: user.username
        }));
        
        socket.emit('room-users', usersList);

        // Уведомляем остальных
        socket.to(roomCode).emit('user-joined', {
            id: socket.id,
            username
        });

        console.log(`${username} joined room ${roomCode}`);
    });

    socket.on('offer', (data) => {
        socket.to(data.target).emit('offer', {
            offer: data.offer,
            sender: socket.id,
            username: socket.username
        });
    });

    socket.on('answer', (data) => {
        socket.to(data.target).emit('answer', {
            answer: data.answer,
            sender: socket.id
        });
    });

    socket.on('ice-candidate', (data) => {
        socket.to(data.target).emit('ice-candidate', {
            candidate: data.candidate,
            sender: socket.id
        });
    });

    socket.on('chat-message', (data) => {
        socket.to(data.roomCode).emit('chat-message', {
            username: data.username,
            message: data.message
        });
    });

    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        if (socket.currentRoom) {
            leaveRoom(socket, socket.currentRoom);
        }
    });

    socket.on('error', (error) => {
        console.error('Socket error:', error);
    });
});

function leaveRoom(socket, roomCode) {
    socket.leave(roomCode);
    
    if (rooms.has(roomCode)) {
        const room = rooms.get(roomCode);
        room.users.delete(socket.id);
        
        socket.to(roomCode).emit('user-left', {
            id: socket.id,
            username: socket.username
        });

        if (room.users.size === 0) {
            const roomAge = Date.now() - room.createdAt;
            if (roomAge > 3600000) {
                rooms.delete(roomCode);
                console.log(`Room ${roomCode} deleted`);
            }
        }
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [roomCode, room] of rooms.entries()) {
        if (room.users.size === 0 && (now - room.createdAt) > 3600000) {
            rooms.delete(roomCode);
        }
    }
}, 600000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
