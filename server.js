const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        // Allow images and common file types
        const allowedTypes = /jpeg|jpg|png|gif|pdf|txt|doc|docx/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Only images and documents are allowed'));
        }
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' })); // For base64 image data

// File upload endpoint
app.post('/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }
    
    res.json({
        filename: req.file.filename,
        originalName: req.file.originalname,
        size: req.file.size,
        url: `/uploads/${req.file.filename}`
    });
});

// Screenshot upload endpoint for base64 data
app.post('/upload-screenshot', (req, res) => {
    try {
        const { imageData, filename } = req.body;
        
        if (!imageData || !filename) {
            return res.status(400).json({ error: 'Missing image data or filename' });
        }
        
        // Remove data:image/png;base64, prefix
        const base64Data = imageData.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');
        
        const uniqueFilename = Date.now() + '-' + filename;
        const filepath = path.join(uploadsDir, uniqueFilename);
        
        fs.writeFileSync(filepath, buffer);
        
        res.json({
            filename: uniqueFilename,
            originalName: filename,
            size: buffer.length,
            url: `/uploads/${uniqueFilename}`
        });
    } catch (error) {
        console.error('Screenshot upload error:', error);
        res.status(500).json({ error: 'Failed to upload screenshot' });
    }
});

// Modified clients Map to include status and message tracking
const clients = new Map();
const messageStore = new Map(); // Store messages with their IDs

// Heartbeat to prevent disconnections
const heartbeatInterval = setInterval(() => {
    clients.forEach((userData, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        } else {
            clients.delete(ws);
            broadcastUserList();
        }
    });
}, 30000); // Ping every 30 seconds

wss.on('connection', (ws) => {
    let userData = { username: '', ws, isActive: true, lastSeen: Date.now() };
    
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
        userData.lastSeen = Date.now();
    });
    
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            userData.lastSeen = Date.now();
            
            switch (data.type) {
                case 'join':
                    userData.username = data.username;
                    clients.set(ws, userData);
                    broadcastUserList();
                    break;
                    
                case 'status_change':
                    userData.isActive = data.isActive;
                    clients.set(ws, userData);
                    broadcastUserList();
                    break;
                    
                case 'chat':
                    sendPrivateMessage(data, userData.username);
                    break;
                    
                case 'group_chat':
                    broadcastGroupMessage(data, userData.username);
                    break;
                    
                case 'ping':
                    sendPing(data, userData.username);
                    break;
                    
                case 'delete_message':
                    handleDeleteMessage(data, userData.username);
                    break;
                case 'disconnect':
                  handleUserDisconnect(ws, userData.username);
                  break;
            }
        } catch (error) {
            console.error('Error processing message:', error);
        }
    });
    
    ws.on('close', () => {
        clients.delete(ws);
        broadcastUserList();
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        clients.delete(ws);
        broadcastUserList();
    });
});

function broadcastUserList() {
    const userList = Array.from(clients.values()).map(client => ({
        username: client.username,
        isActive: client.isActive
    }));
    const message = JSON.stringify({ type: 'users', users: userList });
    clients.forEach(({ ws }) => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(message);
        }
    });
}

function sendPrivateMessage(data, fromUsername) {
    const messageId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const messageData = {
        id: messageId,
        type: 'chat',
        from: fromUsername,
        to: data.to,
        message: data.message,
        fileUrl: data.fileUrl,
        fileName: data.fileName,
        fileSize: data.fileSize,
        replyTo: data.replyTo,
        timestamp: new Date().toISOString()
    };
    
    // Store message for deletion tracking
    messageStore.set(messageId, { ...messageData, sender: fromUsername });
    
    const targetClient = Array.from(clients.values()).find(client => client.username === data.to);
    if (targetClient?.ws.readyState === WebSocket.OPEN) {
        targetClient.ws.send(JSON.stringify(messageData));
    }
}

function broadcastGroupMessage(data, fromUsername) {
    const messageId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    const messageData = {
        id: messageId,
        type: 'group_chat',
        from: fromUsername,
        message: data.message,
        fileUrl: data.fileUrl,
        fileName: data.fileName,
        fileSize: data.fileSize,
        replyTo: data.replyTo,
        timestamp: new Date().toISOString()
    };
    
    // Store message for deletion tracking
    messageStore.set(messageId, { ...messageData, sender: fromUsername });
    
    clients.forEach(({ ws, username }) => {
        if (ws.readyState === WebSocket.OPEN && username !== fromUsername) {
            ws.send(JSON.stringify(messageData));
        }
    });
}

function sendPing(data, fromUsername) {
    const targetClient = Array.from(clients.values()).find(client => client.username === data.to);
    if (targetClient?.ws.readyState === WebSocket.OPEN) {
        targetClient.ws.send(JSON.stringify({ type: 'ping', from: fromUsername }));
    }
}

function handleDeleteMessage(data, fromUsername) {
    const messageId = data.messageId;
    const storedMessage = messageStore.get(messageId);
    
    // Only allow deletion if the user is the sender
    if (storedMessage && storedMessage.sender === fromUsername) {
        messageStore.delete(messageId);
        
        // Broadcast deletion to all relevant clients
        const deleteData = {
            type: 'message_deleted',
            messageId: messageId,
            deletedBy: fromUsername
        };
        
        if (storedMessage.type === 'group_chat') {
            // Broadcast to all group chat participants
            clients.forEach(({ ws, username }) => {
                if (ws.readyState === WebSocket.OPEN && username !== fromUsername) {
                    ws.send(JSON.stringify(deleteData));
                }
            });
        } else if (storedMessage.type === 'chat') {
            // Send to the other participant in private chat
            const targetClient = Array.from(clients.values()).find(client => 
                client.username === storedMessage.to || client.username === storedMessage.from
            );
            if (targetClient?.ws.readyState === WebSocket.OPEN) {
                targetClient.ws.send(JSON.stringify(deleteData));
            }
        }
    }
}


function handleUserDisconnect(ws, username) {
    clients.delete(ws);
    
    // Check if this was the last user
    if (clients.size === 0) {
        // Delete all uploaded files
        if (fs.existsSync(uploadsDir)) {
            fs.readdir(uploadsDir, (err, files) => {
                if (!err) {
                    files.forEach(file => {
                        fs.unlink(path.join(uploadsDir, file), (err) => {
                            if (err) console.error('Error deleting file:', err);
                        });
                    });
                }
            });
        }
        
        // Clear message store
        messageStore.clear();
        
        console.log('Last user disconnected - cleaned up uploads');
    }
    
    broadcastUserList();
}
ws.on('close', () => {
    if (userData.username) {
        handleUserDisconnect(ws, userData.username);
    } else {
        clients.delete(ws);
        broadcastUserList();
    }
});
// Clean up old messages periodically (optional)
setInterval(() => {
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    for (const [messageId, message] of messageStore.entries()) {
        if (new Date(message.timestamp).getTime() < oneHourAgo) {
            messageStore.delete(messageId);
        }
    }
}, 60 * 60 * 1000); // Clean up every hour

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
