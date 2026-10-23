import { pino } from 'pino';

export type Logger = pino.Logger;

export function createLogger(
  service: string,
  level: string,
  destination?: pino.DestinationStream,
): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service },
    // Belt and braces: nothing should log headers or tokens, but if it does, they are censored.
    redact: {
      paths: ['authorization', '*.authorization', '*.headers.authorization', 'token', '*.token'],
      censor: '[REDACTED]',
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
