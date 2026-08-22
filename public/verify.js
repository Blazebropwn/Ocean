const title = document.querySelector("#verify-title");
const message = document.querySelector("#verify-message");
const link = document.querySelector("#continue");
const token = new URLSearchParams(location.search).get("token");

fetch("/api/auth/verification/confirm", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token }),
}).then(async (response) => {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  title.innerHTML = "E-mail <em>ověřen.</em>";
  message.textContent = "Vaše OCEAN identita má nyní ověřenou e-mailovou adresu.";
}).catch((error) => {
  title.textContent = "Odkaz nefunguje.";
  message.textContent = error.message || "Ověřovací odkaz není platný.";
}).finally(() => link.classList.remove("hidden"));
