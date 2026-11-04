export type MicAccess = PermissionState | 'unknown';

export async function readMicAccess(): Promise<MicAccess> {
  try {
    return (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state;
  } catch {
    return 'unknown';
  }
}
