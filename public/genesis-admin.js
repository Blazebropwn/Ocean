let genesisOverviewData = null;
const tideNumber = value => new Intl.NumberFormat("cs-CZ").format(value);

function renderGenesisCodes() {
  const tbody = $("#genesis-admin-codes");
  tbody.replaceChildren();
  const filter = $("#genesis-status-filter").value;
  const search = $("#genesis-search").value.trim().toLowerCase().replace(/^#/, "");
  const codes = genesisOverviewData?.codes || [];
  const matching = codes.filter(code => (filter === "all" || code.status === filter)
    && (!search || (/^\d+$/.test(search) ? code.number === Number(search) : [code.id, code.redeemedUsername || "", code.redeemedBy || ""].some(value => value.toLowerCase().includes(search)))));
  for (const code of matching) {
    const row = document.createElement("tr");
    const values = [`#${String(code.number).padStart(3, "0")}`, `${tideNumber(code.rewardTide)} TIDE`,
      code.status === "redeemed" ? "Aktivovaný" : "Nevyzvednutý", code.redeemedUsername ? `@${code.redeemedUsername}` : "—",
      code.redeemedAt ? new Date(code.redeemedAt).toLocaleString("cs-CZ") : "—"];
    values.forEach((value, index) => {
      const cell = document.createElement("td"); cell.textContent = value;
      if (index === 0) cell.title = code.id;
      if (index === 2) cell.className = code.status === "redeemed" ? "genesis-used" : "genesis-unclaimed";
      row.append(cell);
    });
    tbody.append(row);
  }
  $("#genesis-admin-count").textContent = codes.length ? `${matching.length} z ${codes.length} kódů` : "";
}

async function loadGenesisOverview() {
  const refresh = $("#genesis-refresh"), select = $("#genesis-wave"), message = $("#genesis-admin-message");
  const selected = select.value;
  refresh.disabled = true; $("#genesis-export").disabled = true; select.disabled = true; message.textContent = "Načítám…";
  genesisOverviewData = null; $("#genesis-summary").replaceChildren(); renderGenesisCodes();
  try {
    const data = await inviteRequest("/api/admin/genesis" + (selected ? `?wave=${encodeURIComponent(selected)}` : ""));
    genesisOverviewData = data;
    select.replaceChildren();
    for (const wave of data.waves) {
      const option = document.createElement("option"); option.value = wave.id; option.textContent = wave.id; select.append(option);
    }
    select.value = data.selectedWave || "";
    const wave = data.waves.find(w => w.id === data.selectedWave);
    if (!wave) { message.textContent = "Žádná emise zatím nebyla vydaná."; return; }
    const metrics = [["Celková emise", wave.totalSupply], ["Alokace správci", wave.adminCredited], ["Alokace kódům", wave.codeAllocation],
      ["Vyzvednuto z kódů", wave.redeemedAmount], ["Zbývá vyzvednout", wave.unclaimedAmount]];
    for (const [label, value] of metrics) {
      const card = document.createElement("div"), title = document.createElement("small"), amount = document.createElement("strong");
      title.textContent = label; amount.textContent = `${tideNumber(value)} TIDE`; card.append(title, amount); $("#genesis-summary").append(card);
    }
    message.textContent = wave.accountingValid ? `${wave.redeemedCodes} / ${wave.totalCodes} aktivací · Účetní součty souhlasí${wave.adminUsername ? ` · Správce @${wave.adminUsername}` : ""}` : "Účetní součty vyžadují kontrolu.";
    message.classList.toggle("genesis-accounting-error", !wave.accountingValid);
    $("#genesis-export").disabled = false;
    renderGenesisCodes();
  } catch (error) { message.textContent = error.message || "Přehled není dostupný."; }
  finally { refresh.disabled = false; select.disabled = !genesisOverviewData?.waves.length; }
}
$("#genesis-refresh").addEventListener("click", loadGenesisOverview);
$("#genesis-wave").addEventListener("change", loadGenesisOverview);
$("#genesis-status-filter").addEventListener("change", renderGenesisCodes);
$("#genesis-search").addEventListener("input", renderGenesisCodes);

$("#genesis-export").addEventListener("click", async () => {
  const button = $("#genesis-export"), wave = $("#genesis-wave").value;
  button.disabled = true; button.textContent = "Připravuji…";
  try {
    const response = await fetch("/api/admin/genesis/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ wave }) });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || "Export není dostupný."); }
    const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
    link.href = url; link.download = `genesis-codes-${wave}.csv`; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { $("#genesis-admin-message").textContent = error.message || "Export se nepodařil."; }
  finally { button.disabled = false; button.textContent = "Stáhnout CSV"; }
});
window.initAdmin = loadGenesisOverview;
