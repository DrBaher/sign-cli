// Fire-and-forget JSON POST to SIGN_LOCAL_NOTIFY_URL when an allow-listed audit event is written.
// Errors are intentionally swallowed: notifications must never block or break the audit chain.

export const NOTIFY_EVENTS = new Set([
  "request.signed_by_signer",
  "request.signer_declined",
  "request.signer_token_reissued",
  "request.signer_policy_evaluated",
  "request.final_pdf_downloaded",
  "request.receipt_signed",
  "request.canceled",
]);

export type NotifyInput = {
  requestId: string;
  eventType: string;
  payload: unknown;
  hashSelf?: string | null;
  createdAt?: string;
};

export function maybeNotifySignerEvent(input: NotifyInput): Promise<void> | void {
  const url = process.env.SIGN_LOCAL_NOTIFY_URL;
  if (!url || !NOTIFY_EVENTS.has(input.eventType)) return;
  const body = JSON.stringify({
    requestId: input.requestId,
    eventType: input.eventType,
    payload: input.payload,
    hashSelf: input.hashSelf ?? null,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  // Fire-and-forget — never throw, never block.
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
    .then(() => undefined)
    .catch(() => undefined);
}
