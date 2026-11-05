import { loadConfig, loadDotEnv } from '../config.ts';
import { connectDatabase } from './connect.ts';
import { seedDemoCatalog } from './seed.ts';

loadDotEnv();
const db = connectDatabase(loadConfig());
if ('error' in db) {
  console.error(db.error);
  process.exit(1);
}
try {
  const { company, packageIds } = await seedDemoCatalog(db.sql);
  console.log(`Seeded ${packageIds.length} DEMO package(s) for "${company.name}": ${packageIds.join(', ')}`);
} finally {
  await db.sql.close();
}
