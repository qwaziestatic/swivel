/**
 * src/sidepanel/settings.ts — panel-side settings access.
 *
 * The side panel is trusted extension UI with full chrome.* access, so it
 * writes the Gemini API key DIRECTLY to chrome.storage.local. The key
 * therefore never travels through chrome.runtime.sendMessage — it is not a
 * field on any SwivelMessage, and cannot be (Charter Law 2). The worker
 * reads the same storage key per call. No SET_API_KEY message exists,
 * on purpose: what isn't in the message union can't leak into a page.
 *
 * These keys MUST match the ones the worker reads in src/background/index.ts.
 */

const KEY_API = "swivel:apiKey";
const KEY_MODEL = "swivel:model";

export async function saveApiKey(key: string): Promise<void> {
  await chrome.storage.local.set({ [KEY_API]: key.trim() });
}

/** Returns whether a key is set and a masked preview — never the raw key
 *  in the render tree beyond the input the user is actively typing in. */
export async function getApiKeyStatus(): Promise<{ set: boolean; masked: string }> {
  const stored = await chrome.storage.local.get(KEY_API);
  const key = typeof stored[KEY_API] === "string" ? (stored[KEY_API] as string) : "";
  if (!key) return { set: false, masked: "" };
  const masked =
    key.length <= 8 ? "•".repeat(key.length) : `${key.slice(0, 4)}…${key.slice(-4)}`;
  return { set: true, masked };
}

export async function saveModel(model: string): Promise<void> {
  await chrome.storage.local.set({ [KEY_MODEL]: model.trim() });
}

export async function getModel(): Promise<string> {
  const stored = await chrome.storage.local.get(KEY_MODEL);
  return typeof stored[KEY_MODEL] === "string" ? (stored[KEY_MODEL] as string) : "";
}

// --- Runtime host permissions (Phase 10 permission diet) -------------------

export const GEMINI_ORIGIN = "https://generativelanguage.googleapis.com/*";
const KEY_ENABLED = "swivel:enabledRecipes";

/** Request a host permission (must be user-gesture-initiated). Returns
 *  whether it is now granted. */
export async function requestOrigin(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

export async function hasOrigin(origin: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/** Saving a key implies opting into the Gemini endpoint — grant it now so the
 *  worker's fetch isn't CORS-blocked. Kept out of install-time permissions so
 *  a fresh install prompts only for Gmail. */
export async function requestGeminiPermission(): Promise<boolean> {
  return requestOrigin(GEMINI_ORIGIN);
}

export async function getEnabledRecipes(): Promise<string[]> {
  const stored = await chrome.storage.local.get(KEY_ENABLED);
  const v = stored[KEY_ENABLED];
  return Array.isArray(v) ? (v as string[]) : [];
}

export async function setRecipeEnabled(id: string, enabled: boolean): Promise<void> {
  const current = new Set(await getEnabledRecipes());
  if (enabled) current.add(id);
  else current.delete(id);
  await chrome.storage.local.set({ [KEY_ENABLED]: [...current] });
}
