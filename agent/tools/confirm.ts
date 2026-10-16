/**
 * AUTO_CONFIRM lets an operator run the agent without the user-facing
 * elicitation step on every GitHub write. Each write tool consults
 * isAutoConfirm() right before it would otherwise call ctx.agent.suspend(...).
 *
 * Truthy values: true / 1 / yes (case-insensitive). Anything else is false,
 * including unset. Read lazily per call so tests can set and unset the var.
 */
export function isAutoConfirm(): boolean {
  const v = process.env.AUTO_CONFIRM?.trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}
