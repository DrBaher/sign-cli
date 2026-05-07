// Process-global pub/sub for MCP resource subscriptions. Audit-event writes
// fan out to subscribers via notifyResourceChanged(); the MCP server
// translates each fanout into a notifications/resources/updated message.

type Listener = (uri: string) => void;

const listenersByUri = new Map<string, Set<Listener>>();
const everyListener = new Set<Listener>();

export function subscribeResource(uri: string, listener: Listener): () => void {
  if (uri === "*") {
    everyListener.add(listener);
    return () => everyListener.delete(listener);
  }
  let bucket = listenersByUri.get(uri);
  if (!bucket) {
    bucket = new Set();
    listenersByUri.set(uri, bucket);
  }
  bucket.add(listener);
  return () => {
    const current = listenersByUri.get(uri);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByUri.delete(uri);
  };
}

export function notifyResourceChanged(uri: string): void {
  const bucket = listenersByUri.get(uri);
  if (bucket) {
    for (const listener of bucket) {
      try {
        listener(uri);
      } catch {
        // listeners must not throw into the audit hot path
      }
    }
  }
  for (const listener of everyListener) {
    try {
      listener(uri);
    } catch { /* swallow */ }
  }
}

export function _resetResourceWatchersForTests(): void {
  listenersByUri.clear();
  everyListener.clear();
}

export function _listenerCount(uri: string): number {
  return (listenersByUri.get(uri)?.size ?? 0) + everyListener.size;
}
