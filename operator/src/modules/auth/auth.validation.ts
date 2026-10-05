import * as v from 'valibot';

const bearerAuthorizationSchema = v.pipe(
  v.string(),
  v.regex(/^Bearer ([A-Za-z0-9_-]{43})$/i),
  v.check((authorization) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
    if (!match) return false;
    const token = match[1]!;
    const bytes = Buffer.from(token, 'base64url');
    return bytes.length === 32 && bytes.toString('base64url') === token;
  }),
);

/** Reads the one canonical Bearer representation accepted by the auth API. */
export function readBearerToken(authorization: unknown): string | null {
  const parsed = v.safeParse(bearerAuthorizationSchema, authorization);
  return parsed.success ? parsed.output.slice(7) : null;
}
