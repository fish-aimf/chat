let ws, username, notificationsEnabled = true, chatWindows = new Map(), groupChatWindow, isGroupChatCollapsed = false;
let isTabActive = !document.hidden;

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("join-btn").addEventListener("click", handleLogin);
  document.getElementById("username-input").addEventListener("keypress", e => e.key === "Enter" && handleLogin());
  document.getElementById("theme-selector").addEventListener("change", e => document.body.className = `theme-${e.target.value}`);
  document.getElementById("notifications-toggle").addEventListener("click", e => {
    notificationsEnabled = !notificationsEnabled;
    e.target.textContent = notificationsEnabled ? "🔔 Notifications" : "🔕 Notifications";
  });

  document.addEventListener('paste', handlePaste);
});

function handleLogin() {
  username = document.getElementById("username-input").value.trim();
  if (username) {
    connectWebSocket();
    document.getElementById("login-screen").style.display = "none";
    document.getElementById("chat-screen").style.display = "block";
    createGroupChatWindow();
  }
}

function connectWebSocket() {
  ws = new WebSocket(`${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`);
  
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", username }));
    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
    }, 25000);
  };
  
  ws.onmessage = event => {
    try {
      handleMessage(JSON.parse(event.data));
    } catch (error) {
      console.error("Error parsing message:", error);
    }
  };
  
  ws.onclose = (event) => {
    console.log('WebSocket closed, attempting to reconnect...', event);
    setTimeout(connectWebSocket, 5000);
  };
  
  ws.onerror = error => {
    console.error("WebSocket error:", error);
  };
}

function handleMessage(data) {
  switch (data.type) {
    case "users": updateUsersList(data.users); break;
    case "chat": receiveMessage(data); break;
    case "group_chat": receiveGroupMessage(data); break;
    case "ping": handlePing(data); break;
    case "message_deleted": handleMessageDeleted(data); break;
  }
}

function createGroupChatWindow() {
  groupChatWindow = document.createElement("div");
  groupChatWindow.className = "chat-window group-chat";
  groupChatWindow.style.left = "260px";
  groupChatWindow.style.width = "400px";
  groupChatWindow.innerHTML = `
    <div class="chat-header" onclick="toggleGroupChat()">
      <span>Group Chat</span>
      <div class="header-buttons"><button class="collapse-btn">_</button></div>
    </div>
    <div class="chat-content">
      <div class="chat-messages"></div>
      <div class="file-drop-zone" style="display: none;">
        <p>Drop files here to upload</p>
      </div>
      <div class="chat-input">
        <input type="file" id="group-file-input" accept="image/*,.pdf,.txt,.doc,.docx" style="display: none;">
        <button onclick="document.getElementById('group-file-input').click()" title="Upload file">📎</button>
        <input type="text" placeholder="Type a message or paste screenshot..." onkeypress="handleGroupChatKeyPress(event)">
        <button onclick="sendGroupMessage()">Send</button>
      </div>
    </div>
  `;
  document.getElementById("chat-windows").appendChild(groupChatWindow);
  groupChatWindow.setAttribute('data-full-height', `${groupChatWindow.offsetHeight}px`);
  
  const fileInput = groupChatWindow.querySelector('#group-file-input');
  fileInput.addEventListener('change', (e) => handleFileSelect(e, 'group'));

  const chatMessages = groupChatWindow.querySelector('.chat-messages');
  const dropZone = groupChatWindow.querySelector('.file-drop-zone');
  
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    chatMessages.addEventListener(eventName, preventDefaults);
  });
  
  ['dragenter', 'dragover'].forEach(eventName => {
    chatMessages.addEventListener(eventName, () => {
      dropZone.style.display = 'block';
      chatMessages.style.opacity = '0.5';
    });
  });
  
  ['dragleave', 'drop'].forEach(eventName => {
    chatMessages.addEventListener(eventName, () => {
      dropZone.style.display = 'none';
      chatMessages.style.opacity = '1';
    });
  });
  
  chatMessages.addEventListener('drop', (e) => handleFileDrop(e, 'group'));
}

function toggleGroupChat() {
    isGroupChatCollapsed = !isGroupChatCollapsed;
    const collapseBtn = groupChatWindow.querySelector('.collapse-btn');

    if (isGroupChatCollapsed) {
        groupChatWindow.classList.add('minimized');
        collapseBtn.textContent = '□';
    } else {
        groupChatWindow.classList.remove('minimized');
        collapseBtn.textContent = '_';
        groupChatWindow.querySelector('.chat-messages').scrollTop = 1e6;
    }
}

function handleGroupChatKeyPress(event) {
  if (event.key === "Enter") sendGroupMessage();
}

function sendGroupMessage() {
    const input = groupChatWindow.querySelector("input[type='text']");
    const message = input.value.trim();
    const replyToData = input.dataset.replyTo ? JSON.parse(input.dataset.replyTo) : null;
    const fileData = input.dataset.fileData ? JSON.parse(input.dataset.fileData) : null;
    
    if ((message || fileData) && ws.readyState === WebSocket.OPEN) {
        const messageData = { 
            type: "group_chat", 
            message: message || (fileData ? `📎 ${fileData.fileName}` : ''),
            replyTo: replyToData
        };
        
        if (fileData) {
            messageData.fileUrl = fileData.url;
            messageData.fileName = fileData.fileName;
            messageData.fileSize = fileData.fileSize;
        }
        
        ws.send(JSON.stringify(messageData));
        displayGroupMessage(username, message || `📎 ${fileData?.fileName || 'File'}`, true, replyToData, fileData);
        input.value = "";
        input.removeAttribute('data-reply-to');
        input.removeAttribute('data-file-data');
        
        const replyPreview = groupChatWindow.querySelector('.active-reply-preview');
        if (replyPreview) replyPreview.remove();
        
        const filePreview = groupChatWindow.querySelector('.file-preview');
        if (filePreview) filePreview.remove();
    }
}

function receiveGroupMessage(data) {
  const fileData = data.fileUrl ? {
    url: data.fileUrl,
    fileName: data.fileName,
    fileSize: data.fileSize
  } : null;
  
  displayGroupMessage(data.from, data.message, false, data.replyTo, fileData, data.id);
  if (notificationsEnabled) {
    playNotification();
    showNotification(`New group message from ${data.from}`);
  }
}

function displayGroupMessage(sender, message, isOwn = false, replyTo = null, fileData = null, messageId = Date.now()) {
    const messages = groupChatWindow.querySelector(".chat-messages");
    const messageElement = createMessageElement(sender, message, isOwn, replyTo, messageId, fileData);
    messages.appendChild(messageElement);
    messages.scrollTop = messages.scrollHeight;
}

function updateUsersList(users) {
    const usersList = document.getElementById("users-list");
    usersList.innerHTML = users
        .filter(user => user.username !== username)
        .map(user => `
            <div class="user-item">
                <span class="user-name">
                    <span class="status-indicator ${user.isActive ? 'active' : 'inactive'}"></span>
                    ${user.username}
                </span>
                <div class="user-actions">
                    <button onclick="openChatWindow('${user.username}')">Chat</button>
                    <button onclick="pingUser('${user.username}')">Ping</button>
                </div>
            </div>
        `).join("");
}

function openChatWindow(targetUser) {
  if (chatWindows.has(targetUser)) return;
  const chatWindow = document.createElement("div");
  chatWindow.className = "chat-window";
  chatWindow.style.right = `${chatWindows.size * 320}px`;
  chatWindow.innerHTML = `
    <div class="chat-header">
      <span>${targetUser}</span>
      <button onclick="closeChatWindow('${targetUser}')">×</button>
    </div>
    <div class="chat-messages"></div>
    <div class="file-drop-zone" style="display: none;">
      <p>Drop files here to upload</p>
    </div>
    <div class="chat-input">
      <input type="file" id="file-input-${targetUser}" accept="image/*,.pdf,.txt,.doc,.docx" style="display: none;">
      <button onclick="document.getElementById('file-input-${targetUser}').click()" title="Upload file">📎</button>
      <input type="text" placeholder="Type a message or paste screenshot..." onkeypress="handleChatKeyPress(event, '${targetUser}')">
      <button onclick="sendMessage('${targetUser}')">Send</button>
    </div>
  `;
  document.getElementById("chat-windows").appendChild(chatWindow);
  chatWindows.set(targetUser, chatWindow);
  chatWindow.querySelector("input[type='text']").focus();
  
  const fileInput = chatWindow.querySelector(`#file-input-${targetUser}`);
  fileInput.addEventListener('change', (e) => handleFileSelect(e, targetUser));
  
  const chatMessages = chatWindow.querySelector('.chat-messages');
  const dropZone = chatWindow.querySelector('.file-drop-zone');
  
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    chatMessages.addEventListener(eventName, preventDefaults);
  });
  
  ['dragenter', 'dragover'].forEach(eventName => {
    chatMessages.addEventListener(eventName, () => {
      dropZone.style.display = 'block';
      chatMessages.style.opacity = '0.5';
    });
  });
  
  ['dragleave', 'drop'].forEach(eventName => {
    chatMessages.addEventListener(eventName, () => {
      dropZone.style.display = 'none';
      chatMessages.style.opacity = '1';
    });
  });
  
  chatMessages.addEventListener('drop', (e) => handleFileDrop(e, targetUser));
}

function handleChatKeyPress(event, targetUser) {
  if (event.key === "Enter") sendMessage(targetUser);
}

function closeChatWindow(targetUser) {
  const window = chatWindows.get(targetUser);
  if (window) {
    window.remove();
    chatWindows.delete(targetUser);
    let position = 0;
    chatWindows.forEach(window => window.style.right = `${position++ * 320}px`);
  }
}

function sendMessage(targetUser) {
    const window = chatWindows.get(targetUser);
    const input = window.querySelector("input[type='text']");
    const message = input.value.trim();
    const replyToData = input.dataset.replyTo ? JSON.parse(input.dataset.replyTo) : null;
    const fileData = input.dataset.fileData ? JSON.parse(input.dataset.fileData) : null;
    
    if ((message || fileData) && ws.readyState === WebSocket.OPEN) {
        const messageData = { 
            type: "chat", 
            to: targetUser, 
            message: message || (fileData ? `📎 ${fileData.fileName}` : ''),
            replyTo: replyToData
        };
        
        if (fileData) {
            messageData.fileUrl = fileData.url;
            messageData.fileName = fileData.fileName;
            messageData.fileSize = fileData.fileSize;
        }
        
        ws.send(JSON.stringify(messageData));
        
        const messages = window.querySelector(".chat-messages");
        const messageElement = createMessageElement('You', message || `📎 ${fileData?.fileName || 'File'}`, true, replyToData, Date.now(), fileData);
        messages.appendChild(messageElement);
        messages.scrollTop = messages.scrollHeight;
        input.value = "";
        input.removeAttribute('data-reply-to');
        input.removeAttribute('data-file-data');
      
        const replyPreview = window.querySelector('.active-reply-preview');
        if (replyPreview) replyPreview.remove();
      
        const filePreview = window.querySelector('.file-preview');
        if (filePreview) filePreview.remove();
    }
}

function receiveMessage(data) {
    if (!chatWindows.has(data.from)) openChatWindow(data.from);
    const window = chatWindows.get(data.from);
    const messages = window.querySelector(".chat-messages");
    
    const fileData = data.fileUrl ? {
        url: data.fileUrl,
        fileName: data.fileName,
        fileSize: data.fileSize
    } : null;
    
    const messageElement = createMessageElement(data.from, data.message, false, data.replyTo, data.id, fileData);
    messages.appendChild(messageElement);
    messages.scrollTop = messages.scrollHeight;
    
    if (notificationsEnabled) {
        playNotification();
        showNotification(`New message from ${data.from}`);
    }
}

function pingUser(targetUser) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", to: targetUser }));
}

function handlePing(data) {
  if (notificationsEnabled) {
    playPingSound();
    showNotificationBanner(`${data.from} pinged you!`);
  }
}

function playPingSound() {
  const audio = new Audio('https://pixabay.com/sound-effects/notification-18-270129/.mp3');
  audio.play().catch(() => document.addEventListener("click", () => audio.play(), { once: true }));
}

function showNotificationBanner(message) {
  const banner = document.createElement("div");
  banner.className = "notification-banner";
  banner.textContent = message;
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 5000);
}

function playNotification() {
  const audio = document.getElementById("notification-sound");
  if (!audio) return;
  audio.currentTime = 0;
  audio.play().catch(() => document.addEventListener("click", () => audio.play(), { once: true }));
}

function showNotification(message) {
  if (Notification.permission === "granted") new Notification(message);
  else if (Notification.permission !== "denied") Notification.requestPermission().then(permission => permission === "granted" && new Notification(message));
}

function escapeHtml(unsafe) {
  return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden && notificationsEnabled && Notification.permission !== "denied") Notification.requestPermission();
});

window.addEventListener("beforeunload", () => ws?.readyState === WebSocket.OPEN && ws.close());

document.addEventListener("DOMContentLoaded", () => {
  const themeSelector = document.getElementById("theme-selector");
  const body = document.body;
  const storedTheme = localStorage.getItem("selectedTheme") || "midnight";
  body.className = `theme-${storedTheme}`;
  themeSelector.value = storedTheme;
  themeSelector.addEventListener("change", () => {
    body.className = `theme-${themeSelector.value}`;
    localStorage.setItem("selectedTheme", themeSelector.value);
  });
});

function handleFileSelect(event, target) {
    const file = event.target.files[0];
    if (!file) return;
    
    uploadFile(file, target);
}

function handleFileDrop(event, target) {
    const files = event.dataTransfer.files;
    if (files.length > 0) {
        uploadFile(files[0], target);
    }
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function uploadFile(file, target) {
    const formData = new FormData();
    formData.append('file', file);
    
    fetch('/upload', {
        method: 'POST',
        body: formData
    })
    .then(response => response.json())
    .then(data => {
        if (data.error) {
            alert('Upload failed: ' + data.error);
            return;
        }
        
        const chatWindow = target === 'group' ? groupChatWindow : chatWindows.get(target);
        const input = chatWindow.querySelector("input[type='text']");
        input.dataset.fileData = JSON.stringify({
            url: data.url,
            fileName: data.originalName,
            fileSize: data.size
        });
        
        showFilePreview(chatWindow, data);
        
    })
    .catch(error => {
        console.error('Upload error:', error);
        alert('Upload failed');
    });
}


function showFilePreview(chatWindow, fileData) {
    const existingPreview = chatWindow.querySelector('.file-preview');
    if (existingPreview) existingPreview.remove();
    
    const preview = document.createElement('div');
    preview.className = 'file-preview';
    const fileName = fileData.originalName;
    const displayName = fileName.length > 25 ? fileName.substring(0, 25) + '...' : fileName;
    
    preview.innerHTML = `
        <div>
            <span title="${fileName}">📎 ${displayName} (${formatFileSize(fileData.size)})</span>
            <button onclick="cancelFileUpload(this)" style="background: none; border: none; cursor: pointer; flex-shrink: 0;">✕</button>
        </div>
    `;
    
    const input = chatWindow.querySelector("input[type='text']");
    input.parentElement.insertBefore(preview, input);
}

function cancelFileUpload(button) {
    const chatWindow = button.closest('.chat-window');
    const input = chatWindow.querySelector("input[type='text']");
    input.removeAttribute('data-file-data');
    button.closest('.file-preview').remove();
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function handlePaste(event) {
    const items = event.clipboardData?.items;
    if (!items) return;
    
    for (let item of items) {
        if (item.type.indexOf('image') !== -1) {
            const file = item.getAsFile();
            if (file) {
                const activeInput = document.activeElement;
                const chatWindow = activeInput.closest('.chat-window');
                
                if (chatWindow) {
                    const reader = new FileReader();
                    reader.onload = function(e) {
                        uploadScreenshot(e.target.result, chatWindow);
                    };
                    reader.readAsDataURL(file);
                }
            }
            break;
        }
    }
}

function uploadScreenshot(imageData, chatWindow) {
    const filename = `screenshot-${Date.now()}.png`;
    
    fetch('/upload-screenshot', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            imageData: imageData,
            filename: filename
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.error) {
            alert('Screenshot upload failed: ' + data.error);
            return;
        }
        
        const input = chatWindow.querySelector("input[type='text']");
        input.dataset.fileData = JSON.stringify({
            url: data.url,
            fileName: data.originalName,
            fileSize: data.size
        });
        
        showScreenshotPreview(chatWindow, data);
        
    })
    .catch(error => {
        console.error('Screenshot upload error:', error);
        alert('Screenshot upload failed');
    });
}

function showScreenshotPreview(chatWindow, fileData) {
    const existingPreview = chatWindow.querySelector('.file-preview');
    if (existingPreview) existingPreview.remove();
    
    const preview = document.createElement('div');
    preview.className = 'file-preview';
    
    const fileName = fileData.originalName;
    const displayName = fileName.length > 20 ? fileName.substring(0, 20) + '...' : fileName;
    
    preview.innerHTML = `
        <div>
            <img src="${fileData.url}" alt="Screenshot" style="width: 40px; height: 40px; object-fit: cover; border-radius: 4px; flex-shrink: 0;">
            <span title="${fileName}">📷 ${displayName} (${formatFileSize(fileData.size)})</span>
            <button onclick="cancelFileUpload(this)" style="background: none; border: none; cursor: pointer; flex-shrink: 0;">✕</button>
        </div>
    `;
    
    const input = chatWindow.querySelector("input[type='text']");
    input.parentElement.insertBefore(preview, input);
}


function createMessageElement(sender, message, isOwn, replyTo = null, messageId = Date.now(), fileData = null) {
    const div = document.createElement('div');
    div.className = `message ${isOwn ? 'outgoing' : 'incoming'}`;
    div.dataset.messageId = messageId;
    
    let replyHtml = '';
    if (replyTo) {
        replyHtml = `
            <div class="reply-preview">
                Replying to ${replyTo.sender}: ${replyTo.message.substring(0, 50)}${replyTo.message.length > 50 ? '...' : ''}
            </div>
        `;
    }
    
    let fileHtml = '';
    if (fileData) {
        const isImage = /\.(jpg|jpeg|png|gif|webp)$/i.test(fileData.fileName);
        const fileName = fileData.fileName;
        const displayName = fileName.length > 30 ? fileName.substring(0, 30) + '...' : fileName;
        
        if (isImage) {
            fileHtml = `
                <div class="file-attachment">
                    <img src="${fileData.url}" 
                         alt="${fileName}" 
                         title="${fileName}"
                         style="max-width: 200px; max-height: 200px; width: auto; height: auto; border-radius: 8px; cursor: pointer; display: block;" 
                         onclick="openImageModal('${fileData.url}', '${fileName}')">
                    <div class="file-info" title="${fileName}">${displayName} (${formatFileSize(fileData.fileSize)})</div>
                </div>
            `;
        } else {
            fileHtml = `
                <div class="file-attachment">
                    <a href="${fileData.url}" target="_blank" style="text-decoration: none; color: #007bff; display: block;">
                        <div style="background: #f8f9fa; padding: 12px; border-radius: 8px; border-left: 4px solid #007bff; overflow: hidden;">
                            <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${fileName}">
                                📎 ${displayName}
                            </div>
                            <div style="font-size: 0.8em; color: #666; margin-top: 4px;">
                                ${formatFileSize(fileData.fileSize)}
                            </div>
                        </div>
                    </a>
                </div>
            `;
        }
    }
    
    div.innerHTML = `
        <div class="message-actions">
            <button class="message-action-btn" onclick="replyToMessage('${messageId}')">↩ Reply</button>
            ${isOwn ? `<button class="message-action-btn" onclick="deleteMessage('${messageId}')">🗑️ Delete</button>` : ''}
        </div>
        <span class="sender">${isOwn ? 'You' : escapeHtml(sender)}</span>
        ${replyHtml}
        ${fileHtml}
        ${message ? `<span class="content">${escapeHtml(message)}</span>` : ''}
    `;
    
    return div;
}

function openImageModal(url, filename) {
    const modal = document.createElement('div');
    modal.className = 'image-modal';
    modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.8);
        display: flex;
        justify-content: center;
        align-items: center;
        z-index: 1000;
        cursor: pointer;
    `;
    
    modal.innerHTML = `
        <div style="max-width: 90%; max-height: 90%; position: relative;">
            <img src="${url}" alt="${filename}" style="max-width: 100%; max-height: 100%; object-fit: contain;">
            <button onclick="this.closest('.image-modal').remove()" style="position: absolute; top: 10px; right: 10px; background: rgba(255,255,255,0.8); border: none; border-radius: 50%; width: 30px; height: 30px; cursor: pointer; font-size: 18px;">×</button>
        </div>
    `;
    
    modal.onclick = (e) => {
        if (e.target === modal) modal.remove();
    };
    
    document.body.appendChild(modal);
}
function replyToMessage(messageId) {
    const messageElement = document.querySelector(`.message[data-message-id="${messageId}"]`);
    if (!messageElement) return;
    
    const sender = messageElement.querySelector('.sender').textContent;
    const contentElement = messageElement.querySelector('.content');
    let content = contentElement ? contentElement.textContent : '';
    
    const fileElement = messageElement.querySelector('.file-attachment');
    if (fileElement && !content) {
        const fileName = fileElement.querySelector('a') ? 
            fileElement.querySelector('a').textContent.replace('📎 ', '').trim() : 
            'File';
        content = `[File: ${fileName}]`;
    }
    
    const chatWindow = messageElement.closest('.chat-window');
    const input = chatWindow.querySelector('input[type="text"]');
  
    const existingPreview = chatWindow.querySelector('.active-reply-preview');
    if (existingPreview) existingPreview.remove();
  
    const displayContent = content.length > 40 ? content.substring(0, 40) + '...' : content;
    
    const replyPreview = document.createElement('div');
    replyPreview.className = 'reply-preview active-reply-preview';
    replyPreview.innerHTML = `
        <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            Replying to ${sender}: ${displayContent}
        </span>
        <button onclick="cancelReply(this)" style="margin-left: 8px; flex-shrink: 0;">✕</button>
    `;
    input.parentElement.insertBefore(replyPreview, input);
  
    input.dataset.replyTo = JSON.stringify({
        messageId,
        sender,
        message: content
    });
    
    input.focus();
}

function cancelReply(button) {
    const chatWindow = button.closest('.chat-window');
    const input = chatWindow.querySelector('input[type="text"]');
    input.removeAttribute('data-reply-to');
    button.parentElement.remove();
}

function deleteMessage(messageId) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "delete_message",
            messageId: messageId
        }));
    }
  
    const messageElement = document.querySelector(`.message[data-message-id="${messageId}"]`);
    if (messageElement) {
        messageElement.style.opacity = '0.5';
        messageElement.innerHTML = '<span class="content" style="font-style: italic; color: #999;">Message deleted</span>';
    }
}

function handleMessageDeleted(data) {
    const messageElement = document.querySelector(`.message[data-message-id="${data.messageId}"]`);
    if (messageElement) {
        messageElement.style.opacity = '0.5';
        messageElement.innerHTML = '<span class="content" style="font-style: italic; color: #999;">Message deleted</span>';
    }
}

document.addEventListener("visibilitychange", () => {
    isTabActive = !document.hidden;
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: "status_change",
            isActive: isTabActive
        }));
    }
});
