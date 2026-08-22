const form = document.querySelector("#recovery-form");
const message = document.querySelector("#recovery-message");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const response = await fetch("/api/auth/recovery/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    message.className = "message success";
    message.textContent = `${body.message} Při místním vývoji jej najdete ve vývojové schránce.`;
    const link = document.createElement("a"); link.className = "form-link"; link.href = "/mailbox.html"; link.textContent = "Otevřít schránku →"; form.append(link);
  } catch (error) { message.textContent = error.message; button.disabled = false; }
});
