// Only the SDK-verified Telegram identity can keep the existing owner account
// on its private repository. All other callers enter public authorization.
const canonicalTelegramId = value => {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const id = String(value);
  return /^[1-9][0-9]{0,15}$/.test(id) && Number.isSafeInteger(Number(id)) ? id : null;
};

export function shouldUsePublicAccount(config, ownerTelegramId, ctx) {
  if (config?.enabled !== true) return false;
  if (config.preservePrivateOwner !== true) return true;
  const owner = canonicalTelegramId(ownerTelegramId);
  const observed = canonicalTelegramId(ctx?.initData?.user?.id);
  return owner === null || observed === null || observed !== owner;
}
