/**
 * Tiny shared helper for building a plain-text RFC822 message — used by
 * both google.ts (base64url-encoded for the Gmail drafts API) and
 * privatemail.ts (appended raw over IMAP). Not shared with hotmail.ts,
 * which never needs a raw RFC822 string — Graph's drafts API takes
 * structured JSON instead.
 */
export function buildRfc822Message(to: string, subject: string, body: string): string {
  return [`To: ${to}`, `Subject: ${subject}`, `Content-Type: text/plain; charset="UTF-8"`, ``, body].join("\r\n");
}
