const pcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

let socket;
let localStream = null;
let screenStream = null;
let peers = new Map();
let micOn = false;
let camOn = false;
let screenOn = false;
let roomCode;
let username;
let usersMap = new Map();

const $ = id => document.getElementById(id);
const loginScreen = $('login-screen');
const roomScreen = $('room-screen');
const joinBtn = $('join-btn');
const errorText = $('error-text');
const roomLabel = $('room-label');
const videosDiv = $('videos');
const localContainer = $('local-container');
const localVideo = $('local-video');
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

function initSocket() {
    if (socket) {
        socket.removeAllListeners();
        socket.disconnect();
    }
    
    socket = io({ reconnection: true, reconnectionAttempts: 10 });

    socket.on('connect', () => setStatus('ok', 'online'));
    socket.on('disconnect', () => setStatus('err', 'offline'));
    socket.on('reconnecting', () => setStatus('warn', 'reconnecting'));
    socket.on('error', msg => showError(msg));
    socket.on('room-full', msg => { showError(msg); leaveRoom(); });

    socket.on('room-users', users => {
        usersMap.clear();
        users.forEach(u => {
            usersMap.set(u.id, u.username);
            if (u.id !== socket.id) {
                createPeerConnection(u.id);
                createOffer(u.id);
            }
        });
        updateUsersList();
    });

    socket.on('user-joined', user => {
        usersMap.set(user.id, user.username);
        createPeerConnection(user.id);
        createOffer(user.id);
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
        const pc = peers.get(data.sender);
        if (!pc) {
            createPeerConnection(data.sender);
        }
        const peerPc = peers.get(data.sender);
        try {
            await peerPc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await peerPc.createAnswer();
            await peerPc.setLocalDescription(answer);
            socket.emit('answer', { target: data.sender, answer });
        } catch (e) {
            console.error('Offer error:', e);
        }
    });

    socket.on('answer', async data => {
        const pc = peers.get(data.sender);
        if (pc) {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
            } catch (e) {
                console.error('Answer error:', e);
            }
        }
    });

    socket.on('ice-candidate', async data => {
        const pc = peers.get(data.sender);
        if (pc) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (e) {
                console.error('ICE error:', e);
            }
        }
    });

    socket.on('chat-message', data => {
        addChatMessage(data.username, data.message);
    });
}

async function getMedia() {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
            audio: true
        });
        
        localStream.getVideoTracks().forEach(track => track.enabled = false);
        localStream.getAudioTracks().forEach(track => track.enabled = false);
        
        localVideo.srcObject = localStream;
        setStatus('ok', 'online');
    } catch (e) {
        console.error('Media error:', e);
        showError('no media access');
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
        screenBtn.classList.remove('off');

        const screenTrack = screenStream.getVideoTracks()[0];
        screenTrack.onended = () => stopScreenShare();

        peers.forEach(pc => {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(screenTrack);
        });

        localVideo.srcObject = screenStream;
        localVideo.style.transform = 'none';
    } catch (e) {
        console.error('Screen error:', e);
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
        localVideo.style.transform = 'scaleX(-1)';
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

function createPeerConnection(userId) {
    if (peers.has(userId)) {
        peers.get(userId).close();
        peers.delete(userId);
    }

    const pc = new RTCPeerConnection(pcConfig);
    peers.set(userId, pc);

    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }

    pc.ontrack = event => {
        let container = document.querySelector(`.video-container[data-user="${userId}"]`);
        if (!container) {
            container = document.createElement('div');
            container.className = 'video-container';
            container.dataset.user = userId;

            const video = document.createElement('video');
            video.autoplay = true;
            video.playsinline = true;
            video.style.width = '100%';
            video.style.height = '100%';
            video.style.objectFit = 'cover';

            const tag = document.createElement('div');
            tag.className = 'name-tag';
            tag.textContent = usersMap.get(userId) || 'user';

            container.appendChild(video);
            container.appendChild(tag);
            videosDiv.appendChild(container);
        }

        const video = container.querySelector('video');
        if (event.streams && event.streams[0]) {
            video.srcObject = event.streams[0];
        }
        updateVideosLayout();
    };

    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                target: userId,
                candidate: event.candidate
            });
        }
    };

    pc.oniceconnectionstatechange = () => {
        console.log(`ICE state for ${userId}: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            removePeer(userId);
        }
    };

    pc.onconnectionstatechange = () => {
        console.log(`Connection state for ${userId}: ${pc.connectionState}`);
    };

    return pc;
}

async function createOffer(userId) {
    const pc = peers.get(userId);
    if (!pc) return;

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('offer', { target: userId, offer });
    } catch (e) {
        console.error('Create offer error:', e);
    }
}

function removePeer(userId) {
    const pc = peers.get(userId);
    if (pc) {
        pc.close();
        peers.delete(userId);
    }
    const container = document.querySelector(`.video-container[data-user="${userId}"]`);
    if (container) {
        container.remove();
    }
    updateVideosLayout();
}

function updateVideosLayout() {
    const count = videosDiv.children.length;
    if (count === 1) {
        videosDiv.children[0].style.maxWidth = '100%';
        videosDiv.children[0].style.maxHeight = '100%';
        videosDiv.children[0].style.flex = '1 1 100%';
    }
}

function updateUsersList() {
    usersList.innerHTML = '';
    
    const youItem = document.createElement('div');
    youItem.className = 'user-item you';
    youItem.innerHTML = `<span class="user-dot"></span><span class="user-name">${username} (you)</span>`;
    usersList.appendChild(youItem);

    usersMap.forEach((name, id) => {
        if (id !== socket?.id) {
            const item = document.createElement('div');
            item.className = 'user-item';
            item.innerHTML = `<span class="user-dot"></span><span class="user-name">${name}</span>`;
            usersList.appendChild(item);
        }
    });

    const count = usersMap.size;
    usersToggle.querySelector('span').textContent = `users ${count}`;
}

function addChatMessage(author, text) {
    const msg = document.createElement('div');
    msg.className = 'chat-msg';
    msg.innerHTML = `<span class="author">${escapeHtml(author)}:</span> <span class="text">${escapeHtml(text)}</span>`;
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
    if (!text || !socket?.connected) return;
    
    addChatMessage(username, text);
    socket.emit('chat-message', { roomCode, username, message: text });
    chatInput.value = '';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

chatToggle.addEventListener('click', () => {
    chatPanel.classList.toggle('open');
});

usersToggle.addEventListener('click', () => {
    usersPanel.classList.toggle('open');
});

chatSend.addEventListener('click', sendMessage);
chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') sendMessage();
});

function setStatus(type, msg) {
    statusDiv.textContent = msg;
    statusDiv.className = type;
}

function showError(msg) {
    errorText.textContent = msg;
    setTimeout(() => { errorText.textContent = ''; }, 3000);
}

async function join() {
    username = document.getElementById('username').value.trim();
    roomCode = document.getElementById('room-code').value.trim().toLowerCase();

    if (!username || !roomCode || !/^[a-zA-Z0-9_-]+$/.test(roomCode)) {
        showError('invalid input');
        return;
    }

    socket.emit('join-room', { roomCode, username });
    roomLabel.textContent = `room: ${roomCode}`;

    loginScreen.classList.remove('active');
    roomScreen.classList.add('active');
    usersMap.clear();

    await getMedia();
    updateUsersList();
}

function leaveRoom() {
    peers.forEach(pc => pc.close());
    peers.clear();

    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        screenStream = null;
    }
    screenOn = false;

    videosDiv.innerHTML = '';
    chatMessages.innerHTML = '';
    usersMap.clear();
    
    micOn = false;
    camOn = false;
    micBtn.className = 'ctrl-btn off';
    micBtn.textContent = 'muted';
    camBtn.className = 'ctrl-btn off';
    camBtn.textContent = 'no cam';
    screenBtn.className = 'ctrl-btn';
    screenBtn.textContent = 'screen';
    
    chatPanel.classList.remove('open');
    usersPanel.classList.remove('open');
    localVideo.srcObject = null;

    roomScreen.classList.remove('active');
    loginScreen.classList.add('active');
    setStatus('', '');

    socket.disconnect();
    initSocket();
}

let isDragging = false;
let dragStartX, dragStartY, startLeft, startTop;

localContainer.addEventListener('mousedown', e => {
    if (e.target === localContainer || e.target === localVideo) {
        isDragging = true;
        const rect = localContainer.getBoundingClientRect();
        const roomRect = roomScreen.getBoundingClientRect();
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        startLeft = rect.left - roomRect.left;
        startTop = rect.top - roomRect.top;
        localContainer.style.transition = 'none';
        e.preventDefault();
    }
});

document.addEventListener('mousemove', e => {
    if (!isDragging) return;
    
    const roomRect = roomScreen.getBoundingClientRect();
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    
    let newLeft = startLeft + dx;
    let newTop = startTop + dy;
    
    const maxLeft = roomRect.width - localContainer.offsetWidth - 8;
    const maxTop = roomRect.height - localContainer.offsetHeight - 28;
    
    newLeft = Math.max(4, Math.min(newLeft, maxLeft));
    newTop = Math.max(40, Math.min(newTop, maxTop));
    
    localContainer.style.left = newLeft + 'px';
    localContainer.style.top = newTop + 'px';
    localContainer.style.right = 'auto';
});

document.addEventListener('mouseup', () => {
    if (isDragging) {
        isDragging = false;
        localContainer.style.transition = 'box-shadow 0.2s';
    }
});

joinBtn.addEventListener('click', join);
micBtn.addEventListener('click', toggleMic);
camBtn.addEventListener('click', toggleCam);
screenBtn.addEventListener('click', toggleScreen);
leaveBtn.addEventListener('click', leaveRoom);

document.getElementById('username').addEventListener('keydown', e => {
    if (e.key === 'Enter') join();
});
document.getElementById('room-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') join();
});

initSocket();
setStatus('', '');
