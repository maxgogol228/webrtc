// WebRTC конфигурация с бесплатными STUN серверами
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// Глобальные переменные
let socket;
let localStream;
let peerConnections = new Map();
let isMicOn = true;
let isCameraOn = true;
let currentRoomCode;

// DOM элементы
const loginScreen = document.getElementById('login-screen');
const roomScreen = document.getElementById('room-screen');
const joinForm = document.getElementById('join-form');
const errorMessage = document.getElementById('error-message');
const videosGrid = document.getElementById('videos-grid');
const localVideo = document.getElementById('local-video');
const connectionStatus = document.getElementById('connection-status');
const currentRoomSpan = document.getElementById('current-room');
const leaveBtn = document.getElementById('leave-btn');
const toggleMicBtn = document.getElementById('toggle-mic');
const toggleCameraBtn = document.getElementById('toggle-camera');

// Подключение к серверу
function connectToServer() {
    socket = io({
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
    });

    socket.on('connect', () => {
        updateConnectionStatus('Подключено к серверу', 'connected');
    });

    socket.on('disconnect', () => {
        updateConnectionStatus('Потеряно соединение с сервером', 'disconnected');
    });

    socket.on('reconnecting', () => {
        updateConnectionStatus('Переподключение...', 'reconnecting');
    });

    socket.on('error', (message) => {
        showError(message);
    });

    socket.on('room-full', (message) => {
        showError(message);
        socket.emit('leave-room');
        showLoginScreen();
    });

    // Обработчики WebRTC сигналов
    socket.on('room-users', (users) => {
        users.forEach(user => {
            if (user.id !== socket.id) {
                createPeerConnection(user.id);
                createOffer(user.id);
            }
        });
    });

    socket.on('user-joined', (user) => {
        createPeerConnection(user.id);
        createOffer(user.id);
    });

    socket.on('offer', async (data) => {
        if (!peerConnections.has(data.sender)) {
            createPeerConnection(data.sender);
        }
        const pc = peerConnections.get(data.sender);
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', {
            target: data.sender,
            answer: answer
        });
    });

    socket.on('answer', async (data) => {
        const pc = peerConnections.get(data.sender);
        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
    });

    socket.on('ice-candidate', async (data) => {
        const pc = peerConnections.get(data.sender);
        if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
    });

    socket.on('user-left', (user) => {
        removePeerConnection(user.id);
    });
}

// Создание пир-коннекшн
function createPeerConnection(userId) {
    if (peerConnections.has(userId)) return;

    const pc = new RTCPeerConnection(configuration);
    peerConnections.set(userId, pc);

    // Добавляем локальный стрим
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    // Обработчик получения удалённого стрима
    pc.ontrack = (event) => {
        const remoteVideo = createRemoteVideo(userId);
        remoteVideo.srcObject = event.streams[0];
    };

    // Обработчик ICE кандидатов
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: userId,
                candidate: event.candidate
            });
        }
    };

    // Обработчик состояния подключения
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'disconnected' || 
            pc.connectionState === 'failed') {
            removePeerConnection(userId);
        }
    };

    return pc;
}

// Создание оффера
async function createOffer(userId) {
    const pc = peerConnections.get(userId);
    if (!pc) return;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', {
        target: userId,
        offer: offer
    });
}

// Удаление пир-коннекшн
function removePeerConnection(userId) {
    const pc = peerConnections.get(userId);
    if (pc) {
        pc.close();
        peerConnections.delete(userId);
    }
    removeRemoteVideo(userId);
}

// Создание элемента удалённого видео
function createRemoteVideo(userId) {
    const existingVideo = document.getElementById(`remote-${userId}`);
    if (existingVideo) return existingVideo;

    const videoWrapper = document.createElement('div');
    videoWrapper.className = 'video-wrapper';
    videoWrapper.id = `wrapper-${userId}`;

    const video = document.createElement('video');
    video.id = `remote-${userId}`;
    video.autoplay = true;
    video.playsinline = true;
    
    const label = document.createElement('div');
    label.className = 'video-label';
    label.textContent = 'Участник';

    videoWrapper.appendChild(video);
    videoWrapper.appendChild(label);
    videosGrid.appendChild(videoWrapper);

    return video;
}

// Удаление элемента удалённого видео
function removeRemoteVideo(userId) {
    const wrapper = document.getElementById(`wrapper-${userId}`);
    if (wrapper) {
        wrapper.remove();
    }
}

// Получение локального стрима
async function startLocalStream() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 640 },
                height: { ideal: 480 },
                frameRate: { ideal: 24 }
            },
            audio: true
        });
        localVideo.srcObject = localStream;
        updateConnectionStatus('Камера и микрофон подключены', 'connected');
    } catch (error) {
        console.error('Ошибка доступа к медиа:', error);
        if (error.name === 'NotAllowedError') {
            updateConnectionStatus('Доступ к камере/микрофону запрещён. Проверьте настройки браузера.', 'error');
        } else if (error.name === 'NotFoundError') {
            updateConnectionStatus('Камера или микрофон не найдены', 'error');
        } else {
            updateConnectionStatus('Ошибка доступа к медиаустройствам', 'error');
        }
    }
}

// Присоединение к комнате
function joinRoom(roomCode, username) {
    currentRoomCode = roomCode;
    currentRoomSpan.textContent = roomCode;
    
    socket.emit('join-room', {
        roomCode: roomCode,
        username: username
    });

    showRoomScreen();
}

// Управление микрофоном
toggleMicBtn.addEventListener('click', () => {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            isMicOn = !isMicOn;
            audioTrack.enabled = isMicOn;
            toggleMicBtn.textContent = isMicOn ? '🎤' : '🔇';
            toggleMicBtn.className = `control-btn ${isMicOn ? 'mic-on' : 'mic-off'}`;
        }
    }
});

// Управление камерой
toggleCameraBtn.addEventListener('click', () => {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            isCameraOn = !isCameraOn;
            videoTrack.enabled = isCameraOn;
            toggleCameraBtn.textContent = isCameraOn ? '📹' : '📷';
            toggleCameraBtn.className = `control-btn ${isCameraOn ? 'camera-on' : 'camera-off'}`;
        }
    }
});

// UI функции
function showLoginScreen() {
    loginScreen.style.display = 'block';
    roomScreen.style.display = 'none';
    // Очищаем форму
    joinForm.reset();
    errorMessage.style.display = 'none';
}

function showRoomScreen() {
    loginScreen.style.display = 'none';
    roomScreen.style.display = 'block';
    updateConnectionStatus('Подключение к комнате...', 'connecting');
}

function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    setTimeout(() => {
        errorMessage.style.display = 'none';
    }, 5000);
}

function updateConnectionStatus(message, type) {
    connectionStatus.textContent = message;
    connectionStatus.className = 'connection-status';
    
    switch(type) {
        case 'connected':
            connectionStatus.style.background = 'rgba(46, 213, 115, 0.3)';
            break;
        case 'disconnected':
            connectionStatus.style.background = 'rgba(255, 71, 87, 0.3)';
            break;
        case 'reconnecting':
        case 'connecting':
            connectionStatus.style.background = 'rgba(255, 165, 2, 0.3)';
            break;
        case 'error':
            connectionStatus.style.background = 'rgba(255, 71, 87, 0.3)';
            break;
    }
}

// Обработчик формы
joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = document.getElementById('username').value.trim();
    const roomCode = document.getElementById('room-code').value.trim().toLowerCase();
    
    // Базовая валидация на клиенте
    if (!username || !roomCode) {
        showError('Заполните все поля');
        return;
    }
    
    if (username.length < 2) {
        showError('Имя должно быть минимум 2 символа');
        return;
    }
    
    if (!/^[a-zA-Z0-9_-]+$/.test(roomCode)) {
        showError('Код комнаты может содержать только буквы, цифры, тире и подчеркивания');
        return;
    }

    // Запускаем локальный стрим
    if (!localStream) {
        await startLocalStream();
    }
    
    joinRoom(roomCode, username);
});

// Кнопка выхода
leaveBtn.addEventListener('click', () => {
    // Закрываем все пир-коннекшны
    peerConnections.forEach((pc, userId) => {
        removePeerConnection(userId);
    });
    
    // Останавливаем локальный стрим
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    // Отключаемся от сервера
    if (socket) {
        socket.disconnect();
    }
    
    // Очищаем видео
    while (videosGrid.children.length > 1) {
        videosGrid.lastChild.remove();
    }
    localVideo.srcObject = null;
    
    showLoginScreen();
    connectToServer();
});

// Инициализация
connectToServer();