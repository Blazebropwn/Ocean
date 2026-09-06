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

function botStatus(instance) {
  if (!instance) return { label: "Bez profilu", className: "idle" };
  return {
    unconfigured: { label: "Nepřipojeno", className: "idle" },
    provisioning: { label: "Připravuje se", className: "pending" },
    connected: { label: "Běží", className: "running" },
    suspended: { label: "Pozastaveno", className: "pending" },
    error: { label: "Chyba", className: "error" },
  }[instance.status] || { label: instance.status, className: "idle" };
}

function setInviteMessage(text, success = false) {
  const message = document.querySelector("#invite-message");
  message.textContent = text;
  message.classList.toggle("success", Boolean(text) && success);
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
      revoke.className = "revoke-invitation";
      revoke.textContent = "Zrušit";
      revoke.addEventListener("click", async () => {
        if (!window.confirm("Opravdu zrušit tuto pozvánku?")) return;
        revoke.disabled = true;
        setInviteMessage("");
        try {
          await inviteRequest(`/api/invitations/${invitation.id}`, { method: "DELETE" });
          await loadInvitations();
          setInviteMessage("Pozvánka byla zrušena.", true);
        } catch (error) {
          setInviteMessage(error instanceof Error ? error.message : "Pozvánku se nepodařilo zrušit.");
          revoke.disabled = false;
        }
      });
      row.append(revoke);
    }
    list.append(row);
  }
}

async function loadMembers() {
  const { members } = await inviteRequest("/api/members");
  const list = $("#member-list");
  list.replaceChildren();
  if (!members.length) {
    const empty = document.createElement("p");
    empty.textContent = "Zatím žádní členové.";
    list.append(empty);
    return;
  }
  for (const member of members) {
    const row = document.createElement("article");
    const info = document.createElement("div");
    const name = document.createElement("strong");
    const detail = document.createElement("small");
    const state = document.createElement("span");
    name.textContent = `@${member.username}`;
    detail.textContent = member.email || member.displayId;
    state.textContent = member.approved ? "Schválen" : "Čeká";
    state.className = `invite-status ${member.approved ? "active" : "pending"}`;
    const bot = document.createElement("div");
    bot.className = "member-bot";
    const botChip = document.createElement("span");
    const status = botStatus(member.instance);
    botChip.className = `bot-status ${status.className}`;
    botChip.textContent = status.label;
    bot.append(botChip);
    if (member.instance) {
      const environment = document.createElement("small");
      environment.textContent = member.instance.environment === "mainnet" ? "Mainnet" : "Testnet";
      bot.append(environment);
    }
    info.append(name, detail, bot);
    row.append(info, state);
    if (!member.approved) {
      const approve = document.createElement("button");
      approve.type = "button";
      approve.className = "approve-member";
      approve.textContent = "Schválit";
      approve.addEventListener("click", async () => {
        approve.disabled = true;
        try {
          await inviteRequest(`/api/members/${member.id}/approval`, { method: "POST", body: "{}" });
          await loadMembers();
        } catch (error) {
          setInviteMessage(error instanceof Error ? error.message : "Něco se nepovedlo.");
          approve.disabled = false;
        }
      });
      row.append(approve);
    }
    const resetPassword = document.createElement("button");
    resetPassword.type = "button";
    resetPassword.className = "reset-member-password";
    resetPassword.textContent = "Obnovit heslo";
    resetPassword.addEventListener("click", async () => {
      if (!window.confirm(`Vytvořit nový odkaz pro @${member.username}? Předchozí odkaz přestane platit.`)) return;
      resetPassword.disabled = true;
      try {
        const { reset } = await inviteRequest(`/api/members/${member.id}/password-reset`, { method: "POST", body: "{}" });
        $("#member-reset-url").value = reset.resetUrl;
        $("#member-reset-result").classList.remove("hidden");
        setInviteMessage(`Odkaz pro @${member.username} platí 30 minut.`, true);
      } catch (error) {
        setInviteMessage(error instanceof Error ? error.message : "Něco se nepovedlo.");
      } finally {
        resetPassword.disabled = false;
      }
    });
    row.append(resetPassword);
    list.append(row);
  }
}

$("#invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  setInviteMessage("");
  try {
    const { invitation } = await inviteRequest("/api/invitations", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    $("#invite-url").value = invitation.inviteUrl;
    $("#invite-result").classList.remove("hidden");
    form.reset();
    await Promise.all([loadInvitations(), loadMembers()]);
  } catch (error) {
    setInviteMessage(error instanceof Error ? error.message : "Něco se nepovedlo.");
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
  setInviteMessage("");
});

$("#copy-member-reset").addEventListener("click", async () => {
  const input = $("#member-reset-url");
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand("copy");
    input.setSelectionRange(0, 0);
  }
  $("#copy-member-reset").textContent = "Zkopírováno";
});

inviteRequest("/api/me").then(({ user }) => {
  if (user.role !== "owner") throw new Error("Tuto sekci může otevřít pouze vlastník.");
  return Promise.all([loadInvitations(), loadMembers()]);
}).catch((error) => { setInviteMessage(error instanceof Error ? error.message : "Něco se nepovedlo."); });
