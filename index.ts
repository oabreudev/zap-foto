import express, { Request, Response, NextFunction } from 'express';
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import winston from 'winston';

const app = express();
const port = process.env.PORT || 4000;
app.use(cors());

// Logger configuration
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple(),
    }));
}

let sock: ReturnType<typeof makeWASocket>;

async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
        
        const { version, isLatest } = await fetchLatestBaileysVersion();
        logger.info(`Using Baileys version: ${version}, isLatest: ${isLatest}`);

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: true,
        });

        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                logger.info('connection closed due to ', lastDisconnect?.error, ', reconnecting ', shouldReconnect);
                if (shouldReconnect) {
                    connectToWhatsApp();
                }
            } else if (connection === 'open') {
                logger.info('Successfully connected to WhatsApp!');
            }
        });

        sock.ev.on('creds.update', saveCreds);
    } catch (error) {
        logger.error('Error connecting to WhatsApp:', error);
        setTimeout(connectToWhatsApp, 5000); // Try to reconnect after 5 seconds
    }
}

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
app.post('/enviar-mensagem', async (req: Request, res: Response) => {
    const { phone, name } = req.body;

    if (!phone || !name) {
        return res.status(400).json({ error: 'Phone and name are required' });
    }

    if (!sock) {
        logger.error('WhatsApp is not connected');
        return res.status(500).json({ error: 'WhatsApp is not connected' });
    }

    try {
        const [result] = await sock.onWhatsApp(phone);
        if (result?.exists) {
            const message = `Olá, ${name}! Agradecemos por confirmar sua presença no nosso chá de bebê! Estamos muito animados para celebrar esse momento especial com você. Se puder, seria maravilhoso se a mulher trouxesse um presente de sua escolha, e, se o homem puder trazer um pacote de fraldas (M, G ou GG), será muito bem-vindo. Mas, acima de tudo, sua presença é o que mais importa! Nos vemos em breve!`;

            await sock.sendMessage(result.jid, { text: message });

            logger.info(`Message sent successfully to ${phone}`);
            return res.json({ success: true, message: 'Message sent successfully!' });
        } else {
            logger.warn(`Number not found on WhatsApp: ${phone}`);
            return res.status(404).json({ error: 'Number not found on WhatsApp' });
        }
    } catch (error) {
        logger.error('Error sending message:', error);
        return res.status(500).json({ error: 'Error sending message' });
    }
});

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