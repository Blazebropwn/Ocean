const form = document.querySelector("#change-password-form");
const message = document.querySelector("#change-message");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  if (values.newPassword !== values.confirmation) { message.textContent = "Nová hesla se neshodují."; return; }
  const button = form.querySelector("button"); button.disabled = true;
  try {
    const response = await fetch("/api/account/password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: values.currentPassword, newPassword: values.newPassword }) });
    const body = await response.json(); if (!response.ok) throw new Error(body.error);
    message.className = "message success"; message.textContent = body.message; form.reset();
  } catch (error) { message.textContent = error.message; } finally { button.disabled = false; }
});
