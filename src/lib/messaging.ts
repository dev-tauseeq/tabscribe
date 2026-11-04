import type { BackgroundMessage } from '../types';

export async function sendToBackground<T>(message: BackgroundMessage): Promise<T | undefined> {
  return (await chrome.runtime.sendMessage(message)) as T | undefined;
}
