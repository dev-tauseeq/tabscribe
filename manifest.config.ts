import { defineManifest } from '@crxjs/vite-plugin';
import pkg from './package.json' with { type: 'json' };

const icons = {
  16: 'src/icons/icon-16.png',
  32: 'src/icons/icon-32.png',
  48: 'src/icons/icon-48.png',
  128: 'src/icons/icon-128.png',
};

export default defineManifest(({ command }) => ({
  manifest_version: 3,
  name: 'Meeting Recorder',
  version: pkg.version,
  description: 'Records a meeting tab and your microphone to MP3, then saves a transcript, a summary and action items next to it.',
  minimum_chrome_version: '116',
  permissions: ['tabCapture', 'offscreen', 'storage', 'activeTab', 'downloads', 'nativeMessaging'],
  icons,
  action: {
    default_title: 'Meeting Recorder',
    default_popup: 'src/popup/popup.html',
    default_icon: icons,
  },
  options_page: 'src/options/options.html',
  background: {
    service_worker: 'src/background/service-worker.ts',
    type: 'module',
  },
  ...(command === 'build'
    ? {
        content_security_policy: {
          extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self'",
        },
      }
    : {}),
}));
