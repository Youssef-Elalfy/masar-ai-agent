import { loadConfig, loadDotEnv } from '../config.ts';
import { connectDatabase } from '../db/connect.ts';
import { ConsentStore } from '../memory/consent-store.ts';
import { PiiCipher } from '../security/pii-crypto.ts';
import { CrmService } from './crm-service.ts';

// Staff view of the DEMO CRM (read-only). Contact fields are masked unless --reveal is passed.
// Usage: npm run crm:list [-- --reveal]
loadDotEnv();
const config = loadConfig();
if (!config.piiEncryptionKey) {
  console.error('PII_ENCRYPTION_KEY is not set; encrypted contact fields cannot be read.');
  process.exit(1);
}
const db = connectDatabase(config);
if ('error' in db) {
  console.error(db.error);
  process.exit(1);
}
try {
  const crm = new CrmService(db.sql, new ConsentStore(db.sql), new PiiCipher(config.piiEncryptionKey));
  const rows = await crm.staffList(process.argv.includes('--reveal'));
  if (rows.length === 0) console.log('No leads in the demo CRM.');
  for (const r of rows) console.log(JSON.stringify(r));
} finally {
  await db.sql.close();
}
