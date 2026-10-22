// Ephemeral PostgreSQL/WASM checks of the curated_stations migration; no live database.
// Run with pnpm run test:db.
import { access, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";

const migrationUrl = new URL("../../../supabase/migrations/20261021000009_curated_stations.sql", import.meta.url);
// iOS ships the same list in its bundle. The seed must not drift from it.
const iosListUrl = new URL("../../../pocket-radio-ios/podcasts/Radio/curated_stations.json", import.meta.url);
const migration = await readFile(migrationUrl, "utf8");

await test("curated_stations migration", async t => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    await db.exec(migration);
    const asRole = async (role, run) => {
      await db.exec(`set role ${role};`);
      try { return await run(); } finally { await db.exec("reset role;"); }
    };
    const select = "select id, name, description, logo_asset, tracklist_url, radio_browser_uuids, default_seed_uuid, seed_as_favorite from public.curated_stations order by position";

    await t.test("seeds the iOS list, in its order", async t => {
      try { await access(iosListUrl); } catch { t.skip("pocket-radio-ios is not checked out"); return; }
      const { stations } = JSON.parse(await readFile(iosListUrl, "utf8"));
      const expected = stations.map(s => ({
        id: s.id, name: s.name, description: s.description, logo_asset: s.logoAsset,
        tracklist_url: s.tracklistUrl, radio_browser_uuids: s.radioBrowserUUIDs,
        default_seed_uuid: s.defaultSeedUUID, seed_as_favorite: s.seedAsFavorite,
      }));
      assert.deepEqual((await db.query(select)).rows, expected);
    });

    await t.test("the anon and authenticated roles can read every row without a user header", async () => {
      const all = (await db.query(select)).rows;
      assert.ok(all.length > 0);
      for (const role of ["anon", "authenticated"]) {
        assert.deepEqual(await asRole(role, async () => (await db.query(select)).rows), all);
      }
    });

    await t.test("the anon and authenticated roles cannot change rows", async () => {
      const writes = [
        "insert into public.curated_stations (id, position, name, description, logo_asset, radio_browser_uuids, default_seed_uuid, seed_as_favorite) values ('x', 99, 'X', 'X', 'x', array['00000000-0000-4000-8000-000000000000']::uuid[], '00000000-0000-4000-8000-000000000000', false)",
        "update public.curated_stations set name = 'changed'",
        "delete from public.curated_stations",
        "truncate public.curated_stations",
      ];
      for (const role of ["anon", "authenticated"]) {
        for (const sql of writes) {
          await asRole(role, () => assert.rejects(db.query(sql), e => e.code === "42501", `${role}: ${sql}`));
        }
      }
      const rls = (await db.query("select relrowsecurity from pg_class where relname = 'curated_stations'")).rows[0];
      assert.equal(rls.relrowsecurity, true);
    });

    await t.test("rejects a default seed that is not one of the station's stream ids", async () => {
      await assert.rejects(db.query(
        "insert into public.curated_stations (id, position, name, description, logo_asset, radio_browser_uuids, default_seed_uuid, seed_as_favorite) values ('bad', 99, 'Bad', 'Bad', 'bad', array['00000000-0000-4000-8000-000000000001']::uuid[], '00000000-0000-4000-8000-000000000002', false)",
      ), e => e.code === "23514");
    });
  } finally { await db.close(); }
});
