// Alpine.js component for the sign-cli demo. Talks to the same origin's /v1/* JSON
// API. Read-only by design — the four mutating routes are gated by the server's
// --read-only flag, so this UI doesn't even surface them.
//
// Auth: if `sign serve` was started with --auth-token, paste the token into the
// localStorage key `sign_auth_token` and reload. Every fetch picks it up.

const API_BASE = "";

function authHeader() {
  const token = (typeof localStorage !== "undefined" && localStorage.getItem("sign_auth_token")) || "";
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function apiPost(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeader() },
    body: JSON.stringify(body || {}),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`HTTP ${res.status}: response was not JSON`);
  }
  if (!res.ok || json?.ok === false) {
    const code = json?.error?.code || res.status;
    const message = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`${code}: ${message}`);
  }
  return json.result;
}

function signDemo() {
  return {
    inbox: [],
    inboxLoading: false,
    inboxError: "",

    selectedId: null,
    inboxEntry: null,    // The flat row from /v1/signer/list (has title/status/signers).
    snapshot: null,      // The full nested response from /v1/request/show.
    snapshotError: "",
    showRaw: false,

    audit: null,
    auditRunning: false,
    auditError: "",

    cold: false,

    async init() {
      // Show "waking up" hint if the first call takes more than ~1.5s — useful on
      // platforms that auto-stop idle containers.
      const coldTimer = setTimeout(() => { this.cold = true; }, 1500);
      try {
        await this.loadInbox();
        if (this.inbox.length > 0) {
          await this.select(this.inbox[0].requestId, { scroll: false });
        }
      } finally {
        clearTimeout(coldTimer);
        this.cold = false;
      }
    },

    async loadInbox() {
      this.inboxLoading = true;
      this.inboxError = "";
      try {
        const result = await apiPost("/v1/signer/list", {});
        this.inbox = Array.isArray(result) ? result : [];
      } catch (err) {
        this.inboxError = err.message;
      } finally {
        this.inboxLoading = false;
      }
    },

    async select(requestId, opts = {}) {
      if (!requestId) return;
      const { scroll = true } = opts;
      this.selectedId = requestId;
      this.inboxEntry = this.inbox.find((e) => e.requestId === requestId) || null;
      this.snapshot = null;
      this.snapshotError = "";
      this.showRaw = false;
      try {
        this.snapshot = await apiPost("/v1/request/show", { request_id: requestId });
        if (scroll) {
          document.getElementById("anatomy")?.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      } catch (err) {
        this.snapshotError = err.message;
      }
    },

    async runAudit() {
      this.auditRunning = true;
      this.auditError = "";
      this.audit = null;
      try {
        const result = await apiPost("/v1/audit/scan", {});
        // The scan result shape varies a bit by sign-cli version. Normalize the
        // fields we surface.
        const results = Array.isArray(result?.results) ? result.results : [];
        this.audit = {
          scanned: result?.scanned ?? results.length,
          totalEntries: result?.totalEntries
            ?? results.reduce((acc, r) => acc + (r.entries || 0), 0),
          brokenChains: result?.brokenChains
            ?? results.filter((r) => !r.ok).length,
          results,
        };
      } catch (err) {
        this.auditError = err.message;
      } finally {
        this.auditRunning = false;
      }
    },

    /* ── Computed-style helpers (called from the template). ───── */

    title() {
      return this.snapshot?.request?.title
        ?? this.inboxEntry?.title
        ?? "Untitled request";
    },

    status() {
      return this.snapshot?.request?.status
        ?? this.inboxEntry?.status
        ?? "unknown";
    },

    createdAt() {
      return this.snapshot?.request?.created_at
        ?? this.inboxEntry?.createdAt
        ?? null;
    },

    auditHead() {
      return this.snapshot?.request?.audit_head ?? null;
    },

    /**
     * Build a per-signer view by merging the inbox row's signers list (which
     * has email/name) with the snapshot's signedBy[] and declinedBy fields.
     */
    signerRows() {
      const signers = this.inboxEntry?.signers ?? [];
      const signedBy = this.snapshot?.signedBy ?? [];
      const declinedBy = this.snapshot?.declinedBy ?? null;
      const signedMap = new Map(
        signedBy.map((s) => [String(s.email || "").trim().toLowerCase(), s]),
      );
      return signers.map((s) => {
        const key = String(s.email || "").trim().toLowerCase();
        const isDeclined = declinedBy && key === String(declinedBy).trim().toLowerCase();
        const signedEntry = signedMap.get(key);
        let status = "pending";
        if (signedEntry) status = "signed";
        if (isDeclined) status = "declined";
        return {
          email: s.email,
          name: s.name || "",
          status,
          signedAt: signedEntry?.signedAt ?? null,
        };
      });
    },

    rawJson(obj) {
      try {
        return JSON.stringify(obj, null, 2);
      } catch {
        return String(obj);
      }
    },

    formatTimestamp(ts) {
      if (!ts) return "—";
      const d = typeof ts === "number" ? new Date(ts) : new Date(String(ts));
      if (Number.isNaN(d.getTime())) return String(ts);
      return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    },
  };
}

window.signDemo = signDemo;
