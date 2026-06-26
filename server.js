const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Global Shared Game State
let gameState = {
    phase: 'setup', 
    config: {
        purse: 10000,
        timerDuration: 15,
        maxPlayers: 20,
        superPowerEnabled: true,
        minRatings: { GK: 87, DF: 84, CM: 84, ST: 85 }
    },
    managers: {}, 
    playerPool: [], 
    unsoldPool: [], 
    currentPlayer: null,
    currentBid: 0,
    highestBidderId: null,
    timerValue: 0,
    biddingHistory: [],
    lastAuctionAction: null 
};

const MANAGER_COLORS = [
    '#EF4444', '#10B981', '#3B82F6', '#F59E0B', '#8B5CF6',
    '#EC4899', '#6366F1', '#F97316', '#14B8A6', '#06B6D4'
];
let timerInterval = null;

// Serve static frontend files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

function runTimer() {
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        if (gameState.phase === 'phase1' || gameState.phase === 'phase2') {
            if (gameState.currentPlayer && gameState.timerValue > 0) {
                gameState.timerValue--;
                io.emit('state-update', gameState);
                
                if (gameState.timerValue === 0) {
                    clearInterval(timerInterval);
                    autoHammerDown();
                }
            }
        }
    }, 1000);
}

function autoHammerDown() {
    if (!gameState.currentPlayer) return;
    
    if (gameState.highestBidderId && gameState.currentBid > 0) {
        // Sold successfully
        const manager = gameState.managers[gameState.highestBidderId];
        manager.budget -= gameState.currentBid;
        
        const boughtPlayer = { ...gameState.currentPlayer, finalPrice: gameState.currentBid };
        manager.squad.push(boughtPlayer);
        
        gameState.lastAuctionAction = {
            status: 'sold',
            player: gameState.currentPlayer,
            managerId: gameState.highestBidderId,
            price: gameState.currentBid
        };
        
        gameState.biddingHistory.push({ text: `🔨 SOLD! ${gameState.currentPlayer.Name} to ${manager.name} for ${gameState.currentBid}c!`, color: '#F59E0B' });
    } else {
        // Unsold, send to Phase 1 Unsold list
        gameState.unsoldPool.push(gameState.currentPlayer);
        gameState.lastAuctionAction = {
            status: 'skipped',
            player: gameState.currentPlayer
        };
        gameState.biddingHistory.push({ text: `❌ ${gameState.currentPlayer.Name} went unsold and was skipped.`, color: '#9CA3AF' });
    }
    
    gameState.currentPlayer = null;
    gameState.currentBid = 0;
    gameState.highestBidderId = null;
    io.emit('state-update', gameState);
}

io.on('connection', (socket) => {
    socket.emit('state-update', gameState);

    socket.on('register-manager', (name) => {
        const count = Object.keys(gameState.managers).length;
        if (count >= 10) {
            socket.emit('error-msg', 'Roster is full! Max 10 managers.');
            return;
        }
        gameState.managers[socket.id] = {
            name: name,
            budget: gameState.config.purse,
            squad: [],
            color: MANAGER_COLORS[count % MANAGER_COLORS.length],
            hasSuperPower: gameState.config.superPowerEnabled
        };
        gameState.biddingHistory.push({ text: `👋 Manager ${name} joined the arena.`, color: '#10B981' });
        io.emit('state-update', gameState);
    });

    socket.on('admin-init-game', (config, parsedPlayers) => {
        gameState.config = config;
        gameState.playerPool = parsedPlayers;
        gameState.unsoldPool = [];
        gameState.phase = 'phase1';
        gameState.currentPlayer = null;
        gameState.biddingHistory = [{ text: '🚀 Phase 1 Auction is Live!', color: '#3B82F6' }];
        
        Object.keys(gameState.managers).forEach(id => {
            gameState.managers[id].budget = config.purse;
            gameState.managers[id].squad = [];
            gameState.managers[id].hasSuperPower = config.superPowerEnabled;
        });
        
        io.emit('state-update', gameState);
    });

    socket.on('draw-player', (role) => {
        clearInterval(timerInterval);
        
        let pool = (gameState.phase === 'phase2') ? gameState.unsoldPool : gameState.playerPool;
        let available = pool.filter(p => p.RoleGroup === role && !p.status);
        
        if (available.length === 0) {
            socket.emit('error-msg', `No remaining players found for ${role} in this phase!`);
            return;
        }
        
        const randomIndex = Math.floor(Math.random() * available.length);
        const selected = available[randomIndex];
        
        selected.status = 'drawn';
        gameState.currentPlayer = selected;
        gameState.currentBid = selected.Rating >= 91 ? 500 : 100;
        gameState.highestBidderId = null;
        gameState.timerValue = gameState.config.timerDuration;
        gameState.biddingHistory = []; 
        
        gameState.biddingHistory.push({ text: `🎯 Drawn: ${selected.Name} (${selected.Rating} OVR) - Base: ${gameState.currentBid}c`, color: '#FFFFFF' });
        
        io.emit('state-update', gameState);
        runTimer();
    });

    socket.on('place-bid', () => {
        const managerId = socket.id;
        const manager = gameState.managers[managerId];
        
        if (!gameState.currentPlayer || !manager) return;
        if (managerId === gameState.highestBidderId) return; 
        if (manager.squad.length >= gameState.config.maxPlayers) {
            socket.emit('error-msg', 'Hard squad cap reached!');
            return;
        }

        let currentPrice = gameState.currentBid;
        let increment = currentPrice < 1000 ? 50 : 100;
        let nextBidValue = currentPrice + increment;

        let requiredRemainingSlots = Math.max(0, 15 - (manager.squad.length + 1));
        let safetyBuffer = requiredRemainingSlots * 100;

        if (manager.budget - nextBidValue < safetyBuffer) {
            socket.emit('error-msg', `Bid blocked! You must save at least ${safetyBuffer}c to draft a minimum squad of 15 players.`);
            return;
        }

        gameState.currentBid = nextBidValue;
        gameState.highestBidderId = managerId;
        gameState.timerValue = gameState.config.timerDuration; 
        
        gameState.biddingHistory.push({ text: `🔥 ${manager.name} bid ${nextBidValue}c`, color: manager.color });
        io.emit('state-update', gameState);
    });

    socket.on('admin-force-hammer', () => {
        clearInterval(timerInterval);
        autoHammerDown();
    });

    socket.on('admin-trigger-rebid', () => {
        if (!gameState.lastAuctionAction || gameState.lastAuctionAction.used) return;
        
        const action = gameState.lastAuctionAction;
        action.used = true;
        
        if (action.status === 'sold') {
            const manager = gameState.managers[action.managerId];
            manager.budget += action.price;
            manager.squad = manager.squad.filter(p => p.Name !== action.player.Name);
            
            gameState.currentPlayer = action.player;
            gameState.currentBid = action.price;
            gameState.highestBidderId = action.managerId;
        } else {
            gameState.unsoldPool = gameState.unsoldPool.filter(p => p.Name !== action.player.Name);
            gameState.currentPlayer = action.player;
            gameState.currentBid = action.player.Rating >= 91 ? 500 : 100;
            gameState.highestBidderId = null;
        }
        
        gameState.timerValue = gameState.config.timerDuration;
        gameState.biddingHistory.push({ text: `🔄 Admin triggered Rebid for ${action.player.Name}!`, color: '#3B82F6' });
        
        io.emit('state-update', gameState);
        runTimer();
    });

    socket.on('use-super-power', (playerName) => {
        const managerId = socket.id;
        const manager = gameState.managers[managerId];
        
        if (!manager || !manager.hasSuperPower || gameState.currentPlayer) return;
        
        const targetIndex = manager.squad.findIndex(p => p.Name === playerName);
        if (targetIndex === -1) return;
        
        const playerObj = manager.squad[targetIndex];
        manager.budget += playerObj.finalPrice;
        manager.squad.splice(targetIndex, 1);
        manager.hasSuperPower = false; 
        
        gameState.currentPlayer = playerObj;
        gameState.currentBid = playerObj.Rating >= 91 ? 500 : 100;
        gameState.highestBidderId = null;
        gameState.timerValue = gameState.config.timerDuration;
        gameState.biddingHistory = [{ text: `⚡ SUPER POWER! ${manager.name} dropped ${playerObj.Name}. Re-auction starting now!`, color: '#8B5CF6' }];
        
        io.emit('state-update', gameState);
        runTimer();
    });

    socket.on('admin-end-phase1', () => {
        clearInterval(timerInterval);
        gameState.currentPlayer = null;
        gameState.playerPool = [];
        gameState.phase = 'phase2-prompt';
        io.emit('state-update', gameState);
    });

    socket.on('admin-phase2-decision', (agreed) => {
        if (agreed) {
            gameState.phase = 'phase2';
            gameState.unsoldPool.forEach(p => p.status = null);
            gameState.biddingHistory = [{ text: '🏁 Phase 2 Activated: Bidding on Unsold Pools Only!', color: '#10B981' }];
        } else {
            gameState.phase = 'finished';
            gameState.biddingHistory.push({ text: '🛑 Auction terminated by Host.', color: '#EF4444' });
        }
        io.emit('state-update', gameState);
    });

    socket.on('admin-restart-game', () => {
        clearInterval(timerInterval);
        gameState = {
            phase: 'setup',
            config: { purse: 10000, timerDuration: 15, maxPlayers: 20, superPowerEnabled: true, minRatings: { GK: 87, DF: 84, CM: 84, ST: 85 } },
            managers: {},
            playerPool: [],
            unsoldPool: [],
            currentPlayer: null,
            currentBid: 0,
            highestBidderId: null,
            timerValue: 0,
            biddingHistory: [],
            lastAuctionAction: null
        };
        io.emit('state-update', gameState);
    });

    socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🔥 Live Draft Server running on port ${PORT}`));