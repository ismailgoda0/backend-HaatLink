import path from 'path';
import fs from 'fs';
import { spawn, execSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { config } from '../../config/env';

export interface YtDlpResolution {
  command: string;
  argsPrefix: string[];
}

let cachedFfmpegPath: string | null | undefined = undefined;

/**
 * Discovers available FFmpeg binary path (in env, bin/ directory, or system PATH).
 */
export function getFfmpegPath(): string | null {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;

  // 1. Env variable override
  if (config.ffmpegPath && fs.existsSync(config.ffmpegPath)) {
    cachedFfmpegPath = config.ffmpegPath;
    return cachedFfmpegPath;
  }

  // 2. Project bin/ directory
  const binDir = path.join(process.cwd(), 'bin');
  const winExe = path.join(binDir, 'ffmpeg.exe');
  const unixBin = path.join(binDir, 'ffmpeg');
  if (fs.existsSync(winExe)) {
    cachedFfmpegPath = winExe;
    return cachedFfmpegPath;
  }
  if (fs.existsSync(unixBin)) {
    cachedFfmpegPath = unixBin;
    return cachedFfmpegPath;
  }

  // 3. System PATH check
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    const found = execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim().split(/\r?\n/)[0];
    if (found && fs.existsSync(found)) {
      cachedFfmpegPath = found;
      return cachedFfmpegPath;
    }
  } catch {}

  cachedFfmpegPath = null;
  return cachedFfmpegPath;
}

export function isFfmpegAvailable(): boolean {
  return getFfmpegPath() !== null;
}

/**
 * Determines the best command and argument prefix to execute yt-dlp across platforms.
 */
export function getYtDlpCommand(): YtDlpResolution {
  // 1. Explicit environment variable override
  if (config.ytdlpPath && fs.existsSync(config.ytdlpPath)) {
    return { command: config.ytdlpPath, argsPrefix: [] };
  }

  const binDir = path.join(process.cwd(), 'bin');
  const exePath = path.join(binDir, 'yt-dlp.exe');
  const unixPath = path.join(binDir, 'yt-dlp');

  // 2. Windows standalone executable in bin/
  if (process.platform === 'win32' && fs.existsSync(exePath)) {
    return { command: exePath, argsPrefix: [] };
  }

  // 3. Bundled script/zipapp in bin/yt-dlp
  if (fs.existsSync(unixPath)) {
    if (process.platform === 'win32') {
      return { command: 'python', argsPrefix: [unixPath] };
    }
    return { command: unixPath, argsPrefix: [] };
  }

  // 4. Standalone exe fallback (if renamed or cross-mounted)
  if (fs.existsSync(exePath)) {
    return { command: exePath, argsPrefix: [] };
  }

  // 5. Fallback to system PATH
  return { command: 'yt-dlp', argsPrefix: [] };
}

/**
 * Checks if yt-dlp is available in bin/ or via custom path.
 */
export function isYtDlpAvailable(): boolean {
  try {
    const resolved = getYtDlpCommand();
    if (path.isAbsolute(resolved.command) || resolved.command.includes(path.sep)) return fs.existsSync(resolved.command);
    const cmd = process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
    execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    return true;
  } catch { return false; }
}

/**
 * Spawns yt-dlp safely across Windows and Unix platforms with optimal runtimes & ffmpeg.
 */
export function terminateProcessTree(child: ChildProcess): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore', timeout: 5000 });
    } else {
      child.kill('SIGTERM');
    }
  } catch { try { child.kill('SIGKILL'); } catch {} }
}

export function spawnYtDlp(args: string[], options: SpawnOptions = {}): ChildProcess {
  const { command, argsPrefix } = getYtDlpCommand();
  const defaultExtras: string[] = [];

  // Enable Node.js for YouTube JS challenges if not already specified
  if (!args.includes('--js-runtimes')) defaultExtras.push('--js-runtimes', 'node');
  // Modern YouTube extraction may require yt-dlp's EJS challenge scripts.
  // The official GitHub component is fetched only when yt-dlp needs it.
  if (!args.includes('--remote-components')) defaultExtras.push('--remote-components', 'ejs:github');

  // Inject ffmpeg location if available and not explicitly provided
  const ffmpeg = getFfmpegPath();
  if (ffmpeg && !args.includes('--ffmpeg-location')) {
    defaultExtras.push('--ffmpeg-location', path.dirname(ffmpeg));
  }

  const finalArgs = [...argsPrefix, ...defaultExtras, ...args];
  return spawn(command, finalArgs, options);
}

