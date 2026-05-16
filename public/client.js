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
const statusDiv = $('status');
const micBtn = $('mic-btn');
const camBtn = $('cam-btn');
const screenBtn = $('screen-btn');
const leaveBtn = $('leave-btn');

// Сокет
function initSocket() {
    socket = io({ reconnection: true, reconnectionAttempts: 10 });

    socket.on('connect', () => setStatus('ok', 'online'));
    socket.on('disconnect', () => setStatus('err', 'offline'));
    socket.on('reconnecting', () => setStatus('warn', 'reconnecting'));
    socket.on('error', msg => showError(msg));
    socket.on('room-full', msg => { showError(msg); leave(); });

    socket.on('room-users', users => {
        users.forEach(u => { if (u.id !== socket.id) addPeer(u.id, true); });
    });

    socket.on('user-joined', user => addPeer(user.id, true));

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

    socket.on('user-left', user => removePeer(user.id));
}

// Стримы
async function getMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 } },
            audio: true
        });
        createLocalVideo();
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

        // Заменяем видео-трек во всех пирах
        peers.forEach(pc => {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(screenTrack);
        });

        // Обновляем локальное видео
        const localVideo = document.querySelector('.video-container.local video');
        if (localVideo) localVideo.srcObject = screenStream;
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

    // Восстанавливаем видео с камеры
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        peers.forEach(pc => {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender && videoTrack) sender.replaceTrack(videoTrack);
        });
        const localVideo = document.querySelector('.video-container.local video');
        if (localVideo) localVideo.srcObject = localStream;
    }
}

// Управление
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
        if (e.track.kind === 'video' || e.streams[0]) {
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
    updateLayout();
}

// Видео элементы
function createLocalVideo() {
    const container = document.createElement('div');
    container.className = 'video-container local';
    container.dataset.user = 'local';

    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsinline = true;
    video.srcObject = localStream;

    const tag = document.createElement('div');
    tag.className = 'name-tag';
    tag.textContent = usernameInput.value.trim() || 'you';

    container.appendChild(video);
    container.appendChild(tag);
    videosDiv.appendChild(container);
    updateLayout();
}

function createRemoteVideo(userId) {
    const container = document.createElement('div');
    container.className = 'video-container';
    container.dataset.user = userId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsinline = true;

    const tag = document.createElement('div');
    tag.className = 'name-tag';
    tag.textContent = '...';

    container.appendChild(video);
    container.appendChild(tag);
    videosDiv.appendChild(container);
    updateLayout();

    // Запрашиваем имя
    socket.emit('get-username', userId);
    socket.once('username', data => {
        if (data.id === userId) tag.textContent = data.username;
    });

    return video;
}

function updateLayout() {
    const count = videosDiv.children.length;
    videosDiv.style.setProperty('--count', count);
}

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
    const name = usernameInput.value.trim();
    roomCode = roomInput.value.trim().toLowerCase();

    if (!name || !roomCode || !/^[a-zA-Z0-9_-]+$/.test(roomCode)) {
        showError('invalid input');
        return;
    }

    socket.emit('join-room', { roomCode, username: name });
    roomLabel.textContent = `room: ${roomCode}`;

    loginScreen.classList.remove('active');
    roomScreen.classList.add('active');

    getMedia();
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
    micOn = true; camOn = true;
    micBtn.className = 'ctrl-btn on'; micBtn.textContent = 'mic';
    camBtn.className = 'ctrl-btn on'; camBtn.textContent = 'cam';
    screenBtn.className = 'ctrl-btn'; screenBtn.textContent = 'screen';

    roomScreen.classList.remove('active');
    loginScreen.classList.add('active');
    setStatus('', '');

    socket.disconnect();
    initSocket();
}

// Обработчики
joinBtn.addEventListener('click', join);
micBtn.addEventListener('click', toggleMic);
camBtn.addEventListener('click', toggleCam);
screenBtn.addEventListener('click', toggleScreen);
leaveBtn.addEventListener('click', leave);

// Enter для отправки
[usernameInput, roomInput].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
});

// Инициализация
initSocket();
setStatus('', '');
