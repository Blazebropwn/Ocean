// Display only: authentication, identifiers and stored values remain unchanged.
globalThis.OceanNames = Object.freeze({
  formatNickname(value) {
    const [first, ...rest] = Array.from(String(value ?? ''));
    return first ? first.toLocaleUpperCase('cs-CZ') + rest.join('') : '';
  },
});
