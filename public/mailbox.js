const list = document.querySelector("#mail-list");
fetch("/api/dev/mailbox").then(async (response) => {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  if (!body.messages.length) list.textContent = "Mailbox je zatím prázdný.";
  for (const mail of body.messages) {
    const card = document.createElement("article");
    card.className = "mail";
    const link = mail.body.match(/https?:\/\/\S+/)?.[0];
    const recipient = document.createElement("small"); recipient.textContent = `PRO: ${mail.recipient}`;
    const subject = document.createElement("strong"); subject.textContent = mail.subject;
    card.append(recipient, subject);
    if (link) { const anchor = document.createElement("a"); anchor.href = link; anchor.textContent = "Ověřit e-mail →"; card.append(anchor); }
    list.append(card);
  }
}).catch((error) => { list.textContent = error.message; });
