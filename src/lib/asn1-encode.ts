function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

export function asn1(tag: number, contents: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(contents.length), contents]);
}

export function asn1Sequence(...children: Buffer[]): Buffer {
  return asn1(0x30, Buffer.concat(children));
}

export function asn1Set(...children: Buffer[]): Buffer {
  return asn1(0x31, Buffer.concat(children));
}

export function asn1ContextConstructed(tag: number, contents: Buffer): Buffer {
  return asn1(0xa0 | tag, contents);
}

export function asn1ContextImplicit(tag: number, contents: Buffer): Buffer {
  return asn1(0x80 | tag, contents);
}

export function asn1OctetString(buffer: Buffer): Buffer {
  return asn1(0x04, buffer);
}

export function asn1Integer(value: number | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    if (value.length === 0) return asn1(0x02, Buffer.from([0x00]));
    if ((value[0] & 0x80) !== 0) {
      return asn1(0x02, Buffer.concat([Buffer.from([0x00]), value]));
    }
    return asn1(0x02, value);
  }
  if (value === 0) return asn1(0x02, Buffer.from([0x00]));
  const bytes: number[] = [];
  let n = value;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0x00);
  return asn1(0x02, Buffer.from(bytes));
}

export function asn1Oid(oid: string): Buffer {
  const arcs = oid.split(".").map(Number);
  const bytes: number[] = [arcs[0] * 40 + arcs[1]];
  for (let i = 2; i < arcs.length; i += 1) {
    let arc = arcs[i];
    const stack: number[] = [arc & 0x7f];
    arc >>= 7;
    while (arc > 0) {
      stack.unshift((arc & 0x7f) | 0x80);
      arc >>= 7;
    }
    bytes.push(...stack);
  }
  return asn1(0x06, Buffer.from(bytes));
}

export const ASN1_NULL = Buffer.from([0x05, 0x00]);

export function asn1AlgorithmIdentifier(oid: string, withNull = true): Buffer {
  return asn1Sequence(asn1Oid(oid), withNull ? ASN1_NULL : Buffer.alloc(0));
}
