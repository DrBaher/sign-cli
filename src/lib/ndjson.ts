// Tiny helper for the bulk commands' --ndjson output mode.
//
// Bulk commands return { total, succeeded, failed, results[] } as a single JSON
// object. Downstream consumers piping through jq, grep, or a streaming
// processor want one JSON object per line — easier to filter, easier to
// resume from, easier to spot-check mid-stream.
//
// renderBulkResultAsNdjson emits one line per result row plus a final
// {"summary": true, ...} line, written to stdout in order. Each line is a
// complete, parseable JSON object.

export type BulkLikeResult = {
  total: number;
  succeeded: number;
  failed: number;
  results: ReadonlyArray<unknown>;
};

export function renderBulkResultAsNdjson(result: BulkLikeResult): string {
  const lines = result.results.map((row) => JSON.stringify(row));
  lines.push(JSON.stringify({
    summary: true,
    total: result.total,
    succeeded: result.succeeded,
    failed: result.failed,
  }));
  return lines.join("\n") + "\n";
}
