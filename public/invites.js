const $ = (selector) => document.querySelector(selector);

async function inviteRequest(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Něco se nepovedlo.");
  return body;
}

function inviteStatus(status) {
  return { active: "Aktivní", used: "Použitá", expired: "Vypršela", revoked: "Zrušená" }[status] || status;
}

async function loadInvitations() {
  const { invitations } = await inviteRequest("/api/invitations");
  const list = $("#invite-list");
  list.replaceChildren();
  if (!invitations.length) {
    const empty = document.createElement("p");
    empty.textContent = "Zatím žádné pozvánky.";
    list.append(empty);
    return;
  }
  for (const invitation of invitations) {
    const row = document.createElement("article");
    const info = document.createElement("div");
    const email = document.createElement("strong");
    const detail = document.createElement("small");
    const state = document.createElement("span");
    email.textContent = invitation.email || "Pozvánka bez omezení e-mailu";
    detail.textContent = `Platí do ${new Intl.DateTimeFormat("cs-CZ", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Prague" }).format(new Date(invitation.expiresAt))}`;
    state.textContent = inviteStatus(invitation.status);
    state.className = `invite-status ${invitation.status}`;
    info.append(email, detail);
    row.append(info, state);
    if (invitation.status === "active") {
      const revoke = document.createElement("button");
      revoke.type = "button";
      revoke.textContent = "Zrušit";
      revoke.addEventListener("click", async () => { await inviteRequest(`/api/invitations/${invitation.id}`, { method: "DELETE" }); await loadInvitations(); });
      row.append(revoke);
    }
    list.append(row);
  }
}

$("#invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  $("#invite-message").textContent = "";
  try {
    const { invitation } = await inviteRequest("/api/invitations", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    $("#invite-url").value = invitation.inviteUrl;
    $("#invite-result").classList.remove("hidden");
    form.reset();
    await loadInvitations();
  } catch (error) {
    $("#invite-message").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$("#copy-invite").addEventListener("click", async () => {
  const input = $("#invite-url");
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand("copy");
    input.setSelectionRange(0, 0);
  }
  $("#copy-invite").textContent = "Zkopírováno";
  $("#invite-message").textContent = "";
});

inviteRequest("/api/me").then(({ user }) => {
  if (user.role !== "owner") throw new Error("Tuto sekci může otevřít pouze vlastník.");
  return loadInvitations();
}).catch((error) => { $("#invite-message").textContent = error.message; });
