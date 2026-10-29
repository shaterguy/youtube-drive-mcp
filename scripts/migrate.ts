import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL_REQUIRED');
const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
try{await pool.query('BEGIN');await pool.query('SELECT pg_advisory_xact_lock(89177231)');await pool.query('SELECT pg_advisory_xact_lock(89177232)');const schema=(await pool.query(`SELECT to_regclass('public.user') AS users`)).rows[0];if(!schema.users)await pool.query(await readFile(new URL('../sql/auth.sql',import.meta.url),'utf8'));await pool.query(await readFile(new URL('../sql/app.sql',import.meta.url),'utf8'));await pool.query(await readFile(new URL('../sql/grants.sql',import.meta.url),'utf8'));await pool.query('COMMIT');process.stdout.write('schema ready\n');}catch{await pool.query('ROLLBACK');process.stderr.write('MIGRATION_FAILED\n');process.exitCode=1;}finally{await pool.end();}
