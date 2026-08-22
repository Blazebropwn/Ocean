const form = document.querySelector("#reset-form");
const message = document.querySelector("#reset-message");
const token = new URLSearchParams(location.search).get("token");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  if (values.password !== values.confirmation) { message.textContent = "Hesla se neshodují."; return; }
  const button = form.querySelector("button"); button.disabled = true;
  try {
    const response = await fetch("/api/auth/recovery/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password: values.password }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error);
    message.className = "message success"; message.textContent = body.message;
    const link = document.createElement("a"); link.className = "primary result-link"; link.href = "/"; link.textContent = "Přihlásit se →"; form.replaceChildren(message, link);
  } catch (error) { message.textContent = error.message; button.disabled = false; }
});
