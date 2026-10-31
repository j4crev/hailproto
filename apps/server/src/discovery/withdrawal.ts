import type { SQL } from "bun";

/** Call inside the same transaction that retires/closes the account. Signed
 * artifacts remain private audit evidence; both public discovery routes hide them.
 * Closure must also revoke credentials and stop new publication before committing.
 */
export async function withdrawAccountBindings(tx:SQL,accountId:string,reason:"migration"|"account-deletion") {
  await tx`INSERT INTO address_binding_withdrawals(binding_id,reason)
    SELECT id,${reason} FROM address_bindings WHERE account_id=${accountId} ON CONFLICT DO NOTHING`;
}
