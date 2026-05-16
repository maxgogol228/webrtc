const pcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

let socket;
let localStream;
let screenStream;
let peers = new Map();
let micOn = true;
let camOn = true;
let screenOn = false;
let roomCode;
let username;
let usersMap = new Map(); // id -> {username}

// DOM
const $ = id => document.getElementById(id);
const loginScreen = $('login-screen');
const roomScreen = $('room-screen');
const usernameInput = $('username');
const roomInput = $('room-code');
const joinBtn = $('join-btn');
const errorText = $('error-text');
const roomLabel = $('room-label');
const videosDiv = $('videos');
const localContainer = $('local-container');
const localVideo = $('local-video');
const localName = $('local-name');
const statusDiv = $('status');
const micBtn = $('mic-btn');
const camBtn = $('cam-btn');
const screenBtn = $('screen-btn');
const leaveBtn = $('leave-btn');
const chatPanel = $('chat-panel');
const chatToggle = $('chat-toggle');
const chatMessages = $('chat-messages');
const chatInput = $('chat-input');
const chatSend = $('chat-send');
const usersPanel = $('users-panel');
const usersToggle = $('users-toggle');
const usersList = $('users-list');

// Сокет
function initSocket() {
    socket = io({ reconnection: true, reconnectionAttempts: 10 });

    socket.on('connect', () => setStatus('ok', 'online'));
    socket.on('disconnect', () => setStatus('err', 'offline'));
    socket.on('reconnecting', () => setStatus('warn', 'reconnecting'));
    socket.on('error', msg => showError(msg));
    socket.on('room-full', msg => { showError(msg); leave(); });

    socket.on('room-users', users => {
        usersMap.clear();
        users.forEach(u => {
            usersMap.set(u.id, u.username);
            if (u.id !== socket.id) addPeer(u.id, true);
        });
        updateUsersList();
    });

    socket.on('user-joined', user => {
        usersMap.set(user.id, user.username);
        addPeer(user.id, true);
        updateUsersList();
        addSystemMessage(`${user.username} joined`);
    });

    socket.on('user-left', user => {
        usersMap.delete(user.id);
        removePeer(user.id);
        updateUsersList();
        addSystemMessage(`${user.username} left`);
    });

    socket.on('offer', async data => {
        const pc = getOrCreatePC(data.sender);
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { target: data.sender, answer });
    });

    socket.on('answer', async data => {
        const pc = peers.get(data.sender);
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
    });

    socket.on('ice-candidate', async data => {
        const pc = peers.get(data.sender);
        if (pc) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    });

    socket.on('chat-message', data => {
        addChatMessage(data.username, data.message);
    });
}

// Медиа
async function getMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 } },
            audio: true
        });
        localVideo.srcObject = localStream;
        localName.textContent = username;
    } catch (e) {
        showError('no media');
        setStatus('err', 'no camera/mic');
    }
}

async function toggleScreen() {
    if (screenOn) {
        stopScreenShare();
        return;
    }
    try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenOn = true;
        screenBtn.textContent = 'stop';
        screenBtn.classList.add('on');

        const screenTrack = screenStream.getVideoTracks()[0];
        screenTrack.onended = () => stopScreenShare();

        peers.forEach(pc => {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(screenTrack);
        });

        localVideo.srcObject = screenStream;
    } catch (e) {
        showError('screen denied');
    }
}

function stopScreenShare() {
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    screenOn = false;
    screenBtn.textContent = 'screen';
    screenBtn.classList.remove('on');

    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        peers.forEach(pc => {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender && videoTrack) sender.replaceTrack(videoTrack);
        });
        localVideo.srcObject = localStream;
    }
}

function toggleMic() {
    if (!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t => t.enabled = micOn);
    micBtn.textContent = micOn ? 'mic' : 'muted';
    micBtn.className = `ctrl-btn ${micOn ? 'on' : 'off'}`;
}

function toggleCam() {
    if (!localStream || screenOn) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach(t => t.enabled = camOn);
    camBtn.textContent = camOn ? 'cam' : 'no cam';
    camBtn.className = `ctrl-btn ${camOn ? 'on' : 'off'}`;
}

// WebRTC
function getOrCreatePC(userId) {
    if (peers.has(userId)) return peers.get(userId);
    const pc = new RTCPeerConnection(pcConfig);
    peers.set(userId, pc);

    if (localStream) {
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    pc.ontrack = e => {
        let remoteVideo = document.querySelector(`.video-container[data-user="${userId}"] video`);
        if (!remoteVideo) {
            remoteVideo = createRemoteVideo(userId);
        }
        if (e.streams[0]) {
            remoteVideo.srcObject = e.streams[0];
        }
    };

    pc.onicecandidate = e => {
        if (e.candidate) socket.emit('ice-candidate', { target: userId, candidate: e.candidate });
    };

    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            removePeer(userId);
        }
    };

    return pc;
}

async function addPeer(userId, createOfferFlag) {
    const pc = getOrCreatePC(userId);
    if (createOfferFlag) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: userId, offer });
    }
}

function removePeer(userId) {
    const pc = peers.get(userId);
    if (pc) {
        pc.close();
        peers.delete(userId);
    }
    const container = document.querySelector(`.video-container[data-user="${userId}"]`);
    if (container) container.remove();
    updateVideosLayout();
}

// Видео элементы
function createRemoteVideo(userId) {
    const container = document.createElement('div');
    container.className = 'video-container';
    container.dataset.user = userId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsinline = true;

    const tag = document.createElement('div');
    tag.className = 'name-tag';
    tag.textContent = usersMap.get(userId) || '...';

    container.appendChild(video);
    container.appendChild(tag);
    videosDiv.appendChild(container);
    updateVideosLayout();

    return video;
}

function updateVideosLayout() {
    const count = videosDiv.children.length;
    const grid = videosDiv;
    
    if (count === 0) {
        grid.style.display = 'none';
    } else if (count === 1) {
        grid.style.display = 'flex';
        grid.style.flexDirection = 'row';
    } else {
        grid.style.display = 'flex';
        grid.style.flexDirection = 'row';
    }
}

// Участники
function updateUsersList() {
    usersList.innerHTML = '';
    const count = usersMap.size;
    usersToggle.textContent = `users ${count}`;

    // Сначала "вы"
    const youItem = document.createElement('div');
    youItem.className = 'user-item you';
    youItem.innerHTML = `<span class="user-dot"></span><span class="user-name">${username} (you)</span>`;
    usersList.appendChild(youItem);

    usersMap.forEach((name, id) => {
        if (id !== socket.id) {
            const item = document.createElement('div');
            item.className = 'user-item';
            item.innerHTML = `<span class="user-dot"></span><span class="user-name">${name}</span>`;
            usersList.appendChild(item);
        }
    });
}

// Чат
function addChatMessage(author, text) {
    const msg = document.createElement('div');
    msg.className = 'chat-msg';
    msg.innerHTML = `<span class="author">${author}:</span><span class="text">${escapeHtml(text)}</span>`;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
    const msg = document.createElement('div');
    msg.className = 'chat-msg system';
    msg.textContent = text;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;
    
    addChatMessage(username, text);
    socket.emit('chat-message', { roomCode, username, message: text });
    chatInput.value = '';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Переключение панелей
chatToggle.addEventListener('click', () => {
    chatPanel.classList.toggle('collapsed');
});

usersToggle.addEventListener('click', () => {
    usersPanel.classList.toggle('collapsed');
});

chatSend.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendMessage();
});

// Интерфейс
function setStatus(type, msg) {
    statusDiv.textContent = msg;
    statusDiv.className = type;
}

function showError(msg) {
    errorText.textContent = msg;
    setTimeout(() => { errorText.textContent = ''; }, 3000);
}

function join() {
    username = usernameInput.value.trim();
    roomCode = roomInput.value.trim().toLowerCase();

    if (!username || !roomCode || !/^[a-zA-Z0-9_-]+$/.test(roomCode)) {
        showError('invalid input');
        return;
    }

    socket.emit('join-room', { roomCode, username });
    roomLabel.textContent = roomCode;

    loginScreen.classList.remove('active');
    roomScreen.classList.add('active');
    localName.textContent = username;
    usersMap.set('local', username);

    getMedia();
    updateUsersList();
}

function leave() {
    peers.forEach((pc, id) => removePeer(id));

    [localStream, screenStream].forEach(s => {
        if (s) { s.getTracks().forEach(t => t.stop()); }
    });
    localStream = null;
    screenStream = null;
    screenOn = false;

    videosDiv.innerHTML = '';
    chatMessages.innerHTML = '';
    usersMap.clear();
    micOn = true; camOn = true;
    micBtn.className = 'ctrl-btn on'; micBtn.textContent = 'mic';
    camBtn.className = 'ctrl-btn on'; camBtn.textContent = 'cam';
    screenBtn.className = 'ctrl-btn'; screenBtn.textContent = 'screen';
    chatPanel.classList.add('collapsed');
    usersPanel.classList.add('collapsed');
    localVideo.srcObject = null;

    roomScreen.classList.remove('active');
    loginScreen.classList.add('active');
    setStatus('', '');

    socket.disconnect();
    initSocket();
}

// Перетаскивание своего видео
let dragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;

localContainer.addEventListener('mousedown', e => {
    if (e.target.tagName === 'VIDEO' || e.target === localContainer) {
        dragging = true;
        const rect = localContainer.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        localContainer.style.transition = 'none';
    }
});

document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const roomRect = roomScreen.getBoundingClientRect();
    const x = e.clientX - roomRect.left - dragOffsetX;
    const y = e.clientY - roomRect.top - dragOffsetY;
    
    const maxX = roomRect.width - localContainer.offsetWidth - 8;
    const maxY = roomRect.height - localContainer.offsetHeight - 24;
    
    localContainer.style.left = Math.max(4, Math.min(x, maxX)) + 'px';
    localContainer.style.top = Math.max(36, Math.min(y, maxY)) + 'px';
    localContainer.style.right = 'auto';
});

document.addEventListener('mouseup', () => {
    if (dragging) {
        dragging = false;
        localContainer.style.transition = 'width 0.2s';
    }
});

// Обработчики
joinBtn.addEventListener('click', join);
micBtn.addEventListener('click', toggleMic);
camBtn.addEventListener('click', toggleCam);
screenBtn.addEventListener('click', toggleScreen);
leaveBtn.addEventListener('click', leave);

[usernameInput, roomInput].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
});

// Инициализация
initSocket();
