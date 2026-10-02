const $ = selector => document.querySelector(selector);
async function inviteRequest(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...options });
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Požadavek se nepodařil.');
  return data;
}
window.addEventListener('DOMContentLoaded', async () => {
  try {
    const { user } = await inviteRequest('/api/me');
    if (user.role !== 'owner' || !(user.accessApproved ?? user.emailVerified)) throw new Error('Přístup má pouze schválený správce.');
    $('#admin-identity').textContent = `@${user.username}`;
    $('#admin-body').classList.remove('hidden');
    $('#admin-status').textContent = '';
    await window.initAdmin();
  } catch (error) { $('#admin-status').textContent = error.message || 'Správa není dostupná.'; }
});
