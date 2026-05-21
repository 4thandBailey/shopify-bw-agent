'use strict';
/**
 * utils/logger.js
 * Structured logger with daily rotating file transport and console output.
 * Log files are written to the configured LOG_DIR directory.
 */

const { createLogger, format, transports } = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const config = require('../config');

const { combine, timestamp, printf, colorize, errors } = format;

// ── Custom log line format ────────────────────────────────────────────────────
const lineFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  let line = `${ts} [${level.toUpperCase().padEnd(5)}] ${message}`;
  if (stack) line += `\n${stack}`;
  const extras = Object.keys(meta).filter(k => k !== 'service');
  if (extras.length > 0) {
    line += `  ${JSON.stringify(meta, null, 0)}`;
  }
  return line;
});

// ── File transports ────────────────────────────────────────────────────────────
const fileTransport = new DailyRotateFile({
  dirname:       config.agent.logDir,
  filename:      'shopify-bw-agent-%DATE%.log',
  datePattern:   'YYYY-MM-DD',
  zippedArchive: true,
  maxFiles:      `${config.agent.logRetentionDays}d`,
  level:         config.agent.logLevel,
  format:        combine(timestamp(), errors({ stack: true }), lineFormat),
});

const errorTransport = new DailyRotateFile({
  dirname:       config.agent.logDir,
  filename:      'shopify-bw-agent-error-%DATE%.log',
  datePattern:   'YYYY-MM-DD',
  zippedArchive: true,
  maxFiles:      `${config.agent.logRetentionDays}d`,
  level:         'error',
  format:        combine(timestamp(), errors({ stack: true }), lineFormat),
});

// ── Console transport ─────────────────────────────────────────────────────────
const consoleTransport = new transports.Console({
  level:  config.agent.logLevel,
  format: combine(
    colorize({ all: true }),
    timestamp({ format: 'HH:mm:ss' }),
    errors({ stack: true }),
    lineFormat,
  ),
});

// ── Logger instance ───────────────────────────────────────────────────────────
const logger = createLogger({
  defaultMeta: { service: 'shopify-bw-agent' },
  transports:  [fileTransport, errorTransport, consoleTransport],
  exitOnError: false,
});

// ── Child logger factory ──────────────────────────────────────────────────────
logger.child = (meta) => logger.child(meta);

/**
 * Returns a labelled child logger for a named module.
 * Usage: const log = require('./logger').forModule('OrderFlow');
 */
logger.forModule = (moduleName) =>
  logger.child({ module: moduleName });

module.exports = logger;
