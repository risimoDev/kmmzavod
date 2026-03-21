import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  ...(config.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
    },
  }),
  base: { service: 'api' },
  redact: {
    paths: ['req.headers.authorization', 'body.password', 'body.password_hash'],
    censor: '[REDACTED]',
  },
});
