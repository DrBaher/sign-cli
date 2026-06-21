export type FieldType = "signature" | "initials" | "date" | "text" | "name" | "email";
export type AnchorUnits = "pixels" | "inches" | "mms" | "cms" | "points";

export type SignatureField = {
  signerOrder: number;
  documentIndex: number;
  type: FieldType;
  required: boolean;
  page?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  anchor?: string;
  anchorXOffset?: number;
  anchorYOffset?: number;
  anchorUnits?: AnchorUnits;
};

const FIELD_TYPES: ReadonlyArray<FieldType> = ["signature", "initials", "date", "text", "name", "email"];
const ANCHOR_UNITS: ReadonlyArray<AnchorUnits> = ["pixels", "inches", "mms", "cms", "points"];

function splitTopLevelCommas(raw: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function parseNumber(value: string, label: string, raw: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Field ${label} must be a number: "${raw}"`);
  }
  return parsed;
}

export function parseFieldSpec(raw: string): SignatureField {
  const pairs = splitTopLevelCommas(raw).map((segment) => segment.trim()).filter(Boolean);
  const record: Record<string, string> = {};
  for (const pair of pairs) {
    const colon = pair.indexOf(":");
    if (colon === -1) {
      throw new Error(`Invalid field segment: "${pair}"`);
    }
    const key = pair.slice(0, colon).trim();
    const value = pair.slice(colon + 1).trim();
    record[key] = value;
  }

  if (record.signer === undefined) {
    throw new Error(`Field must include signer:<order>: "${raw}"`);
  }
  const signerOrder = Number(record.signer);
  if (!Number.isInteger(signerOrder) || signerOrder < 1) {
    throw new Error(`Field signer must be a positive integer matching --signer order: "${raw}"`);
  }
  const documentIndex = record.doc !== undefined ? Number(record.doc) : 0;
  if (!Number.isInteger(documentIndex) || documentIndex < 0) {
    throw new Error(`Field doc must be a non-negative integer: "${raw}"`);
  }
  const type = (record.type ?? "signature").toLowerCase() as FieldType;
  if (!FIELD_TYPES.includes(type)) {
    throw new Error(`Field type must be one of ${FIELD_TYPES.join("|")}: "${raw}"`);
  }
  const required = record.required === undefined
    ? true
    : ["1", "true", "yes"].includes(record.required.toLowerCase());

  if (record.anchor !== undefined && record.anchor.length > 0) {
    const anchorUnits = (record["anchor-units"] ?? "pixels") as AnchorUnits;
    if (!ANCHOR_UNITS.includes(anchorUnits)) {
      throw new Error(`Field anchor-units must be one of ${ANCHOR_UNITS.join("|")}: "${raw}"`);
    }
    return {
      signerOrder,
      documentIndex,
      type,
      required,
      anchor: record.anchor.replace(/^"|"$/g, ""),
      anchorXOffset: record["x-offset"] !== undefined ? parseNumber(record["x-offset"], "x-offset", raw) : undefined,
      anchorYOffset: record["y-offset"] !== undefined ? parseNumber(record["y-offset"], "y-offset", raw) : undefined,
      anchorUnits,
    };
  }

  if (record.page === undefined || record.x === undefined || record.y === undefined) {
    throw new Error(`Field needs either anchor:"text" or page+x+y: "${raw}"`);
  }
  return {
    signerOrder,
    documentIndex,
    type,
    required,
    page: parseNumber(record.page, "page", raw),
    x: parseNumber(record.x, "x", raw),
    y: parseNumber(record.y, "y", raw),
    width: record.width !== undefined ? parseNumber(record.width, "width", raw) : undefined,
    height: record.height !== undefined ? parseNumber(record.height, "height", raw) : undefined,
  };
}

/**
 * Map a field position from a bottom-left origin (PDF user space, as emitted by
 * pdfjs-based detectors) to the top-left origin that every provider this CLI
 * targets — Dropbox Sign, SignWell, DocuSign — expects for `--field x/y`.
 *
 * `y` and `pageHeight` must be in the same units (points or pixels at the same
 * DPI). `height` is the field box height in those units; pass it so the box's
 * top edge lands where you expect (omit it and you get the baseline point, which
 * places the box's *top* at the detected line and pushes the field downward).
 *
 * See docs/field-coordinates.md for the full per-provider contract.
 */
export function bottomLeftToTopLeft(input: {
  x: number;
  y: number;
  pageHeight: number;
  height?: number;
}): { x: number; y: number } {
  const height = input.height ?? 0;
  return { x: input.x, y: input.pageHeight - input.y - height };
}

function dropboxFieldType(type: FieldType): string {
  switch (type) {
    case "signature": return "signature";
    case "initials": return "initials";
    case "date": return "date_signed";
    case "name": return "text";
    case "email": return "text";
    default: return "text";
  }
}

export function dropboxFormFieldsPerDocument(
  fields: SignatureField[],
  signerOrders: number[],
  documentCount: number,
): unknown[][] {
  const result: any[][] = [];
  for (let docIndex = 0; docIndex < documentCount; docIndex += 1) {
    const fieldsForDoc: any[] = [];
    fields.forEach((field, fieldIndex) => {
      if (field.documentIndex !== docIndex) return;
      if (field.anchor) {
        throw new Error(
          `Dropbox Sign API requires explicit page+x+y for fields. Anchor strings are not supported via this CLI: "${field.anchor}"`,
        );
      }
      const signerArrayIndex = signerOrders.indexOf(field.signerOrder);
      if (signerArrayIndex === -1) {
        throw new Error(`Field signer:${field.signerOrder} does not match any --signer order.`);
      }
      fieldsForDoc.push({
        api_id: `f_${docIndex}_${fieldIndex}`,
        name: field.type,
        type: dropboxFieldType(field.type),
        x: field.x,
        y: field.y,
        page: field.page,
        width: field.width ?? 200,
        height: field.height ?? 30,
        signer: signerArrayIndex,
        required: field.required,
      });
    });
    result.push(fieldsForDoc);
  }
  return result;
}

function docusignTabKey(type: FieldType): string {
  switch (type) {
    case "signature": return "signHereTabs";
    case "initials": return "initialHereTabs";
    case "date": return "dateSignedTabs";
    case "text": return "textTabs";
    case "name": return "fullNameTabs";
    case "email": return "emailAddressTabs";
    default: return "textTabs";
  }
}

export function docusignTabsForSigner(signerOrder: number, fields: SignatureField[]): Record<string, any[]> {
  const tabs: Record<string, any[]> = {};
  const matching = fields.filter((field) => field.signerOrder === signerOrder);
  for (const field of matching) {
    const key = docusignTabKey(field.type);
    if (!tabs[key]) tabs[key] = [];
    if (field.anchor) {
      tabs[key].push({
        anchorString: field.anchor,
        anchorXOffset: String(field.anchorXOffset ?? 0),
        anchorYOffset: String(field.anchorYOffset ?? 0),
        anchorUnits: field.anchorUnits ?? "pixels",
      });
    } else {
      tabs[key].push({
        documentId: String(field.documentIndex + 1),
        pageNumber: String(field.page),
        xPosition: String(field.x),
        yPosition: String(field.y),
      });
    }
  }
  return tabs;
}

function signwellFieldType(type: FieldType): string {
  switch (type) {
    case "signature": return "signature";
    case "initials": return "initials";
    case "date": return "date";
    case "text": return "text";
    case "name": return "text";
    case "email": return "text";
    default: return "text";
  }
}

export function signwellFieldsPerFile(
  fields: SignatureField[],
  signerOrderToRecipientId: Map<number, string>,
  documentCount: number,
): Array<Array<Record<string, unknown>>> {
  const result: Array<Array<Record<string, unknown>>> = [];
  for (let docIndex = 0; docIndex < documentCount; docIndex += 1) {
    const fieldsForFile: Array<Record<string, unknown>> = [];
    fields.forEach((field, fieldIndex) => {
      if (field.documentIndex !== docIndex) return;
      if (field.anchor) {
        throw new Error(
          `SignWell API requires explicit page+x+y for fields. Anchor strings are not supported via this CLI: "${field.anchor}"`,
        );
      }
      const recipientId = signerOrderToRecipientId.get(field.signerOrder);
      if (!recipientId) {
        throw new Error(`Field signer:${field.signerOrder} does not match any --signer order.`);
      }
      fieldsForFile.push({
        recipient_id: recipientId,
        type: signwellFieldType(field.type),
        page: field.page,
        x: field.x,
        y: field.y,
        required: field.required,
        api_id: `f_${docIndex}_${fieldIndex}`,
        ...(field.width !== undefined ? { width: field.width } : {}),
        ...(field.height !== undefined ? { height: field.height } : {}),
      });
    });
    result.push(fieldsForFile);
  }
  return result;
}
