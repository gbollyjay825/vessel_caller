"""Storage — document tables in SQLite; newest-first via rowid DESC."""
import json
import sqlite3

from .seeds import SEED_CALLS, SEED_INSPECTIONS, SEED_INVOICES, SEED_SETTINGS, SEED_ORG, normalize_org


def connect(db_path):
    con = sqlite3.connect(db_path, timeout=10)
    con.execute('PRAGMA journal_mode=WAL')
    return con


def init_db(db_path):
    con = connect(db_path)
    con.execute("CREATE TABLE IF NOT EXISTS docs (col TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (col, id))")
    con.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
    if con.execute("SELECT v FROM meta WHERE k='rev'").fetchone() is None:
        seed(con)
    con.commit()
    con.close()


def seed(con):
    con.execute("DELETE FROM docs")
    con.execute("DELETE FROM meta")
    # insert in reverse so rowid DESC == original seed order (newest-first UX)
    for call in reversed(SEED_CALLS):
        con.execute("INSERT INTO docs (col, id, data) VALUES ('calls', ?, ?)", (call['id'], json.dumps(call)))
    for insp in reversed(SEED_INSPECTIONS):
        con.execute("INSERT INTO docs (col, id, data) VALUES ('inspections', ?, ?)", (insp['id'], json.dumps(insp)))
    for inv in reversed(SEED_INVOICES):
        con.execute("INSERT INTO docs (col, id, data) VALUES ('invoices', ?, ?)", (inv['id'], json.dumps(inv)))
    con.execute("INSERT INTO meta (k, v) VALUES ('settings', ?)", (json.dumps(SEED_SETTINGS),))
    con.execute("INSERT INTO meta (k, v) VALUES ('org', ?)", (json.dumps(SEED_ORG),))
    con.execute("INSERT INTO meta (k, v) VALUES ('rev', '1')")


def get_rev(con):
    return int(con.execute("SELECT v FROM meta WHERE k='rev'").fetchone()[0])


def bump_rev(con):
    rev = get_rev(con) + 1
    con.execute("UPDATE meta SET v=? WHERE k='rev'", (str(rev),))
    return rev


def col_docs(con, col):
    rows = con.execute("SELECT data FROM docs WHERE col=? ORDER BY rowid DESC", (col,)).fetchall()
    return [json.loads(r[0]) for r in rows]


def get_doc(con, col, doc_id):
    row = con.execute("SELECT data FROM docs WHERE col=? AND id=?", (col, doc_id)).fetchone()
    return json.loads(row[0]) if row else None


def put_doc(con, col, doc):
    con.execute("INSERT OR REPLACE INTO docs (col, id, data) VALUES (?, ?, ?)", (col, doc['id'], json.dumps(doc)))


def get_settings(con):
    return json.loads(con.execute("SELECT v FROM meta WHERE k='settings'").fetchone()[0])


def full_state(con):
    org_row = con.execute("SELECT v FROM meta WHERE k='org'").fetchone()
    return {
        'rev': get_rev(con),
        'calls': col_docs(con, 'calls'),
        'inspections': col_docs(con, 'inspections'),
        'invoices': col_docs(con, 'invoices'),
        'settings': get_settings(con),
        'org': normalize_org(json.loads(org_row[0]) if org_row else SEED_ORG),
    }
