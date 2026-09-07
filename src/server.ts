import { app } from './app';
import { config } from './config/env';

const server = app.listen(config.port, config.host, () => {
  console.log(`هات لينك | Haat Link server running on http://${config.host}:${config.port}`);
});

function shutdown(signal: string) {
  console.log(`[HAAT] ${signal} received; shutting down gracefully...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
