import type { MigrationDb } from "../../src/migrator/migration-db.ts";
import type { ObjectId } from "mongodb";

export const id = "2026-07-18T00-30-00Z__lowercase-user-emails";
export const phase = "post" as const;
export const transactional = false as const;

type Row = {
  _id: ObjectId;
  email: string;
};

/**
 * Normalize every stored user email to lowercase.
 *
 * Background: user emails were previously persisted verbatim from the
 * create/update payloads (UserDoc.email used plain Email, not LowercaseEmail).
 * The bootstrap migration (0000-00-00T00-00-00Z__bootstrap-indexes.ts:15)
 * created a UNIQUE index on users.email — but MongoDB unique indexes are
 * case-sensitive by default, so "Alice@x.com" and "alice@x.com" are treated
 * as distinct values and CAN coexist. Case-variant duplicates make
 * login-by-email non-deterministic (findOne returns whichever the query
 * planner picks first).
 *
 * The UserCreateInput.email and UserUpdateInput.email schemas now use
 * LowercaseEmail (lowercases at parse time), so all NEW writes are canonical
 * from deploy onward; this migration repairs EXISTING rows.
 *
 * Phase = post: this migration rewrites existing user data (lowercasing
 * emails) and, for collision groups, nulls duplicate emails. That is a data
 * rewrite, not an additive change, so it belongs in post/ — run by the
 * manager after container swap (Discourse-style Phase 6), where destructive
 * work is permitted and operator review is expected. Applied state is tracked
 * in `_migrations`; re-running update skips already-applied ids.
 *
 * Collision handling: stop before any write. User email is required by schema;
 * selecting a winner or nulling other users would silently change account
 * ownership and make documents undecodable. Operator must resolve collisions.
 *
 * Idempotent: once canonical, all rows pass without writes.
 */
export async function up(mdb: MigrationDb): Promise<void> {
  const rows = (await mdb
    .collection("users")
    .find(
      { email: { $type: "string" } },
      {
        projection: {
          _id: 1,
          email: 1,
        },
      },
    )
    .toArray()) as unknown as Row[];

  if (rows.length === 0) {
    console.log(
      "[migration:lowercase-user-emails] no user emails to inspect",
    );
    return;
  }

  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.email.toLowerCase();
    let arr = groups.get(key);
    if (!arr) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(r);
  }

  const collisionCount = [...groups.values()].filter(
    (group) => group.length > 1,
  ).length;
  if (collisionCount > 0) {
    throw new Error(
      `[migration:lowercase-user-emails] ${collisionCount} case-insensitive duplicate email group(s) require manual resolution`,
    );
  }

  type UpdateOneOp = {
    updateOne: {
      filter: { _id: ObjectId };
      update: { $set: Record<string, unknown> };
    };
  };
  const ops: UpdateOneOp[] = [];
  let normalized = 0;
  for (const [, arr] of groups) {
    const r = arr[0]!;
    const canonical = r.email.toLowerCase();
    if (r.email !== canonical) {
      ops.push({
        updateOne: {
          filter: { _id: r._id },
          update: { $set: { email: canonical } },
        },
      });
      normalized++;
    }
  }

  if (ops.length > 0) {
    await mdb.collection("users").bulkWrite(ops, { ordered: false });
  }
  console.log(
    `[migration:lowercase-user-emails] normalized ${normalized} email(s)`,
  );
}

export async function down(_mdb: MigrationDb): Promise<void> {
  throw new Error("Email lowercasing migration cannot be rolled back");
}
