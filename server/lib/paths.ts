import path from 'path';
import fs from 'fs';

// Prefer the repo-level data directory so recordings and results are kept
// outside server/ even when the app is started from server/.
const cwd = process.cwd();
const serverDir = path.basename(cwd) === 'server' ? cwd : path.join(cwd, 'server');
const repoDataDir = path.resolve(serverDir, '..', 'data');
const localDataDir = path.join(cwd, 'data');

export const SERVER_DIR = serverDir;
export const SERVER_DATA_DIR = path.join(serverDir, 'data');
export const DATA_DIR = fs.existsSync(repoDataDir) || !fs.existsSync(localDataDir)
  ? repoDataDir
  : localDataDir;
export const RESULTS_PATH = path.join(DATA_DIR, 'results.json');
export const RECORDINGS_DIR = path.join(DATA_DIR, 'recordings');
export const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
export const SYNTHETIC_WEBSITES_DIR = path.join(DATA_DIR, 'synthetic-websites');

// Config files live in server/config/, not in data/
const configCandidate = path.join(cwd, 'config');
const configFallback = path.join(cwd, 'server', 'config');
const CONFIG_DIR = fs.existsSync(configCandidate) ? configCandidate : configFallback;

export const PARTICIPANTS_PATH = path.join(CONFIG_DIR, 'participants.json');
export const TRIALS_CONFIG_PATH = path.join(CONFIG_DIR, 'trials-config.json');
