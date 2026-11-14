// Define a schema, insert, query and watch. Run against a dev store (ce-db-dev-store from ce-db-rs):
//   ce-db-dev-store --grant dev='state.quickstart.*' &
//   CE_DB_STORE=127.0.0.1:7811 CE_DB_CAP=dev npm run example
// Without CE_DB_STORE it opens this machine's state.store by name with ~/.config/ce-state/quickstart.cap.
import { open, defineRecord, field } from '@ce-net/db';

const Task = defineRecord({ app: 'quickstart', collection: 'tasks', version: 1,
  fields: { id: field.id().key(), title: field.string().max(200), done: field.bool().index() } });

const db = await open('quickstart');
const tasks = Task.of(db);                                   // registers the schema when it is missing
const live = await tasks.byDone(false).watch();              // every open task now, 'synced', then changes
await tasks.insert({ title: 'buy milk', done: false });      // the ULID key is made when left out
console.log('open tasks:', await tasks.byDone(false).count());
for (let c; (c = await live.next(500)); ) console.log(c);     // { kind: 'added', doc } | changed | removed | synced
db.close();
