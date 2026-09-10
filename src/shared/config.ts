/**
 * src/shared/config.ts — small cross-cutting constants shared by the
 * worker and the panel. Keeping DEFAULT_MODEL here (rather than in
 * gemini.ts) lets the settings UI show it as a placeholder without pulling
 * the whole Gemini client into the panel bundle.
 */

export const DEFAULT_MODEL = "gemini-2.5-flash";
