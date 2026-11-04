import { folderStamp } from './stamp';

const MAX_LENGTH = 80;
const TITLE_LENGTH = 60;
const MAX_COPIES = 99;
// The same rules Chrome applies before it saves a download (IsSafePortablePathComponent):
// no control, format or non-characters and none of "*/:<>?\| anywhere, no white space, dot or
// tilde at either end, no Windows device names even with an extension, and no shell link
// extensions.
const INVALID_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}<>:"/\\|?*]/gu;
const INVALID_ENDS = /^[\s.~]+|[\s.~]+$/gu;
const RESERVED_NAMES = /^(con|prn|aux|nul|clock\$|com\d|lpt\d|com[¹²³]|lpt[¹²³])(\..*)?$|^(desktop\.ini|thumbs\.db)$/i;
const SHELL_EXTENSION = /\.(local|lnk|\{.*\})$/i;
const PATH_SEPARATOR = '[\\\\/]';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cuts by characters, not UTF-16 units, so an emoji is never split in half.
const firstCharacters = (text: string, count: number): string => Array.from(text).slice(0, count).join('');

export function sanitizeFolderName(input: string): string {
  let cleaned = firstCharacters(input.replace(INVALID_CHARACTERS, ' ').replace(/\s+/g, ' ').trim(), MAX_LENGTH);
  cleaned = cleaned.replace(INVALID_ENDS, '');
  if (SHELL_EXTENSION.test(cleaned)) cleaned = cleaned.replace(/\.(?=[^.]*$)/, '_');
  // Chrome rejects "aux.notes" as well as "aux", so the mark goes in front.
  return RESERVED_NAMES.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function defaultRecordingName(title: string, date: Date): string {
  const shortTitle = firstCharacters(sanitizeFolderName(title), TITLE_LENGTH).trim();
  return sanitizeFolderName(`${shortTitle} ${folderStamp(date)}`);
}

export function downloadFolderPattern(base: string, folder: string): string {
  return `${PATH_SEPARATOR}${escapeRegExp(base)}${PATH_SEPARATOR}${escapeRegExp(folder)}${PATH_SEPARATOR}[^\\\\/]+$`;
}

export function copyName(base: string, copy: number): string {
  return copy === 1 ? base : `${base} (${copy})`;
}

export { MAX_COPIES };
