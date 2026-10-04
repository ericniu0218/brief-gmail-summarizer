import { HttpError } from '../runtime';

/**
 * Group join codes: short enough to read down a phone, long enough not to be guessed.
 *
 * The alphabet leaves out `0 O 1 I L U`, the characters people mistype when a code is
 * read aloud or copied off a whiteboard. Thirty symbols over eight places is about 6.5e11
 * codes, and `WorkspaceStore` additionally stops a user after a few wrong tries, so the
 * space cannot be searched even though a code is short.
 */

const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const JOIN_CODE_LENGTH = 8;
/** Separators and case are cosmetic, so the typed form is forgiving. */
const SEPARATORS = /[\s\-_.]+/g;
const WELL_FORMED = new RegExp(`^[${ALPHABET}]{${JOIN_CODE_LENGTH}}$`);

export function newJoinCode(): string {
  let code = '';
  // Rejection sampling: 256 is not a multiple of 30, so taking every byte modulo 30 would
  // make the first six letters of the alphabet measurably more likely than the rest.
  const ceiling = 256 - (256 % ALPHABET.length);
  while (code.length < JOIN_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(
      new Uint8Array(JOIN_CODE_LENGTH),
    )) {
      if (byte >= ceiling) continue;
      code += ALPHABET[byte % ALPHABET.length];
      if (code.length === JOIN_CODE_LENGTH) break;
    }
  }
  return code;
}

/** The stored form of whatever the user typed, or a 400 explaining the shape. */
export function normalizeJoinCode(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value.replace(SEPARATORS, '').toUpperCase()
      : '';
  if (!WELL_FORMED.test(text))
    throw new HttpError(
      400,
      `A group code is ${JOIN_CODE_LENGTH} letters and numbers, like ${formatJoinCode('ABCD2345')}.`,
    );
  return text;
}

/** Grouped for reading; `normalizeJoinCode` accepts this form back. */
export function formatJoinCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** A single-use invitation token, as distinct from a reusable group code. */
export function isInviteToken(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('bwi_');
}
