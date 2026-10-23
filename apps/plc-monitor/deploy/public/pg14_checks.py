"""Bounded monitor maintenance checks shared by the rehearsal and live operator."""
import json
import subprocess
import time


def run(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError(args[0] + ' operation failed; output withheld to protect credentials/data')
    return result.stdout


def sql(container, query, database='monitor'):
    return run(['docker', 'exec', '-e', 'PGOPTIONS=-c timezone=UTC -c statement_timeout=60000 -c lock_timeout=5000',
                container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'monitor', '-d', database,
                '-Atq', '-c', query]).decode().strip()


def wait_version(container, expected):
    for _ in range(80):
        ready = subprocess.run(['docker', 'exec', container, 'pg_isready', '-U', 'monitor', '-d', 'monitor'], capture_output=True)
        if ready.returncode == 0:
            try:
                if int(sql(container, 'SHOW server_version_num')) == expected:
                    return
            except RuntimeError:
                pass
        time.sleep(0.25)
    raise RuntimeError('Database did not become ready at the expected minor version')


def manifest(container):
    tables = sql(container, "SELECT format('%I.%I',schemaname,tablename) FROM pg_tables "
                 "WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1").splitlines()
    if not tables:
        raise RuntimeError('No application tables found')
    result = {}
    # ponytail: whole-row hashes suit this small alpha DB; stream for large databases.
    for table in tables:
        query = "SELECT json_build_object('rows',count(*),'sha256',encode(sha256(convert_to(" \
                "coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text COLLATE \"C\"),''),'UTF8')),'hex')) " \
                'FROM ' + table + ' t'
        result[table] = json.loads(sql(container, query))
    return result


def repair_catalog_views(container):
    script = '/usr/local/share/postgresql/fix-CVE-2024-4317.sql'
    databases = sql(container, 'SELECT datname FROM pg_database ORDER BY 1', 'postgres').splitlines()
    if set(databases) != {'monitor', 'postgres', 'template0', 'template1'}:
        raise RuntimeError('Unexpected database list; review catalog repair scope')
    for database in databases:
        if database == 'template0':
            sql(container, 'ALTER DATABASE template0 WITH ALLOW_CONNECTIONS true', 'postgres')
        try:
            run(['docker', 'exec', '-e', 'PGOPTIONS=-c statement_timeout=60000 -c lock_timeout=5000',
                 container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                 '-U', 'monitor', '-d', database, '-f', script])
        finally:
            if database == 'template0':
                sql(container, 'ALTER DATABASE template0 WITH ALLOW_CONNECTIONS false', 'postgres')
