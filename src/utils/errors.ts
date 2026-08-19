/**
 * The message of a thrown value, whatever it turned out to be. `catch` binds
 * `unknown`, so every reporting site was re-deriving this same ternary and had
 * its own chance to drop the non-Error case and log "[object Object]".
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
