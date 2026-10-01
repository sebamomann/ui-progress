#!/usr/bin/env node
/**
 * Make a freshly seeded snapshot database worth screenshotting, whatever the schema era:
 *   - no plants at all (before the project had a seed script) -> a small hand-written dataset
 *   - a second user who shares their collection, so /shared/... has something to show
 *   - placeholder photos for every plant, pot and location that has none
 *   - route-hints.json: concrete URLs for dynamic routes nothing links to
 *
 *   node enrich.mjs <appDir> <resultDir> <modulesFrom>
 *
 * Everything goes through raw SQL filtered against information_schema, so the same script
 * works against any migration state. Each step is best-effort and logs what it skipped.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { plantSvg, potSvg, locationSvg, avatarSvg } from "./placeholders.mjs";

const [appDir, resultDir, modulesFrom] = process.argv.slice(2);
const require = createRequire(path.join(modulesFrom, "package.json"));
const pg = require("pg");
const sharp = require("sharp");

const EMAIL = process.env.TEST_USER_EMAIL ?? "test@plants.local";
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

/** Insert using only the columns this schema has. Returns the new id, or null. */
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

const TYPES = [
  { commonName: "Monstera", genus: "Monstera", species: "deliciosa" },
  { commonName: "Snake Plant", genus: "Sansevieria", species: "trifasciata" },
  { commonName: "Chinese Money Plant", genus: "Pilea", species: "peperomioides" },
  { commonName: "Golden Pothos", genus: "Epipremnum", species: "aureum" },
  { commonName: "Old Man Cactus", genus: "Cephalocereus", species: "senilis" },
  { commonName: "Fiddle Leaf Fig", genus: "Ficus", species: "lyrata" },
];

/** A small collection for `userId`, written against whatever columns exist. */
async function seedCollection(userId, size) {
  const locations = [];
  for (const name of ["Living Room", "Bedroom", "Balcony"]) locations.push(await insert("Location", { userId, name }));
  const source = await insert("Source", { userId, name: "Garden centre" });
  const soil = await insert("Soil", { userId, name: "Aroid mix", notes: "Bark, perlite, coco coir" });
  const fertilizer = await insert("Fertilizer", { userId, name: "Liquid green", npk: "7-3-6", baseDosePerLiterMl: 4 });
  const types = [];
  for (const type of TYPES) types.push(await insert("PlantType", { userId, otherNames: [], ...type }));

  const plants = [];
  for (let i = 0; i < size; i++) {
    const type = types[i % types.length];
    const plant = await insert("Plant", {
      userId,
      // The first schema named plants directly, before plant types existed.
      name: TYPES[i % TYPES.length].commonName,
      species: `${TYPES[i % TYPES.length].genus} ${TYPES[i % TYPES.length].species}`,
      plantTypeId: type?.id,
      status: i === size - 1 && size > 4 ? "GIFTED" : "LIVING",
      sourceId: source?.id,
      locationId: locations[i % locations.length]?.id,
      soilId: soil?.id,
      fertilizerId: fertilizer?.id,
      acquiredAt: daysAgo(400 - i * 30),
      quantity: i % 5 === 0 ? 2 : 1,
      parentPlantId: i === 6 ? plants[0]?.id : undefined,
      isPropagation: i === 6 ? true : undefined,
      wateringFrequencySummerDays: 5 + (i % 4) * 2,
      wateringFrequencyWinterDays: 10 + (i % 4) * 3,
      sunRequirement: 1 + (i % 3),
      waterRequirement: 1 + ((i + 1) % 3),
      fertilizingCycleSummerWeeks: 2 + (i % 3),
      fertilizingCycleWinterWeeks: 6,
      price: 9.5 + i * 4,
      notes: i % 3 === 0 ? "Repotted last spring. Likes to dry out between waterings." : undefined,
    });
    if (!plant) continue;
    plants.push(plant);
    for (let k = 0; k < 3; k++) await insert("WateringEvent", { plantId: plant.id, wateredAt: daysAgo(2 + i + k * 7) });
    if (i % 2 === 0) await insert("FertilizationEvent", { plantId: plant.id, fertilizerId: fertilizer?.id, fertilizedAt: daysAgo(9 + i) });
  }
  return plants;
}

// "public": files under public/uploads and full URLs in the database (the first photo
// feature). "data": files under data/uploads and bare file names (everything since).
const PUBLIC_PHOTOS = process.env.PHOTO_MODE === "public";
const uploadDir = (subdir, id) => path.join(appDir, PUBLIC_PHOTOS ? "public" : "data", "uploads", subdir, String(id));
const photoUrls = (files, subdir, id) => (PUBLIC_PHOTOS ? Object.fromEntries(Object.entries(files).map(([k, v]) => [k, `/uploads/${subdir}/${id}/${v}`])) : files);

async function writeImage(svg, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const base = sharp(Buffer.from(svg));
  await base.clone().webp({ quality: 82 }).toFile(path.join(dir, `${name}.webp`));
  await base.clone().resize(400, 400).webp({ quality: 78 }).toFile(path.join(dir, `${name}_thumb.webp`));
  return { url: `${name}.webp`, thumbnailUrl: `${name}_thumb.webp`, originalUrl: `${name}.webp` };
}

/** Give every row of `owner` without a photo `count(id)` placeholder images. */
async function addPhotos({ owner, photos, fk, subdir, draw, count, takenAt }) {
  if (!(await hasTable(owner)) || !(await hasTable(photos))) return 0;
  const { rows } = await client.query(
    `SELECT o.* FROM "${owner}" o WHERE NOT EXISTS (SELECT 1 FROM "${photos}" p WHERE p."${fk}" = o.id) ORDER BY o.id`,
  );
  let added = 0;
  for (const row of rows) {
    for (let k = 0; k < count(row); k++) {
      const files = photoUrls(await writeImage(draw(row, k), uploadDir(subdir, row.id), `placeholder-${row.id}-${k}`), subdir, row.id);
      const inserted = await insert(photos, { [fk]: row.id, ...files, takenAt: takenAt ? daysAgo(3 + k * 45) : undefined });
      if (inserted) added++;
    }
  }
  return added;
}

const isEmpty = async (table) => (await hasTable(table)) && ((await one(`SELECT count(*)::int AS n FROM "${table}"`))?.n ?? 1) === 0;
const first = (table, where = "", params = []) => one(`SELECT * FROM "${table}" ${where} ORDER BY id LIMIT 1`, params);

/**
 * Fill every feature table the project's own seed leaves empty, so no page is captured in
 * its empty state. Only empty tables are touched; a table this era lacks is skipped.
 */
async function seedFeatures(user, friend, friendPlants) {
  const seeded = [];
  const fill = async (table, run) => {
    if (!(await isEmpty(table))) return;
    await run();
    if (!(await isEmpty(table))) seeded.push(table);
  };
  const { rows: plants } = await client.query(`SELECT * FROM "Plant" WHERE "userId" = $1 ORDER BY id`, [user.id]);
  const [p1, p2, p3] = plants;
  const fertilizer = await first("Fertilizer", `WHERE "userId" = $1`, [user.id]);
  const type = await first("GlobalPlantType");
  const type2 = type && (await first("GlobalPlantType", "WHERE id <> $1", [type.id]));
  const theirs = friendPlants[0];

  // People.
  const third = friend && ((await one(`SELECT * FROM "User" WHERE email = 'jonas@plants.local'`)) ??
    (await insert("User", { email: "jonas@plants.local", username: "jonas", displayName: "Jonas", passwordHash: user.passwordHash, status: "ACTIVE" })));
  for (const person of [user, friend, third].filter(Boolean)) {
    if (!(await columns("User")).has("avatarUrl") || person.avatarUrl) continue;
    const files = await writeImage(avatarSvg(person.id, (person.displayName ?? person.username ?? "?")[0].toUpperCase()), path.join(appDir, "data", "uploads", "users", String(person.id)), `placeholder-${person.id}`);
    await client.query(`UPDATE "User" SET "avatarUrl" = $1 WHERE id = $2`, [files.url, person.id]).catch(() => {});
  }
  await fill("Follow", async () => {
    if (!friend) return;
    await insert("Follow", { followerId: user.id, followingId: friend.id, status: "ACCEPTED", respondedAt: now, updatedAt: undefined });
    await insert("Follow", { followerId: friend.id, followingId: user.id, status: "ACCEPTED", respondedAt: now, updatedAt: undefined });
    if (third) await insert("Follow", { followerId: third.id, followingId: user.id, status: "PENDING", updatedAt: undefined });
  });
  await fill("Recipient", () => insert("Recipient", { userId: user.id, name: "Aunt Helga", createdAt: undefined, updatedAt: undefined }));

  // Care.
  await fill("RefillEvent", async () => { if (p1) await insert("RefillEvent", { plantId: p1.id, fertilizerId: fertilizer?.id, fertilizerPercent: 50, refilledAt: daysAgo(6), updatedAt: undefined }); });
  await fill("HydroEvent", async () => { if (p2) await insert("HydroEvent", { plantId: p2.id, recordedAt: daysAgo(4), kind: "topup", waterLevel: 80, notes: "Topped up", updatedAt: undefined }); });
  await fill("CareSnooze", async () => { if (p3) await insert("CareSnooze", { plantId: p3.id, careType: "watering", originalDueAt: daysAgo(1), snoozedUntil: daysAgo(-2), note: "Soil still damp", updatedAt: undefined }); });
  await fill("PottingEventLink", async () => {
    const potting = await first("PottingEvent");
    if (potting) await insert("PottingEventLink", { pottingEventId: potting.id, url: "https://example.com/terracotta-pot", label: "Terracotta pot, 14 cm", updatedAt: undefined });
  });
  await fill("PlantHealthEntry", async () => {
    if (p1) await insert("PlantHealthEntry", { plantId: p1.id, userId: user.id, source: "manual", kind: "issue", status: "active", text: "Brown tips on two lower leaves. Moved away from the radiator." });
    if (p2) await insert("PlantHealthEntry", { plantId: p2.id, userId: user.id, source: "manual", kind: "issue", status: "resolved", text: "Fungus gnats, treated with sticky traps.", resolvedAt: daysAgo(10), createdAt: daysAgo(30) });
  });
  await fill("PlantAnalysis", async () => {
    if (!p1) return;
    const analysis = await insert("PlantAnalysis", { plantId: p1.id, identifiedName: "Monstera", identifiedSpecies: "Monstera deliciosa", identifiedNotes: "Healthy growth, one leaf with light sunburn.", updatedAt: undefined });
    if (analysis) await insert("PlantAnalysisSuggestion", { analysisId: analysis.id, field: "sunRequirement", currentValue: "3", suggestedValue: "2", reason: "The leaf burn suggests slightly too much direct sun.", createdAt: undefined, updatedAt: undefined });
  });
  await fill("Vacation", async () => {
    const vacation = await insert("Vacation", { userId: user.id, mode: "sitter", startsOn: daysAgo(-5), endsOn: daysAgo(-16) });
    for (const plant of vacation ? plants.slice(0, 4) : []) await insert("VacationPlant", { vacationId: vacation.id, plantId: plant.id, createdAt: undefined, updatedAt: undefined });
  });

  // Sales: one offer coming in, one going out.
  await fill("PlantSale", async () => {
    if (!friend) return;
    const offer = async (from, to, plant, price, message) => {
      if (!plant) return;
      const sale = await insert("PlantSale", { plantId: plant.id, fromUserId: from.id, toUserId: to.id, kind: "SALE", status: "NEGOTIATING", currentPriceCents: price, currentOfferByUserId: from.id, message, expiresAt: daysAgo(-7) });
      if (sale) await insert("PlantSaleOffer", { saleId: sale.id, byUserId: from.id, kind: "CASH", status: "ACTIVE", priceCents: price, message, updatedAt: undefined });
    };
    await offer(friend, user, theirs, 1500, "Cutting rooted in water, ready to pot.");
    await offer(user, friend, p3, 2400, "Too big for my shelf, want it?");
  });

  // Wishlist.
  await fill("WishlistItem", () => insert("WishlistItem", { userId: user.id, name: "Philodendron Pink Princess", globalTypeId: type2?.id, updatedAt: undefined }));
  await fill("WishlistNote", async () => {
    const wish = await first("WishlistItem", `WHERE "userId" = $1`, [user.id]);
    if (wish) await insert("WishlistNote", { wishId: wish.id, text: "Seen at the garden centre for 35 €. Wait for spring." });
  });
  await fill("PlantTypeWatch", async () => { if (type) await insert("PlantTypeWatch", { userId: user.id, globalTypeId: type.id, updatedAt: undefined }); });

  // Community feed.
  if (friend && (await hasTable("Post")) && !(await first("Post", `WHERE "authorId" = $1`, [friend.id]))) {
    const post = await insert("Post", { authorId: friend.id, kind: "MANUAL", caption: "New leaf unfurled overnight!", publishedAt: daysAgo(1), createdAt: daysAgo(1), updatedAt: undefined });
    if (post) {
      seeded.push("Post");
      for (let k = 0; k < 2; k++) {
        const files = await writeImage(plantSvg(900 + k, k), path.join(appDir, "data", "uploads", "posts", String(post.id)), `placeholder-${post.id}-${k}`);
        await insert("PostPhoto", { postId: post.id, plantId: theirs?.id, ...files, updatedAt: undefined });
      }
      if (theirs) await insert("PostPlant", { postId: post.id, plantId: theirs.id, createdAt: undefined, updatedAt: undefined });
      const comment = await insert("Comment", { postId: post.id, authorId: user.id, body: "Looks great. How often do you water it?", updatedAt: undefined });
      await insert("Comment", { postId: post.id, authorId: friend.id, body: "About once a week in summer.", updatedAt: undefined });
      if (comment) await insert("CommentLike", { commentId: comment.id, userId: friend.id, updatedAt: undefined });
      await insert("Reaction", { postId: post.id, userId: user.id, emoji: "🌱", updatedAt: undefined });
      if (third) await insert("Report", { reporterId: third.id, postId: post.id, reason: "SPAM", note: "Posted three times today.", updatedAt: undefined });
    }
  }

  // Plant type catalogue.
  await fill("PlantTypeProposal", async () => {
    if (type) await insert("PlantTypeProposal", { typeId: type.id, authorId: friend?.id ?? user.id, origin: "user", reason: "Care guide says more humidity and full sun.", sources: ["https://example.com/care-guide"], changes: JSON.stringify({ humidity: { from: 1, to: 3 }, sunRequirement: { from: 2, to: 4 } }) });
  });
  await fill("PlantTypeChangeLog", async () => { if (type) await insert("PlantTypeChangeLog", { typeId: type.id, actorId: user.id, kind: "CREATED", updatedAt: undefined }); });
  await fill("PlantTypeDuplicateCandidate", async () => { if (type && type2) await insert("PlantTypeDuplicateCandidate", { typeAId: Math.min(type.id, type2.id), typeBId: Math.max(type.id, type2.id), score: 0.82, reason: "Same genus, similar names", updatedAt: undefined }); });

  await fill("GlobalPlantTypeImage", async () => {
    const { rows: types } = await client.query(`SELECT * FROM "GlobalPlantType" ORDER BY id`);
    const species = SPECIES_KEYWORDS;
    for (const t of types) {
      const name = [t.genus, t.species, t.cultivar].filter(Boolean).join(" ");
      const index = species.findIndex((re) => re.test(name));
      const files = await writeImage(plantSvg(500 + t.id, index >= 0 ? index : t.id), path.join(appDir, "data", "uploads", "plant-types", String(t.id)), `placeholder-${t.id}`);
      const prefixed = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, `plant-types/${t.id}/${v}`]));
      const image = await insert("GlobalPlantTypeImage", { typeId: t.id, ...prefixed, status: "APPROVED", uploadedById: user.id, shareConfirmed: true, reviewedById: user.id, reviewedAt: now, updatedAt: undefined });
      if (image && !t.coverImageId) await client.query(`UPDATE "GlobalPlantType" SET "coverImageId" = $1 WHERE id = $2`, [image.id, t.id]).catch(() => {});
    }
  });
  await fill("PlantTypeOtherName", async () => {
    const legacy = await first("PlantType");
    if (legacy) await insert("PlantTypeOtherName", { plantTypeId: legacy.id, name: "Swiss cheese plant", createdAt: undefined, updatedAt: undefined });
  });
  await fill("SoilComponent", async () => {
    const soil = await first("Soil", `WHERE "userId" = $1`, [user.id]);
    const parts = [["Pine bark", 3], ["Perlite", 2], ["Coco coir", 2]];
    for (const [name, share] of parts) {
      const component = await insert("SoilComponent", { userId: user.id, name, createdAt: undefined, updatedAt: undefined });
      if (component && soil) await insert("SoilMixItem", { soilId: soil.id, componentId: component.id, parts: share, createdAt: undefined, updatedAt: undefined });
    }
  });
  await fill("PlantDiagnosis", async () => {
    if (!p3) return;
    const diagnosis = await insert("PlantDiagnosis", {
      plantId: p3.id, userId: user.id, symptom: "yellowLeaves", status: "active",
      answers: JSON.stringify({ substrateWetDry: "soggy", wateringRhythm: "tooOften" }),
      causes: JSON.stringify([{ causeId: "overwatering", labelKey: "causes.overwatering.label", actionKind: "adjustWateringSchedule", score: 3 }]),
      selectedCauseId: "overwatering", selectedActionKind: "adjustWateringSchedule",
    });
    if (diagnosis) await insert("PlantHealthEntry", { plantId: p3.id, userId: user.id, source: "diagnosis", kind: "issue", status: "active", text: "Yellow leaves, likely overwatering.", diagnosisId: diagnosis.id });
  });

  // Account.
  await fill("ApiKey", () => insert("ApiKey", { userId: user.id, name: "Home automation", keyHash: "placeholder-hash-0001", prefix: "sprig_ab1234", updatedAt: undefined }));
  await fill("PasskeyCredential", () => insert("PasskeyCredential", { userId: user.id, credentialId: "placeholder-credential-0001", publicKey: "placeholder", transports: ["internal"], deviceType: "multiDevice", backedUp: true, lastUsedAt: daysAgo(2), updatedAt: undefined }));
  await fill("RegistrationInvite", () => insert("RegistrationInvite", { token: "uiprogress0invite0token0001", inviterId: user.id, expiresAt: daysAgo(-14), updatedAt: undefined }));
  return seeded;
}

const SPECIES_KEYWORDS = [/monstera|ficus|fig|philodendron|calathea|alocasia/i, /snake|sansevieria|dracaena|aloe|spider/i, /pilea|money|peperomia/i, /pothos|epipremnum|ivy|tradescantia|hoya|adansonii/i, /cact|cereus|succulent|euphorbia/i];

/** Plant id -> species index, from the type's name where one of the type tables has it. */
async function speciesByPlant() {
  const map = new Map();
  const sources = [
    `SELECT p.id, concat_ws(' ', t."commonName", t.genus, t.species) AS name FROM "Plant" p JOIN "PlantType" t ON t.id = p."plantTypeId"`,
    `SELECT p.id, concat_ws(' ', t.genus, t.species, t.cultivar) AS name FROM "Plant" p JOIN "GlobalPlantType" t ON t.id = p."globalPlantTypeId"`,
  ];
  for (const sql of sources) {
    try {
      const { rows } = await client.query(sql);
      for (const row of rows) {
        const index = SPECIES_KEYWORDS.findIndex((re) => re.test(row.name));
        if (index >= 0 && !map.has(row.id)) map.set(row.id, index);
      }
    } catch {
      // that type table (or column) does not exist in this era
    }
  }
  return map;
}

async function main() {
  await client.connect();
  // The earliest commits had no accounts: plants then belong to nobody.
  // The first schema had a User table but no way to create one: make the owner row here.
  const user =
    (await one(`SELECT * FROM "User" WHERE email = $1`, [EMAIL])) ??
    (await one(`SELECT * FROM "User" ORDER BY id LIMIT 1`)) ??
    (await insert("User", { email: EMAIL, username: "owner", name: "Owner", passwordHash: "-", password: "-", status: "ACTIVE" })) ??
    { id: undefined, anonymous: true };
  const report = { handSeeded: false, photos: {}, hints: {} };

  const existing = user.anonymous ? await one(`SELECT count(*)::int AS n FROM "Plant"`) : await one(`SELECT count(*)::int AS n FROM "Plant" WHERE "userId" = $1`, [user.id]);
  if ((existing?.n ?? 0) === 0) {
    console.log("no plants in this snapshot: writing the hand-made dataset");
    await seedCollection(user.id, 12);
    report.handSeeded = true;
  }

  // A second account that shares its collection with the test user.
  const friend = user.anonymous ? null :
    (await one(`SELECT * FROM "User" WHERE email = 'greta@plants.local'`)) ??
    (await insert("User", {
      email: "greta@plants.local",
      username: "greta",
      displayName: "Greta",
      passwordHash: user.passwordHash,
      status: "ACTIVE",
    }));
  let friendPlants = [];
  if (friend) {
    friendPlants = await seedCollection(friend.id, 4);
    await insert("CollectionShare", { ownerId: friend.id, sharedWithId: user.id });
    if (friendPlants[0] && (await hasTable("PlantTransfer"))) {
      await insert("PlantTransfer", {
        plantId: friendPlants[0].id,
        fromUserId: friend.id,
        toUserId: user.id,
        status: "PENDING",
        message: "This one is for you!",
        expiresAt: daysAgo(-7),
      });
    }
  }
  const token = "uiprogress0share0link0token0001";
  if ((await hasTable("ShareLink")) && !(await one(`SELECT 1 FROM "ShareLink" WHERE token = $1`, [token]))) {
    await insert("ShareLink", { token, ownerId: user.id });
  }

  const species = await speciesByPlant();
  report.photos.plants = await addPhotos({
    owner: "Plant", photos: "Photo", fk: "plantId", subdir: "plants", takenAt: true,
    count: (row) => 1 + (row.id % 3),
    draw: (row, k) => plantSvg(row.id * 7 + k, species.get(row.id) ?? row.plantTypeId ?? row.id),
  });
  report.photos.pots = await addPhotos({
    owner: "Pot", photos: "PotPhoto", fk: "potId", subdir: "pots",
    count: () => 1, draw: (row) => potSvg(row.id),
  });
  report.photos.locations = await addPhotos({
    owner: "Location", photos: "LocationPhoto", fk: "locationId", subdir: "locations",
    count: () => 1, draw: (row) => locationSvg(row.id),
  });

  report.features = user.anonymous ? [] : await seedFeatures(user, friend, friendPlants);

  // Dynamic routes nothing links to.
  const plant = user.anonymous ? await one(`SELECT id FROM "Plant" ORDER BY id LIMIT 1`) : await one(`SELECT id FROM "Plant" WHERE "userId" = $1 ORDER BY id LIMIT 1`, [user.id]);
  const sale = await one(`SELECT id FROM "PlantSale" WHERE "toUserId" = $1 ORDER BY id LIMIT 1`, [user.id]);
  const transfer = await one(`SELECT id FROM "PlantTransfer" ORDER BY id LIMIT 1`);
  const link = await one(`SELECT token FROM "ShareLink" WHERE "plantId" IS NULL ORDER BY id LIMIT 1`);
  const hints = report.hints;
  if (plant) hints["/plants/[id]"] = `/plants/${plant.id}`;
  if (friend && friendPlants.length) {
    hints["/shared/[ownerId]"] = `/shared/${friend.id}`;
    hints["/shared/[ownerId]/plants/[plantId]"] = `/shared/${friend.id}/plants/${friendPlants[0].id}`;
  }
  if (sale) hints["/sales/[id]/preview"] = `/sales/${sale.id}/preview`;
  if (transfer) hints["/transfers/[id]/preview"] = `/transfers/${transfer.id}/preview`;
  if (link && plant) {
    hints["/p/[token]"] = `/p/${link.token}`;
    hints["/p/[token]/plants/[plantId]"] = `/p/${link.token}/plants/${plant.id}`;
  }

  fs.writeFileSync(path.join(resultDir, "route-hints.json"), JSON.stringify(hints, null, 2));
  fs.writeFileSync(path.join(resultDir, "enrich.json"), JSON.stringify(report, null, 2));
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
