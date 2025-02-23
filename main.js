const { app, BrowserWindow, ipcMain, session, Menu } = require('electron');
const path = require('path');
const { net } = require('electron');
const https = require('https');
const os = require('os');
const { networkInterfaces } = require('systeminformation');

let Store;

async function initStore() {
    try {
        const storeModule = await import('electron-store');
        Store = storeModule.default;

        // Settings Management
        const settingsStore = new Store({
            name: 'browser-settings',
            defaults: {
                startupPage: false,
                newTabDefault: true,
                theme: 'system',
                clearHistoryOnExit: false,
                trackingProtection: true,
                hardwareAcceleration: true,
                downloadLocation: app.getPath('downloads'),
                vpnAutoConnect: false,
                searchEngine: 'google'
            }
        });

        // Expose settingsStore to other functions
        global.settingsStore = settingsStore;
    } catch (error) {
        console.error('Failed to initialize electron-store:', error);
    }
}

// VPN Connection Management
function setupVPNHandlers(mainWindow) {
    // IPC handler for VPN connection
    ipcMain.handle('vpn-connect', async (event, location) => {
        try {
            // Validate location
            if (!PROXY_SERVERS[location]) {
                throw new Error('Invalid VPN location');
            }

            const selectedProxy = PROXY_SERVERS[location];

            // Set system-wide proxy
            app.commandLine.appendSwitch('proxy-server', selectedProxy);

            mainWindow.webContents.send('vpn-status', {
                connected: true,
                message: `Connected via proxy: ${selectedProxy}`,
                proxy: selectedProxy,
                location: location
            });

            return { 
                success: true, 
                message: `Connected to ${location.toUpperCase()} proxy server`,
                proxy: selectedProxy,
                location: location
            };
        } catch (error) {
            mainWindow.webContents.send('vpn-status', {
                connected: false,
                message: 'VPN connection failed'
            });

            return { 
                success: false, 
                message: error.message || 'Failed to connect to VPN' 
            };
        }
    });

    // IPC handler for VPN disconnection
    ipcMain.handle('vpn-disconnect', async (event) => {
        try {
            // Remove proxy settings
            app.commandLine.removeSwitch('proxy-server');

            mainWindow.webContents.send('vpn-status', {
                connected: false,
                message: 'VPN disconnected'
            });

            return { 
                success: true, 
                message: 'Disconnected from proxy' 
            };
        } catch (error) {
            return { 
                success: false, 
                message: error.message || 'Failed to disconnect VPN' 
            };
        }
    });
}

// VPN Proxy Management
function setupProxyHandlers(mainWindow) {
    ipcMain.handle('set-proxy-for-all-tabs', async (event, proxyServer) => {
        try {
            await mainWindow.webContents.session.setProxy({
                proxyRules: proxyServer
            });
            return { success: true };
        } catch (error) {
            return { 
                success: false, 
                message: `Proxy set failed: ${error.message}` 
            };
        }
    });

    ipcMain.handle('clear-proxy-for-all-tabs', async () => {
        try {
            await mainWindow.webContents.session.setProxy({
                proxyRules: ''
            });
            return { success: true };
        } catch (error) {
            return { 
                success: false, 
                message: `Proxy clear failed: ${error.message}` 
            };
        }
    });
}

// History Suggestions Handler
function setupHistorySuggestionsHandler() {
    ipcMain.handle('get-history-suggestions', async (event, query) => {
        try {
            // Retrieve history from the database
            const stmt = db.prepare(`
                SELECT title, url 
                FROM history 
                WHERE title LIKE ? OR url LIKE ? 
                ORDER BY last_visit_time DESC 
                LIMIT 10
            `);
            
            const searchQuery = `%${query}%`;
            const results = stmt.all(searchQuery, searchQuery);
            
            return results.map(item => ({
                title: item.title || item.url,
                url: item.url
            }));
        } catch (error) {
            console.error('Error fetching history suggestions:', error);
            return [];
        }
    });
}

// Network Speed Tracking
function setupNetworkSpeedHandler() {
    ipcMain.handle('get-network-speed', async () => {
        try {
            // Get network interfaces
            const interfaces = await networkInterfaces();
            const activeInterfaces = interfaces.filter(iface => 
                iface.operstate === 'up' && !iface.internal
            );

            if (activeInterfaces.length === 0) {
                return { downloadSpeed: 0, uploadSpeed: 0 };
            }

            // Simulate network speed (you might want to replace this with a more accurate method)
            const downloadSpeed = Math.random() * 50; // Random speed between 0-50 Mbps
            const uploadSpeed = Math.random() * 25;   // Random speed between 0-25 Mbps

            return {
                downloadSpeed: downloadSpeed,
                uploadSpeed: uploadSpeed
            };
        } catch (error) {
            console.error('Network speed tracking error:', error);
            return { downloadSpeed: 0, uploadSpeed: 0 };
        }
    });
}

function setupDownloadHandler(mainWindow) {
    // Download handler
    session.defaultSession.on('will-download', (event, item, webContents) => {
        // Get the download path (you can customize this)
        const downloadPath = path.join(app.getPath('downloads'), item.getFilename());
        
        // Set the save path
        item.setSavePath(downloadPath);
        
        // Notify renderer about download start
        mainWindow.webContents.send('download-started', {
            filename: item.getFilename(),
            savePath: downloadPath
        });
        
        item.on('done', (event, state) => {
            if (state === 'completed') {
                mainWindow.webContents.send('download-completed', {
                    filename: item.getFilename(),
                    savePath: downloadPath
                });
            }
        });
    });

    // Listen for download requests from renderer
    ipcMain.on('download-request', (event, { url }) => {
        mainWindow.webContents.downloadURL(url);
    });
}

function setupSettingsHandlers() {
    // Get current settings
    ipcMain.handle('get-settings', () => {
        return global.settingsStore.store;
    });

    // Update settings
    ipcMain.on('update-settings', (event, settings) => {
        // Update individual settings
        Object.keys(settings).forEach(key => {
            global.settingsStore.set(key, settings[key]);
        });

        // Apply settings immediately
        applySettings(settings);
    });

    // Change download location
    ipcMain.handle('choose-download-location', async () => {
        const { dialog } = require('electron');
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory']
        });

        if (!result.canceled && result.filePaths.length > 0) {
            const selectedPath = result.filePaths[0];
            global.settingsStore.set('downloadLocation', selectedPath);
            return selectedPath;
        }

        return global.settingsStore.get('downloadLocation');
    });
}

function applySettings(settings) {
    // Theme application
    if (settings.theme) {
        mainWindow.webContents.send('apply-theme', settings.theme);
    }

    // Hardware acceleration
    if (settings.hardwareAcceleration !== undefined) {
        app.disableHardwareAcceleration = !settings.hardwareAcceleration;
    }

    // Tracking protection
    if (settings.trackingProtection !== undefined) {
        mainWindow.webContents.session.setPermissionRequestHandler(
            (webContents, permission, callback) => {
                callback(!settings.trackingProtection);
            }
        );
    }

    // Download location
    if (settings.downloadLocation) {
        app.setPath('downloads', settings.downloadLocation);
    }
}

// RAM Usage Tracking
function setupRAMUsageHandler() {
    ipcMain.handle('get-ram-usage', async () => {
        try {
            // Use process.memoryUsage() for more reliable browser-specific memory
            const memoryUsage = process.memoryUsage();
            
            // Convert to MB
            const rssMemoryMB = Math.round(memoryUsage.rss / (1024 * 1024));
            const heapUsedMB = Math.round(memoryUsage.heapUsed / (1024 * 1024));

            return {
                browserRAM: rssMemoryMB,  // Resident Set Size
                heapUsed: heapUsedMB      // JavaScript heap memory
            };
        } catch (error) {
            console.error('RAM usage tracking error:', error);
            return { 
                browserRAM: 0,
                heapUsed: 0
            };
        }
    });
}

// Battery Status Tracking
function setupBatteryStatusHandler() {
    ipcMain.handle('get-battery-status', async () => {
        try {
            // Use Node.js native OS module for battery detection
            const os = require('os');
            const platform = os.platform();

            // Different approaches for different platforms
            switch (platform) {
                case 'darwin':  // macOS
                    return await getMacBatteryStatus();
                case 'win32':   // Windows
                    return await getWindowsBatteryStatus();
                case 'linux':   // Linux
                    return await getLinuxBatteryStatus();
                default:
                    return { 
                        percentage: -1, 
                        isCharging: false, 
                        timeRemaining: 0 
                    };
            }
        } catch (error) {
            console.error('Battery status tracking error:', error);
            return { 
                percentage: -1, 
                isCharging: false, 
                timeRemaining: 0 
            };
        }
    });
}

// macOS Battery Status
async function getMacBatteryStatus() {
    try {
        const { execSync } = require('child_process');
        const batteryInfo = execSync('pmset -g batt').toString();
        const percentMatch = batteryInfo.match(/(\d+)%/);
        const chargingMatch = batteryInfo.includes('charging');

        return {
            percentage: percentMatch ? parseInt(percentMatch[1]) : -1,
            isCharging: chargingMatch,
            timeRemaining: 0
        };
    } catch (error) {
        console.error('Mac battery status error:', error);
        return { percentage: -1, isCharging: false, timeRemaining: 0 };
    }
}

// Windows Battery Status
async function getWindowsBatteryStatus() {
    try {
        const { execSync } = require('child_process');
        const batteryInfo = execSync('powercfg /batteryreport /output battery_report.html').toString();
        // Implement parsing logic for Windows battery report
        return { percentage: -1, isCharging: false, timeRemaining: 0 };
    } catch (error) {
        console.error('Windows battery status error:', error);
        return { percentage: -1, isCharging: false, timeRemaining: 0 };
    }
}

// Linux Battery Status
async function getLinuxBatteryStatus() {
    try {
        const fs = require('fs');
        const batteryPath = '/sys/class/power_supply/BAT0';
        
        if (!fs.existsSync(batteryPath)) {
            return { percentage: -1, isCharging: false, timeRemaining: 0 };
        }

        const capacityPath = `${batteryPath}/capacity`;
        const statusPath = `${batteryPath}/status`;

        const capacity = parseInt(fs.readFileSync(capacityPath, 'utf8').trim());
        const status = fs.readFileSync(statusPath, 'utf8').trim();

        return {
            percentage: !isNaN(capacity) ? capacity : -1,
            isCharging: status === 'Charging',
            timeRemaining: 0
        };
    } catch (error) {
        console.error('Linux battery status error:', error);
        return { percentage: -1, isCharging: false, timeRemaining: 0 };
    }
}

async function createWindow() {
    // Initialize electron-store first
    await initStore();

    let mainWindow;

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'codebro',
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webviewTag: true,
            webSecurity: false
        },
    });
    // Disable context menu
    Menu.setApplicationMenu(null);
    // Setup download handler
    setupDownloadHandler(mainWindow);

    // Setup VPN handlers
    setupVPNHandlers(mainWindow);

    // Setup proxy handlers
    setupProxyHandlers(mainWindow);

    // Setup history suggestions handler
    setupHistorySuggestionsHandler();

    // Setup network speed handler
    setupNetworkSpeedHandler();

    // Setup RAM usage handler
    setupRAMUsageHandler();

    // Setup battery status handler
    setupBatteryStatusHandler();

    // Setup settings handlers
    setupSettingsHandlers();

    // Apply initial settings
    if (global.settingsStore) {
        applySettings(global.settingsStore.store);
    }

    // Rest of your existing window setup code
    mainWindow.loadFile('index.html');
    mainWindow.setTitle('codebro');
    // mainWindow.webContents.openDevTools(); // Open DevTools for debugging
}

const PROXY_SERVERS = {
    us: 'us-wa.proxyme.org',
    uk: 'uk-lon.proxyme.org',
    de: 'de-fra.proxyme.org',
    ca: 'ca-tor.proxyme.org',
    nl: 'nl-ams.proxyme.org'
};

app.whenReady().then(createWindow);

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
