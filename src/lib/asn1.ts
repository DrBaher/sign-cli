export type Asn1Node = {
  tagClass: number;
  constructed: boolean;
  tagNumber: number;
  headerLength: number;
  contentLength: number;
  totalLength: number;
  contents: Buffer;
  raw: Buffer;
  children?: Asn1Node[];
};

export function parseAsn1(buffer: Buffer, offset = 0): Asn1Node {
  const start = offset;
  const first = buffer[offset];
  const tagClass = (first & 0xc0) >> 6;
  const constructed = (first & 0x20) !== 0;
  let tagNumber = first & 0x1f;
  let cursor = offset + 1;

  if (tagNumber === 0x1f) {
    tagNumber = 0;
    while (true) {
      const byte = buffer[cursor];
      cursor += 1;
      tagNumber = (tagNumber << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
  }

  const lengthByte = buffer[cursor];
  cursor += 1;
  let contentLength: number;
  if ((lengthByte & 0x80) === 0) {
    contentLength = lengthByte;
  } else {
    const numBytes = lengthByte & 0x7f;
    if (numBytes === 0) {
      throw new Error("Indefinite-length ASN.1 not supported.");
    }
    contentLength = 0;
    for (let i = 0; i < numBytes; i += 1) {
      contentLength = (contentLength << 8) | buffer[cursor + i];
    }
    cursor += numBytes;
  }

  const headerLength = cursor - start;
  const contents = buffer.subarray(cursor, cursor + contentLength);
  const totalLength = headerLength + contentLength;
  const raw = buffer.subarray(start, start + totalLength);

  let children: Asn1Node[] | undefined;
  if (constructed) {
    children = [];
    let inner = 0;
    while (inner < contents.length) {
      const child = parseAsn1(contents, inner);
      children.push(child);
      inner += child.totalLength;
    }
  }

  return {
    tagClass,
    constructed,
    tagNumber,
    headerLength,
    contentLength,
    totalLength,
    contents,
    raw,
    children,
  };
}

export function decodeOid(contents: Buffer): string {
  if (contents.length === 0) return "";
  const first = contents[0];
  const arcs: number[] = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = 1; i < contents.length; i += 1) {
    const byte = contents[i];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join(".");
}

export function findChildrenByOid(node: Asn1Node, oid: string): Asn1Node[] {
  const matches: Asn1Node[] = [];
  function walk(current: Asn1Node): void {
    if (current.children) {
      for (const child of current.children) {
        if (child.tagClass === 0 && child.tagNumber === 6 && decodeOid(child.contents) === oid) {
          matches.push(current);
        }
        walk(child);
      }
    }
  }
  walk(node);
  return matches;
}
