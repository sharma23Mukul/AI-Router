const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');

const logDir = path.resolve(__dirname, '../../../logs');

class LoggerWrapper {
  constructor(winstonLogger, labelName) {
    this.winstonLogger = winstonLogger;
    this.labelName = labelName;
  }

  log(level, ...args) {
    if (args.length === 0) return;

    let msg = '';
    let meta = {};
    let splat = [];

    if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
      meta = args[0];
      msg = args[1] || '';
      splat = args.slice(2);
    } else {
      msg = args[0];
      if (args.length > 2 || typeof args[1] !== 'object' || args[1] === null || args[1] instanceof Error) {
        splat = args.slice(1);
      } else {
        meta = args[1] || {};
      }
    }

    // Standardize error formats for winston if present
    if (meta.err && meta.err instanceof Error) {
      meta.error = {
        message: meta.err.message,
        stack: meta.err.stack
      };
    }
    if (args[0] instanceof Error) {
      meta.error = {
        message: args[0].message,
        stack: args[0].stack
      };
      if (!msg) msg = args[0].message;
    }

    this.winstonLogger.log(level, msg, ...splat, meta);
  }

  trace(...args) { this.log('verbose', ...args); }
  debug(...args) { this.log('debug', ...args); }
  info(...args) { this.log('info', ...args); }
  warn(...args) { this.log('warn', ...args); }
  error(...args) { this.log('error', ...args); }
  fatal(...args) { this.log('error', ...args); }

  child(meta = {}) {
    const childLabel = meta.name || meta.module || this.labelName;
    return new LoggerWrapper(this.winstonLogger.child(meta), childLabel);
  }
}

function getWinstonLogger(labelName) {
  const isProduction = process.env.NODE_ENV === 'production';
  const logLevel = process.env.LOG_LEVEL || 'info';

  const consoleFormat = isProduction
    ? winston.format.combine(
        winston.format.label({ label: labelName }),
        winston.format.timestamp(),
        winston.format.json()
      )
    : winston.format.combine(
        winston.format.label({ label: labelName }),
        winston.format.colorize(),
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, label, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `[${timestamp}] [${label}] ${level}: ${message}${metaStr}`;
        })
      );

  const fileFormat = winston.format.combine(
    winston.format.label({ label: labelName }),
    winston.format.timestamp(),
    winston.format.json()
  );

  return winston.createLogger({
    level: logLevel,
    levels: winston.config.npm.levels,
    format: winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json()
    ),
    transports: [
      new winston.transports.Console({
        level: logLevel,
        format: consoleFormat
      }),
      new winston.transports.DailyRotateFile({
        dirname: logDir,
        filename: 'app-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        maxSize: '20m',
        maxFiles: '14d',
        level: logLevel,
        format: fileFormat
      })
    ]
  });
}

function createLogger(name) {
  const winstonInstance = getWinstonLogger(name);
  return new LoggerWrapper(winstonInstance, name);
}

module.exports = {
  createLogger,
  logger: createLogger('app')
};
