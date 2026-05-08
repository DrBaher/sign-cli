// Tiny fixed-column renderer for `sign request list --format table`. No
// dependencies, ASCII only, deterministic widths so the output is grep-able
// and pipe-able. Truncates with an ellipsis when a column overflows.

export type RequestTableRow = {
  id: string;
  title: string;
  status: string;
  provider: string | null;
  signers: number;
  createdAt: string;
};

const COLUMNS: Array<{ key: keyof RequestTableRow; label: string; width: number; align?: "left" | "right" }> = [
  { key: "id", label: "ID", width: 36 },
  { key: "title", label: "TITLE", width: 28 },
  { key: "status", label: "STATUS", width: 12 },
  { key: "provider", label: "PROVIDER", width: 10 },
  { key: "signers", label: "SIGNERS", width: 7, align: "right" },
  { key: "createdAt", label: "CREATED", width: 24 },
];

function fit(value: string, width: number, align: "left" | "right" = "left"): string {
  let str = value;
  if (str.length > width) str = str.slice(0, Math.max(0, width - 1)) + "…";
  return align === "right" ? str.padStart(width, " ") : str.padEnd(width, " ");
}

export function renderRequestsTable(rows: ReadonlyArray<RequestTableRow & Record<string, unknown>>): string {
  const header = COLUMNS.map((c) => fit(c.label, c.width, c.align)).join("  ");
  if (rows.length === 0) {
    return `${header}\n(no rows)`;
  }
  const lines = rows.map((row) =>
    COLUMNS
      .map((c) => {
        const raw = row[c.key];
        const text = raw === null || raw === undefined ? "—" : String(raw);
        return fit(text, c.width, c.align);
      })
      .join("  "),
  );
  return [header, ...lines].join("\n");
}
