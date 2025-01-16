import express, { Request, Response, NextFunction } from 'express';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import winston from 'winston';
import qrcode from 'qrcode-terminal';

const app = express();
const port = process.env.PORT || 4000;

// Logger configuration with better formatting
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.simple()
        ),
    }));
}

let sock: ReturnType<typeof makeWASocket>;
let qrDisplayed = false;

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        const { version, isLatest } = await fetchLatestBaileysVersion();
        logger.info(`Using Baileys version: ${version}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false, // We'll handle QR display ourselves
            logger: logger,
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr && !qrDisplayed) {
                qrDisplayed = true;
                console.clear(); // Clear console for better visibility
                logger.info('='.repeat(50));
                logger.info('Scan this QR code in WhatsApp:');
                logger.info('='.repeat(50));
                
                // Generate QR with better visibility settings
                qrcode.generate(qr, {
                    small: false,
                    scale: 8
                });
                
                logger.info('='.repeat(50));
                logger.info('Waiting for QR code scan...');
            }

            if (connection === 'close') {
                qrDisplayed = false;
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                logger.info(`Connection closed due to ${(lastDisconnect?.error as Error)?.message || 'unknown reason'}`);
                logger.info(`Reconnecting: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    setTimeout(connectToWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                qrDisplayed = false;
                logger.info('='.repeat(50));
                logger.info('Successfully connected to WhatsApp!');
                logger.info('='.repeat(50));
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (error) {
        logger.error('Error connecting to WhatsApp:', error);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// Start the connection process
connectToWhatsApp();

// Middlewares
app.use(cors());
app.use(helmet());
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per window
});
app.use(limiter);

// Route to send message

// Route to fetch profile picture
app.get('/buscar-foto/:phone', async (req: Request, res: Response) => {
    const { phone } = req.params;

    if (!phone) {
        return res.status(400).json({ error: 'Phone number is required' });
    }

    if (!sock) {
        logger.error('WhatsApp is not connected');
        return res.status(500).json({ error: 'WhatsApp is not connected' });
    }

    try {
        // Verify if number exists on WhatsApp
        const [result] = await sock.onWhatsApp(phone);
        
        if (!result?.exists) {
            logger.warn(`Number not found on WhatsApp: ${phone}`);
            return res.status(404).json({ error: 'Number not found on WhatsApp' });
        }

        try {
            // Try to get high resolution profile picture
            const profilePicUrl = await sock.profilePictureUrl(result.jid, 'image');
            logger.info(`Profile picture found for ${phone}`);
            return res.json({ 
                success: true, 
                phone,
                profilePicUrl 
            });
        } catch (error) {
            // If unable to get picture, user might not have one or it's private
            logger.warn(`No profile picture available for ${phone}`);
            return res.status(404).json({ 
                error: 'No profile picture available',
                details: 'User might not have a profile picture or it might be private'
            });
        }

    } catch (error) {
        logger.error('Error fetching profile picture:', error);
        return res.status(500).json({ 
            error: 'Error fetching profile picture',
            details: error instanceof Error ? error.message : 'Unknown error'
        });
    }
});

// Global error handling
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error(err.stack);
    res.status(500).send('Something went wrong!');
});

app.listen(port, () => {
    logger.info(`API running at http://localhost:${port}`);
});

// Handling uncaught exceptions
process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
});
