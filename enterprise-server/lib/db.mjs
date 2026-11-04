import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// Business documents are small JSON records. Metering events have a separate indexed ledger.
export async function openStore({ url, file = "./data/relay.sqlite" } = {}) {
  let pool, sqlite;
  if (url) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url, max: 5 });
  } else {
    if (file !== ":memory:")
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    sqlite = new DatabaseSync(file);
    sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  }
  function executor(client) {
    return async (sql, params = []) => {
      if (pool) return (await client.query(sql, params)).rows;
      const ordered = [];
      const converted = sql.replace(/\$(\d+)/g, (_, n) => {
        ordered.push(params[+n - 1]);
        return "?";
      });
      const stmt = sqlite.prepare(converted);
      return stmt.columns().length
        ? stmt.all(...ordered)
        : (stmt.run(...ordered), []);
    };
  }
  const base = executor(pool);
  await base(
    `CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id))`,
  );
  await base(
    `CREATE TABLE IF NOT EXISTS usage_events (gateway_id TEXT NOT NULL, event_id TEXT NOT NULL, credential_id TEXT NOT NULL, employee_id TEXT NOT NULL, device_id TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT NOT NULL, upload_bytes BIGINT NOT NULL, download_bytes BIGINT NOT NULL, fingerprint TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(gateway_id,event_id))`,
  );
  await base(
    `CREATE INDEX IF NOT EXISTS usage_employee_time ON usage_events(employee_id,ended_at)`,
  );
  await base(
    `CREATE INDEX IF NOT EXISTS usage_gateway_time ON usage_events(gateway_id,ended_at)`,
  );
  await base(
    `CREATE INDEX IF NOT EXISTS usage_credential_window ON usage_events(gateway_id,credential_id,started_at,ended_at)`,
  );
  const helpers = (q) => ({
    q,
    async get(kind, id) {
      const rows = await q(
        "SELECT body FROM documents WHERE kind=$1 AND id=$2",
        [kind, id],
      );
      return rows.length ? JSON.parse(rows[0].body) : null;
    },
    async list(kind) {
      return (
        await q("SELECT body FROM documents WHERE kind=$1 ORDER BY id", [kind])
      ).map((r) => JSON.parse(r.body));
    },
    async put(kind, id, body) {
      await q(
        "INSERT INTO documents(kind,id,body) VALUES($1,$2,$3) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body",
        [kind, id, JSON.stringify(body)],
      );
      return body;
    },
    async del(kind, id) {
      await q("DELETE FROM documents WHERE kind=$1 AND id=$2", [kind, id]);
    },
  });
  let chain = Promise.resolve();
  const readers = helpers(base);
  return {
    // A shared SQLite connection must not expose partial writes between awaited steps.
    q: (...args) => chain.then(() => readers.q(...args)),
    get: (...args) => chain.then(() => readers.get(...args)),
    list: (...args) => chain.then(() => readers.list(...args)),
    type: pool ? "postgres" : "sqlite",
    tx(fn) {
      const task = async () => {
        const client = pool ? await pool.connect() : null;
        const q = executor(client);
        try {
          await q(pool ? "BEGIN" : "BEGIN IMMEDIATE");
          if (pool) await q("SELECT pg_advisory_xact_lock(824242)");
          const value = await fn(helpers(q));
          await q("COMMIT");
          return value;
        } catch (e) {
          try {
            await q("ROLLBACK");
          } catch {}
          throw e;
        } finally {
          client?.release();
        }
      };
      const next = chain.then(task, task);
      chain = next.catch(() => {});
      return next;
    },
    async close() {
      await chain;
      if (pool) await pool.end();
      else sqlite.close();
    },
  };
}
