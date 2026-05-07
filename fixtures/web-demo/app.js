// Static dashboard for `sign serve`. Talks to the same origin's /v1/* JSON API.
// Read-only by design: list inbox, show snapshot, scan audit chains.
//
// Auth: if you started `sign serve` with --auth-token, paste it into the
// localStorage key `sign_auth_token` (DevTools → Application → Local Storage)
// and refresh — every fetch picks it up automatically.

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
  const json = await res.json();
  if (!res.ok || json?.ok === false) {
    const code = json?.error?.code || res.status;
    const message = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`${code}: ${message}`);
  }
  return json.result;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

async function refreshInbox() {
  const errEl = document.getElementById("inbox-error");
  errEl.textContent = "";
  const tbody = document.querySelector("#inbox-table tbody");
  clearChildren(tbody);
  try {
    const email = document.getElementById("inbox-email").value.trim();
    const result = await apiPost("/v1/signer/list", email ? { signer_email: email } : {});
    if (!Array.isArray(result) || result.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.textContent = "No pending requests.";
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    for (const entry of result) {
      const tr = document.createElement("tr");
      tr.appendChild(cell(entry.requestId || "—"));
      tr.appendChild(cell(entry.title || ""));
      tr.appendChild(cell(entry.status || ""));
      tr.appendChild(cell(String((entry.signers || []).length)));
      const actionTd = document.createElement("td");
      const btn = document.createElement("button");
      btn.textContent = "Load snapshot";
      btn.className = "copy-btn";
      btn.addEventListener("click", () => {
        document.getElementById("snap-id").value = entry.requestId || "";
        loadSnapshot();
      });
      actionTd.appendChild(btn);
      tr.appendChild(actionTd);
      tbody.appendChild(tr);
    }
  } catch (error) {
    errEl.textContent = error.message;
  }
}

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

async function loadSnapshot() {
  const id = document.getElementById("snap-id").value.trim();
  if (!id) {
    setText("snap-output", "Enter a request ID first.");
    return;
  }
  setText("snap-output", "Loading…");
  try {
    const result = await apiPost("/v1/request/show", { request_id: id });
    setText("snap-output", JSON.stringify(result, null, 2));
  } catch (error) {
    setText("snap-output", `Error: ${error.message}`);
  }
}

async function runScan() {
  setText("scan-output", "Scanning…");
  try {
    const result = await apiPost("/v1/audit/scan", {});
    setText("scan-output", JSON.stringify(result, null, 2));
  } catch (error) {
    setText("scan-output", `Error: ${error.message}`);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("inbox-refresh").addEventListener("click", refreshInbox);
  document.getElementById("snap-load").addEventListener("click", loadSnapshot);
  document.getElementById("scan-run").addEventListener("click", runScan);
  refreshInbox();
});
