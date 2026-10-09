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

function renderMemberDetail(panel, kryptotron) {
  const balance = kryptotron.balance && kryptotron.balance.amount != null
    ? `${Number(kryptotron.balance.amount).toLocaleString("cs-CZ", { maximumFractionDigits: 2 })} ${kryptotron.balance.asset}`
    : "—";
  const rows = [
    ["Automatizace", kryptotron.entriesPaused ? "Pozastavená" : "Běží"],
    ["Pozice", kryptotron.position ? `${kryptotron.position.symbol} · ${kryptotron.position.protectionActive ? "chráněná" : "bez ochrany"}` : "Žádná otevřená pozice"],
    ["Balance", balance],
    ["Kryptotron", kryptotron.octo?.message || "—"],
  ];
  if (kryptotron.lastError) rows.push(["Poslední chyba", kryptotron.lastError]);
  panel.replaceChildren();
  for (const [label, value] of rows) {
    const line = document.createElement("div");
    line.className = "member-detail-row";
    const term = document.createElement("small");
    const description = document.createElement("span");
    term.textContent = label;
    description.textContent = value;
    line.append(term, description);
    panel.append(line);
  }
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
    email.textContent = invitation.email || "Jednorázová pozvánka";
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
    state.textContent = member.suspended ? "🔒 Pozastaven" : member.approved ? "Schválen" : "Čeká";
    state.className = `invite-status ${member.suspended ? "pending" : member.approved ? "active" : "pending"}`;
    const bot = document.createElement("div");
    bot.className = "member-bot";
    const botChip = document.createElement("span");
    const status = botStatus(member.instance);
    botChip.className = `bot-status ${member.suspended ? "pending" : status.className}`;
    botChip.textContent = member.suspended ? "Nákupy pozastaveny" : status.label;
    bot.append(botChip);
    if (member.instance) {
      const environment = document.createElement("small");
      environment.textContent = member.instance.environment === "mainnet" ? "Mainnet" : "Testnet";
      bot.append(environment);
    }
    info.append(name, detail, bot);
    row.append(info, state);
    const suspension = document.createElement("button");
    suspension.type = "button";
    suspension.className = `suspend-member${member.suspended ? " unblock-member" : ""}`;
    suspension.textContent = member.suspended ? "Odblokovat účet" : "Pozastavit účet";
    suspension.addEventListener("click", async () => {
      const action = member.suspended ? `Odblokovat @${member.username}? Nové nákupy zůstanou pozastavené, dokud si je uživatel sám nezapne.` : `Pozastavit @${member.username}? Funkce účtu se zamknou a nové nákupy se pozastaví. Ochranné objednávky na Binance zůstanou zachované.`;
      if (!window.confirm(action)) return;
      suspension.disabled = true;
      try {
        const result = await inviteRequest(`/api/members/${member.id}/suspension`, { method: "POST", body: JSON.stringify({ suspended: !member.suspended }) });
        await loadMembers();
        setInviteMessage(result.automationPausePending ? "Účet je zablokovaný. Uložení pauzy automatizace čeká na dostupnost úložiště; ověř stav v detailu." : member.suspended ? "Účet je odblokovaný. Nové nákupy zůstávají pozastavené." : "Účet je pozastavený.", !result.automationPausePending);
      } catch (error) { setInviteMessage(error.message); suspension.disabled = false; }
    });
    row.append(suspension);
    if (member.instance?.configured) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.textContent = "Znovu nastavit účet";
      reset.addEventListener("click", () => openAccountReset(member));
      row.append(reset);
    }
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

    const deleteMember = document.createElement("button");
    deleteMember.type = "button";
    deleteMember.className = "delete-member";
    deleteMember.textContent = "Smazat účet";
    deleteMember.addEventListener("click", async () => {
      const confirmation = window.prompt(`Trvalé smazání @${member.username}\n\nZanikne přihlášení, Binance klíče, Telegram, Kryptotron i historie agenta. Pro potvrzení napište přesně uživatelské jméno:`, "");
      if (confirmation === null) return;
      deleteMember.disabled = true;
      setInviteMessage("");
      try {
        await inviteRequest(`/api/members/${member.id}`, {
          method: "DELETE",
          body: JSON.stringify({ confirmation }),
        });
        await loadMembers();
        setInviteMessage(`Účet @${member.username} byl trvale smazán.`, true);
      } catch (error) {
        setInviteMessage(error instanceof Error ? error.message : "Účet se nepodařilo smazat.");
        deleteMember.disabled = false;
      }
    });
    row.append(deleteMember);

    const entry = document.createElement("div");
    entry.className = "member-entry";
    entry.append(row);
    if (member.instance && member.instance.status === "connected") {
      const detailPanel = document.createElement("div");
      detailPanel.className = "member-detail hidden";
      let loaded = false;
      const detailToggle = document.createElement("button");
      detailToggle.type = "button";
      detailToggle.className = "member-detail-toggle";
      detailToggle.textContent = "Detail";
      detailToggle.addEventListener("click", async () => {
        const willShow = detailPanel.classList.contains("hidden");
        detailPanel.classList.toggle("hidden", !willShow);
        detailToggle.textContent = willShow ? "Skrýt" : "Detail";
        if (!willShow || loaded) return;
        detailPanel.textContent = "Načítám…";
        try {
          const { kryptotron } = await inviteRequest(`/api/members/${member.id}/kryptotron`);
          renderMemberDetail(detailPanel, kryptotron);
          loaded = true;
        } catch (error) {
          detailPanel.textContent = error instanceof Error ? error.message : "Detail se nepodařilo načíst.";
        }
      });
      row.append(detailToggle);
      entry.append(detailPanel);
    }
    list.append(entry);
  }
}

$("#invite-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  setInviteMessage("");
  try {
    const { invitation } = await inviteRequest("/api/invitations", { method: "POST", body: "{}" });
    $("#invite-url").value = invitation.inviteUrl;
    $("#invite-result").classList.remove("hidden");
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


async function openAccountReset(member) {
  const dialog = document.createElement("dialog");
  dialog.className = "account-reset-dialog";
  dialog.setAttribute("aria-labelledby", "account-reset-title");
  dialog.innerHTML = `<form><h2 id="account-reset-title">Znovu nastavit účet</h2>
    <p class="reset-member-name"></p>
    <p>Dosavadní evidence se archivuje. Binance objednávky se neprodají ani nezruší. Reset vyžaduje uzavřené pozice a pouze drobné zůstatky obchodovaných mincí.</p>
    <p>Nové nákupy, DCA i Streak zůstanou vypnuté. Bezpečnostní limity ztrát zůstávají zachované.</p>
    <label>Potvrď uživatelské jméno<input name="confirmation" autocomplete="off" required></label>
    <p class="reset-status" role="status">Načítám stav…</p>
    <div class="reset-archives"></div>
    <div class="admin-actions"><button type="button" class="reset-close">Zavřít</button><button type="button" class="reset-refresh">Obnovit stav</button><button type="submit" class="primary" disabled>Archivovat a nastavit znovu</button></div>
  </form>`;
  document.body.append(dialog);
  const status = dialog.querySelector(".reset-status"), submit = dialog.querySelector('[type="submit"]');
  const input = dialog.querySelector("input");
  dialog.querySelector(".reset-member-name").textContent = `@${member.username}`;
  let snapshot = null, sending = false, timer = null;
  let requestId = crypto.randomUUID();
  const enable = () => { submit.disabled = sending || !snapshot || snapshot.reset.request?.status === "queued" || (snapshot.reset.request?.id === requestId && snapshot.reset.request?.status === "completed") || input.value !== member.username; };
  input.addEventListener("input", enable);
  async function refresh() {
    clearTimeout(timer);
    try {
      snapshot = await inviteRequest(`/api/members/${member.id}/account-reset`);
      if (!dialog.open) return;
      const request = snapshot.reset.request;
      if (request?.id === requestId && request.status === "rejected") requestId = crypto.randomUUID();
      status.textContent = request?.status === "queued" ? "Čekám na kontrolu Binance. Automatizace je pozastavená."
        : request?.status === "completed" ? "Nové období bylo založeno. Nákupy zůstávají pozastavené; před obnovením musí projít kontrola účtu."
        : request?.status === "rejected" ? request.error : "Připraveno k potvrzení.";
      const archives = dialog.querySelector(".reset-archives"); archives.replaceChildren();
      for (const archive of snapshot.archives) {
        const link = document.createElement("a");
        link.href = `/api/members/${member.id}/account-reset/archives/${encodeURIComponent(archive.id)}`;
        link.textContent = `Archiv evidence · ${new Date(archive.createdAt).toLocaleString("cs-CZ")}`;
        archives.append(link);
      }
      if (request?.status === "queued") timer = setTimeout(refresh, 5000);
    } catch (error) { snapshot = null; status.textContent = error.message; }
    enable();
  }
  dialog.querySelector(".reset-close").addEventListener("click", () => dialog.close());
  dialog.querySelector(".reset-refresh").addEventListener("click", refresh);
  dialog.addEventListener("close", () => { clearTimeout(timer); dialog.remove(); });
  dialog.querySelector("form").addEventListener("submit", async event => {
    event.preventDefault();
    if (submit.disabled) return;
    sending = true; enable();
    try {
      const result = await inviteRequest(`/api/members/${member.id}/account-reset`, { method:"POST", body:JSON.stringify({ confirmation:input.value, requestId, instanceId:snapshot.instanceId, epoch:snapshot.reset.epoch }) });
      requestId = result.reset.request.id;
      await refresh();
    } catch (error) { status.textContent = error.message; }
    finally { sending = false; enable(); }
  });
  dialog.showModal();
  await refresh();
}

window.initAdmin = () => Promise.all([loadInvitations(), loadMembers()]);
