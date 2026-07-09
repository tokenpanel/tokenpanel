import type { MigrationDb } from "../../src/migrator/migration-db.ts";
import type { ObjectId } from "mongodb";

export const id = "2026-07-07T02-00-00Z__lowercase-customer-emails";
export const phase = "post" as const;
export const transactional = true as const;

type Row = {
  _id: ObjectId;
  organizationId: ObjectId;
  email: string;
  createdAt: Date;
  metadata: Record<string, unknown> | undefined;
};

/**
 * Normalize every stored customer email to lowercase AND resolve any
 * pre-existing case-variant duplicates so the case-insensitive attribution
 * lookup (findOne by email in v1-chat-context.ts and the management lookup
 * endpoint) is deterministic.
 *
 * Background: customer emails were previously persisted verbatim from the
 * create/update payloads, but attribution lookups lowercase the requested
 * email before the exact DB match. A stored uppercase email therefore missed
 * lookups, and case variants of one address could create duplicate customers
 * within an org (the (organizationId, email) index is non-unique). The
 * create/update input schemas now lowercase at parse time, so all NEW writes
 * are canonical from deploy onward; this migration repairs EXISTING rows.
 *
 * Phase = post: this migration rewrites existing customer data (lowercasing
 * emails) and, for collision groups, nulls duplicate emails. That is a data
 * rewrite, not an additive change, so it belongs in post/ — run by the
 * manager after container swap (Discourse-style Phase 6), where destructive
 * work is permitted and operator review is expected. Applied state is tracked
 * in `_migrations`; re-running update skips already-applied ids. The new-write
 * lowercasing (schema layer) takes effect immediately at deploy; only the
 * retroactive repair of historical rows waits for this post-migration.
 *
 * Uniqueness is enforced by the follow-on post migration
 * 2026-07-09T00-00-00Z__unique-customer-email-index (runs after this one).
 *
 * Collision handling: if an org already has multiple rows whose emails collide
 * once lowercased, lowercasing all of them would leave true duplicates, making
 * findOne-by-email return a non-deterministic row (the ambiguity this
 * migration exists to remove). We resolve each group deterministically:
 *   - winner = oldest row (tiebreak smallest _id) keeps the lowercased email
 *     as the canonical attribution target;
 *   - every other row's email is set to null so it can no longer collide;
 *   - the displaced original email is preserved in metadata.duplicateEmail so
 *     no data is lost and an operator can reassign it after review.
 *
 * Every collision group is logged at WARN so an operator running this can see
 * exactly which customers had emails displaced and reassign them if needed.
 * The email field is nullable by schema (z.string().email().nullish()), so
 * writing null is shape-valid.
 */
export async function up(mdb: MigrationDb): Promise<void> {
  const rows = (await mdb
    .collection("customers")
    .find(
      { email: { $type: "string" } },
      {
        projection: {
          _id: 1,
          organizationId: 1,
          email: 1,
          createdAt: 1,
          metadata: 1,
        },
      },
    )
    .toArray()) as unknown as Row[];

  if (rows.length === 0) {
    console.log(
      "[migration:lowercase-customer-emails] no customer emails to inspect",
    );
    return;
  }

  // Group by (org, lowercased email) to find collisions that would be created
  // or already exist after lowercasing.
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.organizationId.toHexString()}\u0000${r.email.toLowerCase()}`;
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(r);
  }

  type UpdateOneOp = {
    updateOne: {
      filter: { _id: ObjectId };
      update: { $set: Record<string, unknown> };
    };
  };
  const ops: UpdateOneOp[] = [];
  let normalized = 0;
  let resolvedLosers = 0;

  for (const [, arr] of groups) {
    if (arr.length === 1) {
      const r = arr[0]!;
      if (r.email !== r.email.toLowerCase()) {
        ops.push({
          updateOne: {
            filter: { _id: r._id },
            update: { $set: { email: r.email.toLowerCase() } },
          },
        });
        normalized++;
      }
      continue;
    }

    // Collision group. Pick the winner deterministically (oldest createdAt,
    // tiebreak smallest _id) so re-running the migration never picks a
    // different canonical row.
    arr.sort((a, b) => {
      const at = a.createdAt?.getTime() ?? 0;
      const bt = b.createdAt?.getTime() ?? 0;
      if (at !== bt) return at - bt;
      const ah = a._id.toHexString();
      const bh = b._id.toHexString();
      return ah < bh ? -1 : ah > bh ? 1 : 0;
    });
    const winner = arr[0]!;
    const losers = arr.slice(1);
    const canonical = winner.email.toLowerCase();

    if (winner.email !== canonical) {
      ops.push({
        updateOne: {
          filter: { _id: winner._id },
          update: { $set: { email: canonical } },
        },
      });
      normalized++;
    }

    console.warn(
      `[migration:lowercase-customer-emails] collision in org ${winner.organizationId.toHexString()} on email ${canonical}: winner=${winner._id.toHexString()}, ${losers.length} duplicate(s) to resolve`,
    );

    for (const l of losers) {
      // Preserve the original email in metadata before nulling so no data is
      // lost; an operator can review the warn log and reassign manually.
      const preservedMeta: Record<string, unknown> = {
        ...(l.metadata ?? {}),
        duplicateEmail: l.email,
      };
      ops.push({
        updateOne: {
          filter: { _id: l._id },
          update: {
            $set: {
              email: null,
              metadata: preservedMeta,
            },
          },
        },
      });
      resolvedLosers++;
      console.warn(
        `[migration:lowercase-customer-emails]   nulled duplicate email "${l.email}" on customer ${l._id.toHexString()} (original preserved in metadata.duplicateEmail)`,
      );
    }
  }

  if (ops.length > 0) {
    await mdb.collection("customers").bulkWrite(ops, { ordered: false });
  }
  console.log(
    `[migration:lowercase-customer-emails] normalized ${normalized} email(s); resolved ${resolvedLosers} duplicate email(s)`,
  );
}

export async function down(_mdb: MigrationDb): Promise<void> {
  throw new Error("Email lowercasing migration cannot be rolled back");
}
