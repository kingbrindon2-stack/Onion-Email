import { EventEmitter } from 'events';

class LoggerService extends EventEmitter {
  constructor() {
    super();
    this.logs = [];
    this.maxLogs = 1000;
  }

  log(level, message, data = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
    };

    this.logs.push(logEntry);
    
    // Keep logs bounded
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Emit for SSE streaming
    this.emit('log', logEntry);

    // Also console log
    const prefix = `[${logEntry.timestamp}] [${level.toUpperCase()}]`;
    console.log(`${prefix} ${message}`, data);

    return logEntry;
  }

  info(message, data) {
    return this.log('info', message, data);
  }

  success(message, data) {
    return this.log('success', message, data);
  }

  warn(message, data) {
    return this.log('warn', message, data);
  }

  error(message, data) {
    return this.log('error', message, data);
  }

  getRecentLogs(count = 100) {
    return this.logs.slice(-count);
  }

  clear() {
    this.logs = [];
  }
}

export const logger = new LoggerService();
