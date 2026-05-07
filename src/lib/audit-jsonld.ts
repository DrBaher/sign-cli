// JSON-LD shaped audit-chain export. The schema is intentionally simple: a single
// document representing the request, with a nested events[] array typed against
// a stable @context. External auditors / SBOM-style tooling can ingest these
// without round-tripping through our binary.

const CONTEXT = {
  "@vocab": "https://sign-cli.example/audit/v1#",
  prov: "http://www.w3.org/ns/prov#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  Request: "https://sign-cli.example/audit/v1#Request",
  ProvChainEvent: "https://sign-cli.example/audit/v1#ProvChainEvent",
  Signer: "https://sign-cli.example/audit/v1#Signer",
  createdAt: { "@type": "xsd:dateTime" },
  signedAt: { "@type": "xsd:dateTime" },
  expiresAt: { "@type": "xsd:dateTime" },
  hashSelf: "https://sign-cli.example/audit/v1#hashSelf",
  hashPrev: "https://sign-cli.example/audit/v1#hashPrev",
  eventType: "https://sign-cli.example/audit/v1#eventType",
} as const;

export type JsonLdAuditEvent = {
  "@type": "ProvChainEvent";
  "@id": string;
  eventType: string;
  createdAt: string;
  hashSelf: string;
  hashPrev: string | null;
  payload: unknown;
};

export type JsonLdAuditExport = {
  "@context": typeof CONTEXT;
  "@type": "Request";
  "@id": string;
  requestId: string;
  title: string;
  status: string;
  provider: string | null;
  documentSha256: string | null;
  signers: Array<{ "@type": "Signer"; email: string; name: string; order: number }>;
  signedBy?: Array<{ "@type": "Signer"; email: string; name: string; signedAt: string }>;
  events: JsonLdAuditEvent[];
  generatedAt: string;
};

export function renderAuditChainAsJsonLd(input: {
  request: {
    id: string;
    title: string;
    status: string;
    provider: string | null;
    documentSha256: string | null;
  };
  signers: Array<{ email: string; name: string; order: number }>;
  signedBy?: Array<{ email: string; name: string; signedAt: string }> | null;
  events: Array<{
    id: number;
    event_type: string;
    payload_json: string;
    hash_prev: string | null;
    hash_self: string;
    created_at: string;
  }>;
  now?: Date;
}): JsonLdAuditExport {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const events: JsonLdAuditEvent[] = input.events.map((row) => {
    let payload: unknown = null;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      payload = row.payload_json;
    }
    return {
      "@type": "ProvChainEvent",
      "@id": `urn:sign-cli:event:${input.request.id}:${row.id}`,
      eventType: row.event_type,
      createdAt: row.created_at,
      hashSelf: row.hash_self,
      hashPrev: row.hash_prev,
      payload,
    };
  });
  const out: JsonLdAuditExport = {
    "@context": CONTEXT,
    "@type": "Request",
    "@id": `urn:sign-cli:request:${input.request.id}`,
    requestId: input.request.id,
    title: input.request.title,
    status: input.request.status,
    provider: input.request.provider,
    documentSha256: input.request.documentSha256,
    signers: input.signers.map((s) => ({ "@type": "Signer", ...s })),
    events,
    generatedAt,
  };
  if (input.signedBy && input.signedBy.length > 0) {
    out.signedBy = input.signedBy.map((s) => ({ "@type": "Signer", email: s.email, name: s.name, signedAt: s.signedAt }));
  }
  return out;
}
