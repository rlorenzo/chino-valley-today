/**
 * The message of a thrown value, whatever it turned out to be. `catch` binds
 * `unknown`, so every reporting site was re-deriving this same ternary and had
 * its own chance to get the non-Error branch wrong (reading `.message` off a
 * non-Error logs `undefined`). This does not dress up a thrown plain object —
 * `String({})` is still "[object Object]" — it just makes every site behave
 * the same way.
 */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
