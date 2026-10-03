#!/usr/bin/env node
/**
 * Make a freshly seeded snapshot database worth screenshotting, whatever the schema era:
 *   - no records at all (before the project had a seed) -> a small hand-written dataset
 *   - a second user, so pages about other people or shared content have something to show
 *   - placeholder images for every record that has none
 *   - every other table the seed left empty gets a row or two
 *   - route-hints.json: concrete URLs for dynamic routes nothing links to
 *
 *   node enrich.mjs <appDir> <resultDir> <modulesFrom>
 *
 * Everything goes through raw SQL filtered against information_schema, so the same script
 * works against any migration state. Each step is best-effort and logs what it skipped.
 *
 * The tables here (User, Item, Photo, Comment) stand in for your app's own. Keep the
 * helpers, replace the dataset.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pictureSvg, avatarSvg } from "./placeholders.mjs";

const [appDir, resultDir, modulesFrom] = process.argv.slice(2);
const require = createRequire(path.join(modulesFrom, "package.json"));
const pg = require("pg");
const sharp = require("sharp");

const EMAIL = process.env.TEST_USER_EMAIL ?? "test@example.com";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
const now = new Date();
const daysAgo = (n) => new Date(now.getTime() - n * 86_400_000);

const columnCache = new Map();
async function columns(table) {
  if (!columnCache.has(table)) {
    const { rows } = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
      [table],
    );
    columnCache.set(table, new Set(rows.map((r) => r.column_name)));
  }
  return columnCache.get(table);
}
const hasTable = async (table) => (await columns(table)).size > 0;

/** Insert using only the columns this schema has. Returns the new row, or null. */
async function insert(table, values) {
  const cols = await columns(table);
  if (cols.size === 0) return null;
  const row = { createdAt: now, updatedAt: now, ...values };
  const keys = Object.keys(row).filter((k) => cols.has(k) && row[k] !== undefined);
  const sql = `INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`;
  try {
    const { rows } = await client.query(sql, keys.map((k) => row[k]));
    return rows[0];
  } catch (err) {
    console.log(`  (skip ${table}: ${err.message})`);
    return null;
  }
}

async function one(sql, params = []) {
  try {
    const { rows } = await client.query(sql, params);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

const isEmpty = async (table) => (await hasTable(table)) && ((await one(`SELECT count(*)::int AS n FROM "${table}"`))?.n ?? 1) === 0;
const first = (table, where = "", params = []) => one(`SELECT * FROM "${table}" ${where} ORDER BY id LIMIT 1`, params);

/** A small dataset for `userId`, written against whatever columns exist. */
async function seedItems(userId, size) {
  const items = [];
  for (let i = 0; i < size; i++) {
    const item = await insert("Item", {
      userId,
      // Use names and values that look like real content for your subject.
      title: `Sample item ${i + 1}`,
      description: i % 3 === 0 ? "A longer description, so pages that show one are not captured blank." : undefined,
      status: i === size - 1 && size > 4 ? "ARCHIVED" : "ACTIVE",
      createdAt: daysAgo(200 - i * 12),
    });
    if (item) items.push(item);
  }
  return items;
}

async function writeImage(svg, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const base = sharp(Buffer.from(svg));
  await base.clone().webp({ quality: 82 }).toFile(path.join(dir, `${name}.webp`));
  await base.clone().resize(400, 400).webp({ quality: 78 }).toFile(path.join(dir, `${name}_thumb.webp`));
  return { url: `${name}.webp`, thumbnailUrl: `${name}_thumb.webp` };
}

/** Give every row of `owner` without a photo `count(row)` placeholder images. */
async function addPhotos({ owner, photos, fk, subdir, draw, count }) {
  if (!(await hasTable(owner)) || !(await hasTable(photos))) return 0;
  const { rows } = await client.query(
    `SELECT o.* FROM "${owner}" o WHERE NOT EXISTS (SELECT 1 FROM "${photos}" p WHERE p."${fk}" = o.id) ORDER BY o.id`,
  );
  let added = 0;
  for (const row of rows) {
    for (let k = 0; k < count(row); k++) {
      const files = await writeImage(draw(row, k), path.join(appDir, "public", "uploads", subdir, String(row.id)), `placeholder-${row.id}-${k}`);
      const urls = Object.fromEntries(Object.entries(files).map(([key, v]) => [key, `/uploads/${subdir}/${row.id}/${v}`]));
      if (await insert(photos, { [fk]: row.id, ...urls })) added++;
    }
  }
  return added;
}

/**
 * Fill every feature table the project's own seed leaves empty, so no page is captured in
 * its empty state. Only empty tables are touched; a table this era lacks is skipped.
 */
async function seedFeatures(user, other, items) {
  const seeded = [];
  const fill = async (table, run) => {
    if (!(await isEmpty(table))) return;
    await run();
    if (!(await isEmpty(table))) seeded.push(table);
  };
  const [i1, i2] = items;
  await fill("Comment", async () => {
    if (!i1 || !other) return;
    await insert("Comment", { itemId: i1.id, authorId: other.id, body: "Looks good. Is this the latest version?", createdAt: daysAgo(2) });
    await insert("Comment", { itemId: i1.id, authorId: user.id, body: "Yes, updated yesterday.", createdAt: daysAgo(1) });
  });
  await fill("Notification", async () => {
    if (i2) await insert("Notification", { userId: user.id, itemId: i2.id, kind: "comment", readAt: undefined });
  });
  return seeded;
}

async function main() {
  await client.connect();
  // The earliest commits may have no accounts, or a User table but no way to create a row.
  const user =
    (await one(`SELECT * FROM "User" WHERE email = $1`, [EMAIL])) ??
    (await insert("User", { email: EMAIL, name: "Test User", passwordHash: process.env.TEST_USER_PASSWORD_HASH ?? "-" })) ??
    { id: undefined, anonymous: true };
  const report = { handSeeded: false, photos: {}, hints: {} };

  const existing = user.anonymous ? await one(`SELECT count(*)::int AS n FROM "Item"`) : await one(`SELECT count(*)::int AS n FROM "Item" WHERE "userId" = $1`, [user.id]);
  if ((existing?.n ?? 0) === 0) {
    console.log("no records in this snapshot: writing the hand-made dataset");
    await seedItems(user.id, 10);
    report.handSeeded = true;
  }
  const { rows: items } = user.anonymous
    ? await client.query(`SELECT * FROM "Item" ORDER BY id`).catch(() => ({ rows: [] }))
    : await client.query(`SELECT * FROM "Item" WHERE "userId" = $1 ORDER BY id`, [user.id]).catch(() => ({ rows: [] }));

  // A second account, for anything social or shared.
  const other = user.anonymous ? null :
    (await one(`SELECT * FROM "User" WHERE email = 'second@example.com'`)) ??
    (await insert("User", { email: "second@example.com", name: "Second User", passwordHash: user.passwordHash }));
  if (other) await seedItems(other.id, 3);

  for (const person of [user, other].filter((p) => p && !p.anonymous)) {
    if (!(await columns("User")).has("image") || person.image) continue;
    const files = await writeImage(avatarSvg(person.id, (person.name ?? person.email ?? "?")[0].toUpperCase()), path.join(appDir, "public", "uploads", "users", String(person.id)), `placeholder-${person.id}`);
    await client.query(`UPDATE "User" SET "image" = $1 WHERE id = $2`, [`/uploads/users/${person.id}/${files.url}`, person.id]).catch(() => {});
  }

  report.photos.items = await addPhotos({
    owner: "Item", photos: "Photo", fk: "itemId", subdir: "items",
    count: (row) => 1 + (row.id % 3),
    draw: (row, k) => pictureSvg(row.id * 7 + k),
  });

  report.features = user.anonymous ? [] : await seedFeatures(user, other, items);

  // Dynamic routes nothing links to.
  const hints = report.hints;
  if (items[0]) hints["/items/[id]"] = `/items/${items[0].id}`;
  if (other) hints["/users/[userId]"] = `/users/${other.id}`;

  fs.writeFileSync(path.join(resultDir, "route-hints.json"), JSON.stringify(hints, null, 2));
  // Tables still empty after all this: each one a page shows is a gap to fill above.
  const stillEmpty = [];
  const { rows: tables } = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%'`);
  for (const { table_name } of tables) if (await isEmpty(table_name)) stillEmpty.push(table_name);
  report.stillEmpty = stillEmpty.sort();
  fs.writeFileSync(path.join(resultDir, "enrich.json"), JSON.stringify(report, null, 2));
  console.log(`enriched: handSeeded=${report.handSeeded} photos=${JSON.stringify(report.photos)} hints=${Object.keys(hints).length}`);
  console.log(`features seeded: ${report.features.join(" ") || "-"}`);
  console.log(`still empty: ${stillEmpty.join(" ") || "-"}`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
