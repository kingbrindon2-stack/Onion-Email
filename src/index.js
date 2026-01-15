import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import apiRoutes from './api/routes.js';
import { logger } from './services/logger.js';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// API routes
app.use('/api', apiRoutes);

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║     Feishu-Didi Onboarding Hub                            ║
║                                                           ║
║     Web Dashboard: http://localhost:${PORT}                  ║
║     API Base:      http://localhost:${PORT}/api              ║
║                                                           ║
║     MCP Server:    npm run mcp                            ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

export default app;
