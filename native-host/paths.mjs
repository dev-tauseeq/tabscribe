import { homedir } from 'node:os';
import { join } from 'node:path';

// Keep in sync with HELPER_NAME in src/lib/helper.ts.
export const HELPER_NAME = 'com.meetingrecorder.helper';
export const HELPER_VERSION = 1;

// The ID the Chrome Web Store gives the extension. It is shown in the developer dashboard after
// the first upload; set it here so npm run setup lets the published extension use the helper.
export const STORE_EXTENSION_ID = '';

export const SUPPORT_DIR = join(homedir(), 'Library', 'Application Support', 'Meeting Recorder');
export const HELPER_DIR = join(SUPPORT_DIR, 'helper');
export const CONFIG_FILE = join(SUPPORT_DIR, 'helper.json');
export const LAUNCHER_FILE = join(SUPPORT_DIR, 'helper.sh');
export const MODELS_DIR = join(SUPPORT_DIR, 'models');
